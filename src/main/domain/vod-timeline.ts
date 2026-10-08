import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateVodPlaybackRequest } from './vod-playback-service';

export interface VodChapter {
    id: string;
    start: number;
    end: number;
    name: string;
    game_id: string;
    image: string | null;
    precision: 'source';
}

export interface VodTitleEvent {
    id: string;
    at: number;
    until: number;
    title: string;
    kind: 'observed' | 'changed';
    precision: 'observed';
    priority: number;
}

export interface VodTimeline {
    vodId: string;
    title: string;
    started: number;
    duration: number;
    login: string;
    chapters: VodChapter[];
    titleHistory: VodTitleEvent[];
    chaptersStatus: 'available' | 'empty' | 'unavailable';
    titlesStatus: 'local' | 'unavailable';
}

export const VOD_TIMELINE_QUERY = `query($id:ID!,$after:Cursor){video(id:$id){id title createdAt lengthSeconds owner{login} moments(momentRequestType:VIDEO_CHAPTER_MARKERS,first:100,after:$after){edges{cursor node{id type description positionMilliseconds durationMilliseconds details{... on GameChangeMomentDetails{game{id displayName boxArtURL(width:144,height:192)}}}}} pageInfo{hasNextPage}}}}`;

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, maximum = 4000): string {
    return typeof value === 'string' ? value.slice(0, maximum) : '';
}

export function normalizeVodChapters(edges: unknown[], duration: number): VodChapter[] {
    const unique = new Map<number, VodChapter>();
    for (const edge of edges) {
        const node = record(record(edge)?.node);
        if (!node || node.type !== 'GAME_CHANGE') continue;
        const startMs = node.positionMilliseconds, lengthMs = node.durationMilliseconds;
        if (typeof startMs !== 'number' || typeof lengthMs !== 'number' || !Number.isFinite(startMs)
            || !Number.isFinite(lengthMs) || startMs < 0 || lengthMs <= 0 || startMs >= duration * 1000) continue;
        const game = record(record(node.details)?.game);
        const name = text(game?.displayName || node.description, 300);
        if (!name) continue;
        let image: string | null = null;
        try {
            const url = new URL(text(game?.boxArtURL, 2000));
            if (url.protocol === 'https:' && url.hostname === 'static-cdn.jtvnw.net' && !url.username && !url.password && !url.port) image = url.href;
        } catch {}
        const start = startMs / 1000;
        unique.set(start, { id: `chapter-${startMs}`, start, end: Math.min(duration, start + lengthMs / 1000),
            name, game_id: text(game?.id, 80), image, precision: 'source' });
    }
    const chapters = [...unique.values()].sort((a, b) => a.start - b.start);
    return chapters.map((chapter, index) => ({ ...chapter, end: Math.min(chapter.end, chapters[index + 1]?.start ?? duration) }));
}

export function parseLocalVodTitles(source: string, login: string, started: number, duration: number): VodTitleEvent[] {
    const rows: Record<string, unknown>[] = [];
    for (const line of source.split('\n')) {
        if (!line.trim() || line.length > 65536) continue;
        try { const row = record(JSON.parse(line)); if (row) rows.push(row); } catch {}
    }
    const first = rows.find(row => row.type === 'recording_start');
    const last = [...rows].reverse().find(row => row.type === 'recording_end');
    if (!first || text(first.streamer).toLowerCase() !== login) return [];
    const recordingStart = Date.parse(text(first.t)), recordingEnd = Date.parse(text(last?.t));
    const end = Math.min(started + duration * 1000, Number.isFinite(recordingEnd) ? recordingEnd : rows.reduce((latest, row) => Math.max(latest, Date.parse(text(row.t)) || 0), 0));
    if (!Number.isFinite(recordingStart) || end <= started || recordingStart >= started + duration * 1000) return [];
    const changes = rows.filter(row => row.type === 'recording_start' || row.type === 'title_change').map(row => ({
        at: Date.parse(text(row.t)), title: text(row.type === 'recording_start' ? row.title : row.to),
        kind: row.type === 'title_change' ? 'changed' as const : 'observed' as const,
    })).filter(row => Number.isFinite(row.at) && row.at >= recordingStart && row.at < end && row.title).sort((a, b) => a.at - b.at);
    return changes.map((row, index) => ({ ...row, until: Math.min(end, changes[index + 1]?.at ?? end),
        id: `title-${createHash('sha256').update(`${row.at}:${row.title}`).digest('hex').slice(0, 24)}`,
        precision: 'observed' as const, priority: 2,
    })).filter(row => row.until > started && row.until > row.at);
}

export async function readLocalVodTitles(directory: string, timeline: VodTimeline, signal: AbortSignal): Promise<VodTitleEvent[]> {
    if (!/^[a-z0-9_]{1,25}$/.test(timeline.login)) return [];
    try {
        const root = await fs.realpath(directory);
        const folder = await fs.realpath(path.join(root, timeline.login, 'live'));
        const relative = path.relative(root, folder);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return [];
        const files = (await fs.readdir(folder, { withFileTypes: true })).filter(file => file.isFile() && file.name.endsWith('.events.jsonl'))
            .map(file => file.name).sort().reverse().slice(0, 100);
        const titles = new Map<string, VodTitleEvent>();
        let bytes = 0;
        for (const file of files) {
            signal.throwIfAborted();
            const filePath = path.join(folder, file);
            const resolved = await fs.realpath(filePath);
            if (path.dirname(resolved) !== folder) continue;
            const stat = await fs.stat(resolved);
            if (stat.size > 4 * 1024 * 1024 || bytes + stat.size > 16 * 1024 * 1024) continue;
            bytes += stat.size;
            const source = await fs.readFile(resolved, { encoding: 'utf8', signal });
            for (const title of parseLocalVodTitles(source, timeline.login, timeline.started, timeline.duration)) {
                const previous = titles.get(title.id);
                if (!previous || title.until > previous.until) titles.set(title.id, title);
            }
        }
        return [...titles.values()].sort((a, b) => a.at - b.at);
    } catch { return []; }
}

export class VodTimelineService {
    private current: { id: string; controller: AbortController } | null = null;

    constructor(private readonly fetchMetadata: typeof fetch = fetch) {}

    close(id?: string): void {
        if (!this.current || (id !== undefined && id !== this.current.id)) return;
        this.current.controller.abort();
        this.current = null;
    }

    async load(value: unknown, downloadDirectory: string): Promise<VodTimeline | null> {
        const request = validateVodPlaybackRequest(value);
        this.close();
        const controller = new AbortController();
        this.current = { id: request.id, controller };
        const signal = controller.signal;
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const vodId = new URL(request.url).pathname.split('/').at(-1)!;
            const edges: unknown[] = [], cursors = new Set<string>();
            let after: string | null = null, result: VodTimeline | null = null;
            for (let page = 0; page < 20; page++) {
                const response = await this.fetchMetadata('https://gql.twitch.tv/gql', {
                    method: 'POST', redirect: 'error', signal,
                    headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: VOD_TIMELINE_QUERY, variables: { id: vodId, after } }),
                });
                if (!response.ok) throw new Error('VOD metadata unavailable');
                const reader = response.body?.getReader();
                if (!reader) throw new Error('Empty VOD metadata');
                const chunks: Uint8Array[] = [];
                let bytes = 0;
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('VOD metadata too large'); }
                    chunks.push(chunk.value);
                }
                const data = record(record(JSON.parse(Buffer.concat(chunks).toString('utf8')))?.data);
                const video = record(data?.video);
                if (!video || video.id !== vodId) return null;
                const duration = video.lengthSeconds, started = Date.parse(text(video.createdAt));
                if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 7 * 86400 || !Number.isFinite(started)) return null;
                if (result && (result.started !== started || result.login !== text(record(video.owner)?.login).toLowerCase())) return null;
                const moments = record(video.moments), batch = moments?.edges;
                result = { vodId, title: text(video.title), started, duration,
                    login: text(record(video.owner)?.login).toLowerCase(), chapters: [], titleHistory: [],
                    chaptersStatus: Array.isArray(batch) ? 'empty' : 'unavailable', titlesStatus: 'unavailable' };
                if (!Array.isArray(batch)) break;
                edges.push(...batch);
                const more = record(moments?.pageInfo)?.hasNextPage === true;
                if (!more) break;
                const cursor = text(record(batch.at(-1))?.cursor, 2000);
                if (!cursor || cursors.has(cursor) || page === 19) throw new Error('Incomplete VOD chapters');
                cursors.add(cursor);
                after = cursor;
            }
            if (!result) return null;
            result.chapters = normalizeVodChapters(edges, result.duration);
            if (result.chapters.length) result.chaptersStatus = 'available';
            result.titleHistory = await readLocalVodTitles(downloadDirectory, result, signal);
            if (result.titleHistory.length) result.titlesStatus = 'local';
            signal.throwIfAborted();
            return result;
        } finally {
            clearTimeout(timeout);
            controller.abort();
            if (this.current?.controller === controller) this.current = null;
        }
    }
}

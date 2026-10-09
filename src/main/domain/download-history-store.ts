import { statSync } from 'node:fs';
import type { DbHandle } from '../infra/db';
import { parseTwitchClipId } from '../twitch/clip-url';
import { isValidPersistedQueueId } from './queue-runtime';

export interface LifetimeDownloadStats {
    available: boolean;
    trackedSince: string | null;
    totalDownloads: number;
    completedJobs: number;
    vodDownloads: number;
    clipDownloads: number;
    liveRecordings: number;
    outputFiles: number;
    totalBytes: number;
    recoveredDownloads: number;
    unknownDateDownloads: number;
    dailyActivity: Array<{ date: string; count: number; bytes: number }>;
}

interface DownloadCompletion {
    eventKey: string;
    kind: 'vod' | 'clip' | 'live';
    sourceIds: string[];
    outputFiles: number;
    totalBytes: number;
    completedAt: string | null;
    recovered: boolean;
}

export interface DownloadHistoryStore {
    recordQueueItem(item: unknown): boolean;
    recordClip(input: { attemptId: string; clipId: string; filename: string; completedAt?: string }): boolean;
    recoverCompletedQueue(): number;
    summarize(now?: Date): LifetimeDownloadStats;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizedTimestamp(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 40) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function nonnegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function vodSourceId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (!['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname.toLowerCase())) return null;
        return /^\/videos\/(\d+)\/?$/.exec(url.pathname)?.[1]?.replace(/^0+(?=\d)/, '') ?? null;
    } catch { return null; }
}

function mediaOutputFiles(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && /\.(mp4|mkv|ts|m4v|webm|mov)$/i.test(entry)))] : [];
}

export function downloadOutputBytes(files: readonly string[]): number {
    let bytes = 0;
    for (const filename of mediaOutputFiles(files)) {
        try {
            const stat = statSync(filename);
            if (stat.isFile()) bytes += stat.size;
        } catch { }
    }
    return Math.min(Number.MAX_SAFE_INTEGER, bytes);
}

function queueCompletion(input: unknown): DownloadCompletion | null {
    const item = objectRecord(input);
    if (!item || item.status !== 'completed' || typeof item.id !== 'string' || !item.id) return null;
    let kind: DownloadCompletion['kind'] = 'vod';
    let sourceIds: string[];
    if (item.isLive === true) {
        kind = 'live';
        sourceIds = [item.id];
    } else {
        const merge = objectRecord(item.mergeGroup);
        const sources = merge && Array.isArray(merge.items) ? merge.items.map(value => objectRecord(value)?.url) : [item.url];
        sourceIds = [...new Set(sources.map(vodSourceId).filter((value): value is string => value !== null))];
        if (sourceIds.length === 0) {
            const clipId = typeof item.url === 'string' ? parseTwitchClipId(item.url) : null;
            if (!clipId) return null;
            kind = 'clip';
            sourceIds = [clipId];
        }
    }
    const files = mediaOutputFiles(item.outputFiles);
    const completedAt = normalizedTimestamp(item.completedAt);
    return {
        eventKey: 'queue:' + item.id,
        kind,
        sourceIds,
        outputFiles: files.length,
        totalBytes: nonnegativeInteger(item.outputBytes) ?? downloadOutputBytes(files),
        completedAt,
        recovered: item.completionRecorded !== true,
    };
}

function localDateKey(value: Date): string {
    return String(value.getFullYear()).padStart(4, '0') + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
}

export function emptyLifetimeDownloadStats(): LifetimeDownloadStats {
    return {
        available: false,
        trackedSince: null,
        totalDownloads: 0,
        completedJobs: 0,
        vodDownloads: 0,
        clipDownloads: 0,
        liveRecordings: 0,
        outputFiles: 0,
        totalBytes: 0,
        recoveredDownloads: 0,
        unknownDateDownloads: 0,
        dailyActivity: [],
    };
}

export function createDownloadHistoryStore(db: DbHandle): DownloadHistoryStore {
    const record = (completion: DownloadCompletion): boolean => {
        db.run(
            'INSERT OR IGNORE INTO download_history(event_key, kind, source_count, source_ids_json, output_files, total_bytes, completed_at, recovered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [completion.eventKey, completion.kind, completion.sourceIds.length, JSON.stringify(completion.sourceIds), completion.outputFiles, completion.totalBytes, completion.completedAt, completion.recovered ? 1 : 0],
        );
        return (db.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0) > 0;
    };
    const recordQueueItem = (item: unknown): boolean => {
        const candidate = objectRecord(item);
        if (candidate?.status !== 'completed') return false;
        if (typeof candidate?.id === 'string' && db.get('SELECT event_key FROM download_history WHERE event_key = ?', ['queue:' + candidate.id])) return false;
        const completion = queueCompletion(item);
        return completion ? record(completion) : false;
    };
    return {
        recordQueueItem,
        recordClip(input) {
            if (!input.attemptId || !input.clipId) return false;
            return record({
                eventKey: 'clip:' + input.attemptId,
                kind: 'clip',
                sourceIds: [input.clipId],
                outputFiles: 1,
                totalBytes: downloadOutputBytes([input.filename]),
                completedAt: normalizedTimestamp(input.completedAt) ?? new Date().toISOString(),
                recovered: false,
            });
        },
        recoverCompletedQueue() {
            return db.transaction(() => {
                let recovered = 0;
                for (const row of db.all<{ payload_json: string }>("SELECT payload_json FROM queue_items WHERE status = 'completed'")) {
                    let parsed: unknown;
                    try { parsed = JSON.parse(row.payload_json); } catch { continue; }
                    if (!isValidPersistedQueueId(objectRecord(parsed)?.id)) continue;
                    if (recordQueueItem(parsed)) recovered++;
                }
                return recovered;
            });
        },
        summarize(now = new Date()) {
            const totals = db.get<{
                totalDownloads: number; completedJobs: number; vodDownloads: number; clipDownloads: number; liveRecordings: number;
                outputFiles: number; totalBytes: number; recoveredDownloads: number; unknownDateDownloads: number;
            }>(`SELECT COALESCE(SUM(source_count), 0) AS totalDownloads, COUNT(*) AS completedJobs,
                COALESCE(SUM(CASE WHEN kind = 'vod' THEN source_count ELSE 0 END), 0) AS vodDownloads,
                COALESCE(SUM(CASE WHEN kind = 'clip' THEN source_count ELSE 0 END), 0) AS clipDownloads,
                COALESCE(SUM(CASE WHEN kind = 'live' THEN source_count ELSE 0 END), 0) AS liveRecordings,
                COALESCE(SUM(output_files), 0) AS outputFiles, COALESCE(SUM(total_bytes), 0) AS totalBytes,
                COALESCE(SUM(CASE WHEN recovered = 1 THEN source_count ELSE 0 END), 0) AS recoveredDownloads,
                COALESCE(SUM(CASE WHEN completed_at IS NULL THEN source_count ELSE 0 END), 0) AS unknownDateDownloads
                FROM download_history`)!;
            const start = new Date(now);
            start.setHours(0, 0, 0, 0);
            start.setDate(start.getDate() - 29);
            const end = new Date(now);
            end.setHours(24, 0, 0, 0);
            const activity = new Map<string, { date: string; count: number; bytes: number }>();
            for (const row of db.all<{ completed_at: string; source_count: number; total_bytes: number }>(
                'SELECT completed_at, source_count, total_bytes FROM download_history WHERE completed_at >= ? AND completed_at < ?',
                [start.toISOString(), end.toISOString()],
            )) {
                const date = localDateKey(new Date(row.completed_at));
                const day = activity.get(date) ?? { date, count: 0, bytes: 0 };
                day.count += row.source_count;
                day.bytes += row.total_bytes;
                activity.set(date, day);
            }
            const dailyActivity: LifetimeDownloadStats['dailyActivity'] = [];
            for (let offset = 0; offset < 30; offset++) {
                const day = new Date(start);
                day.setDate(day.getDate() + offset);
                const date = localDateKey(day);
                dailyActivity.push(activity.get(date) ?? { date, count: 0, bytes: 0 });
            }
            return {
                ...totals,
                available: true,
                trackedSince: db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'download_history_started_at'")?.value ?? null,
                dailyActivity,
            };
        },
    };
}

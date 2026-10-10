import axios from 'axios';
import { runMediaProcess } from './media-process';

export interface VodQualityOption { id: string; label: string }
export const TWITCH_VIDEO_CODEC_ARGS = ['--twitch-supported-codecs', 'h264,h265,av1'];

export function normalizeVodQuality(value: unknown): string | null {
    if (value === undefined || value === 'source' || value === 'best') return 'source';
    if (typeof value !== 'string' || value.length > 24) return null;
    const variants = value.split('_alt');
    if (variants.length > 2 || (variants.length === 2 && !/^[0-9]{0,2}$/.test(variants[1]))) return null;
    const parts = variants[0].split('p');
    if (parts.length !== 2 || !/^[1-9][0-9]{2,3}$/.test(parts[0]) || (parts[1] !== '' && !/^[1-9][0-9]{0,2}$/.test(parts[1]))) return null;
    return value;
}

export function vodQualityStreamArg(value?: string): string {
    const quality = normalizeVodQuality(value);
    if (!quality) throw new Error('Invalid VOD quality');
    return quality === 'source' ? 'source,best' : quality;
}

interface VodStream { url?: unknown; master?: unknown }

function playlistVariants(playlist: string, master: string): Map<string, { codec?: string; fps?: number }> {
    const variants = new Map<string, { codec?: string; fps?: number }>();
    let attributes: Record<string, string> | null = null;
    for (const raw of playlist.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            attributes = Object.fromEntries(Array.from(line.slice(18).matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g), match => [match[1], match[2] ?? match[3]]));
        } else if (line && !line.startsWith('#') && attributes) {
            const codecs = (attributes.CODECS || '').toLowerCase();
            const codec = /(?:^|,)(?:avc1|avc3)/.test(codecs) ? 'H.264' : /(?:^|,)(?:hvc1|hev1)/.test(codecs) ? 'H.265 / HEVC' : /(?:^|,)av01/.test(codecs) ? 'AV1' : undefined;
            const rate = Number(attributes['FRAME-RATE']);
            const fps = Number.isFinite(rate) && rate > 0 && rate <= 1000 ? rate : undefined;
            try { variants.set(new URL(line, master).href, { codec, fps }); } catch {}
            attributes = null;
        }
    }
    return variants;
}

export function parseVodQualities(json: string, playlist = '', master = ''): VodQualityOption[] {
    const data = JSON.parse(json) as { streams?: Record<string, VodStream> };
    if (!data?.streams || typeof data.streams !== 'object') throw new Error('Missing VOD streams');
    const streams = data.streams;
    const keys = Object.keys(streams).filter(key => key !== 'source' && key !== 'best' && normalizeVodQuality(key) === key && typeof streams[key]?.url === 'string');
    const rank = (key: string): number => { const parts = key.split('_')[0].split('p'); return Number(parts[0]) * 1000 + Number(parts[1] || 0); };
    keys.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
    if (!keys.length) throw new Error('No VOD video streams');
    const variants = playlistVariants(playlist, master);
    const label = (id: string): string => {
        const [base, alternative] = id.split('_alt');
        const [height, rate] = base.split('p');
        const metadata = variants.get(String(streams[id].url));
        const fps = metadata?.fps || Number(rate);
        const displayedFps = fps && Math.abs(fps - Math.round(fps)) < 0.01 ? Math.round(fps) : fps;
        return [height + 'p', displayedFps ? displayedFps + ' fps' : '', metadata?.codec || '', alternative !== undefined && !metadata?.codec ? '#' + (Number(alternative || 0) + 2) : ''].filter(Boolean).join(' · ');
    };
    const bestUrl = streams.source?.url || streams.best?.url;
    const best = keys.find(key => streams[key].url === bestUrl) || keys[0];
    return [{ id: 'source', label: 'Source · ' + label(best) }, ...keys.map(id => ({ id, label: label(id) }))];
}

async function loadVodPlaylist(json: string, signal: AbortSignal): Promise<{ playlist: string; master: string }> {
    const data = JSON.parse(json) as { streams?: Record<string, VodStream> };
    const stream = data.streams?.best || Object.values(data.streams || {}).find(value => typeof value?.master === 'string');
    if (typeof stream?.master !== 'string') return { playlist: '', master: '' };
    const url = new URL(stream.master);
    if (url.protocol !== 'https:' || url.hostname !== 'usher.ttvnw.net' || url.port || url.username || url.password) return { playlist: '', master: '' };
    const response = await axios.get<string>(url.href, { signal, timeout: 10000, maxRedirects: 0, maxContentLength: 1048576, responseType: 'text', transformResponse: value => value });
    return { playlist: response.data, master: url.href };
}

export class VodQualityService {
    private active: { id: string; controller: AbortController } | null = null;
    private readonly cache = new Map<string, { expires: number; qualities: VodQualityOption[] }>();

    cancel(id: unknown): void {
        if (this.active && this.active.id === id) { this.active.controller.abort(); this.active = null; }
    }

    async load(request: unknown, tools: { prepare: () => Promise<boolean>; streamlink: () => Promise<{ command: string; prefixArgs: string[] }> }): Promise<VodQualityOption[]> {
        const input = request as { id?: unknown; url?: unknown } | null;
        if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id) || typeof input.url !== 'string') throw new Error('Invalid VOD request');
        const url = new URL(input.url);
        if (url.protocol !== 'https:' || !['twitch.tv', 'www.twitch.tv'].includes(url.hostname) || url.username || url.password || url.port || !/^\/videos\/\d+\/?$/.test(url.pathname)) throw new Error('Invalid VOD URL');
        this.active?.controller.abort();
        this.active = null;
        const key = 'https://www.twitch.tv' + url.pathname.replace(/\/$/, '');
        for (const [cachedKey, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(cachedKey);
        const cached = this.cache.get(key);
        if (cached) return structuredClone(cached.qualities);
        const active = { id: input.id, controller: new AbortController() };
        this.active = active;
        try {
            if (!await tools.prepare() || active.controller.signal.aborted) throw new Error('VOD quality request cancelled');
            const tool = await tools.streamlink();
            const output = await runMediaProcess(tool.command, [...tool.prefixArgs, '--loglevel', 'none', ...TWITCH_VIDEO_CODEC_ARGS, '--json', 'https://www.twitch.tv' + url.pathname], { signal: active.controller.signal, timeoutMs: 45000 });
            let metadata = { playlist: '', master: '' };
            try { metadata = await loadVodPlaylist(output, active.controller.signal); } catch { if (active.controller.signal.aborted) throw new Error('VOD quality request cancelled'); }
            if (active.controller.signal.aborted) throw new Error('VOD quality request cancelled');
            const qualities = parseVodQualities(output, metadata.playlist, metadata.master);
            if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(key, { expires: Date.now() + 120000, qualities: structuredClone(qualities) });
            return qualities;
        } finally { if (this.active === active) this.active = null; }
    }
}

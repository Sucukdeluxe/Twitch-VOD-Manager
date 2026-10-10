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

export function parseVodQualities(json: string): VodQualityOption[] {
    const data = JSON.parse(json) as { streams?: Record<string, { url?: unknown }> };
    if (!data?.streams || typeof data.streams !== 'object') throw new Error('Missing VOD streams');
    const streams = data.streams;
    const keys = Object.keys(streams).filter(key => key !== 'source' && key !== 'best' && normalizeVodQuality(key) === key && typeof streams[key]?.url === 'string');
    const rank = (key: string): number => { const parts = key.split('_')[0].split('p'); return Number(parts[0]) * 1000 + Number(parts[1] || 0); };
    keys.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
    if (!keys.length) throw new Error('No VOD video streams');
    const bestUrl = streams.source?.url || streams.best?.url;
    const best = keys.find(key => streams[key].url === bestUrl) || keys[0];
    return [{ id: 'source', label: 'Source · ' + best.replace(/_alt(\d+)/, ' (Alt. $1)') }, ...keys.map(id => ({ id, label: id.replace(/_alt(\d+)/, ' (Alt. $1)') }))];
}

export class VodQualityService {
    private active: { id: string; controller: AbortController } | null = null;

    cancel(id: unknown): void {
        if (this.active && this.active.id === id) { this.active.controller.abort(); this.active = null; }
    }

    async load(request: unknown, tools: { prepare: () => Promise<boolean>; streamlink: () => Promise<{ command: string; prefixArgs: string[] }> }): Promise<VodQualityOption[]> {
        const input = request as { id?: unknown; url?: unknown } | null;
        if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id) || typeof input.url !== 'string') throw new Error('Invalid VOD request');
        const url = new URL(input.url);
        if (url.protocol !== 'https:' || !['twitch.tv', 'www.twitch.tv'].includes(url.hostname) || url.username || url.password || url.port || !/^\/videos\/\d+\/?$/.test(url.pathname)) throw new Error('Invalid VOD URL');
        this.active?.controller.abort();
        const active = { id: input.id, controller: new AbortController() };
        this.active = active;
        try {
            if (!await tools.prepare() || active.controller.signal.aborted) throw new Error('VOD quality request cancelled');
            const tool = await tools.streamlink();
            const output = await runMediaProcess(tool.command, [...tool.prefixArgs, '--loglevel', 'none', ...TWITCH_VIDEO_CODEC_ARGS, '--json', 'https://www.twitch.tv' + url.pathname], { signal: active.controller.signal, timeoutMs: 45000 });
            return parseVodQualities(output);
        } finally { if (this.active === active) this.active = null; }
    }
}

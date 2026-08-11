import type { CustomClip, QueueItem } from '../../types';

export type RendererQueueInput = Pick<QueueItem, 'url' | 'title' | 'date' | 'streamer' | 'duration_str'> & { customClip?: CustomClip };

function normalizedString(value: unknown, maximumLength: number): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized && normalized.length <= maximumLength ? normalized : null;
}

function normalizeCustomClip(value: unknown): CustomClip | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (!Number.isFinite(raw.startSec) || Number(raw.startSec) < 0) return null;
    if (!Number.isFinite(raw.durationSec) || Number(raw.durationSec) <= 0 || Number(raw.durationSec) > 24 * 60 * 60) return null;
    if (!Number.isInteger(raw.startPart) || Number(raw.startPart) < 1 || Number(raw.startPart) > 100000) return null;
    if (!['simple', 'timestamp', 'template', 'parts'].includes(String(raw.filenameFormat))) return null;
    const filenameFormat = raw.filenameFormat as CustomClip['filenameFormat'];
    const filenameTemplate = raw.filenameTemplate === undefined
        ? undefined
        : normalizedString(raw.filenameTemplate, 500);
    if (raw.filenameTemplate !== undefined && !filenameTemplate) return null;
    if (filenameFormat === 'template' && !filenameTemplate) return null;
    return {
        startSec: Number(raw.startSec),
        durationSec: Number(raw.durationSec),
        startPart: Number(raw.startPart),
        filenameFormat,
        ...(filenameTemplate ? { filenameTemplate } : {}),
    };
}

export function normalizeRendererQueueInput(value: unknown): RendererQueueInput | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const url = normalizedString(raw.url, 2048);
    const title = normalizedString(raw.title, 500);
    const date = normalizedString(raw.date, 100);
    const streamer = normalizedString(raw.streamer, 25);
    const duration = normalizedString(raw.duration_str, 64);
    if (!url || !/^https:\/\/(?:www\.)?twitch\.tv\/videos\/\d+(?:[/?#].*)?$/i.test(url)) return null;
    if (!title || !date || !streamer || !/^[a-z0-9_]+$/i.test(streamer) || !duration) return null;
    const customClip = raw.customClip === undefined ? undefined : normalizeCustomClip(raw.customClip);
    if (raw.customClip !== undefined && !customClip) return null;
    return {
        url,
        title,
        date,
        streamer: streamer.toLowerCase(),
        duration_str: duration,
        ...(customClip ? { customClip } : {}),
    };
}

export function createRendererQueueItem(value: unknown, id: string): QueueItem | null {
    const input = normalizeRendererQueueInput(value);
    if (!input || !id) return null;
    return { ...input, id, status: 'pending', progress: 0 };
}

export function getMergeGroupCleanupPaths(item: QueueItem | undefined): string[] {
    if (!item?.mergeGroup) return [];
    return [
        ...Object.values(item.mergeGroup.downloadedFiles),
        ...(item.mergeGroup.mergedFile ? [item.mergeGroup.mergedFile] : []),
    ];
}

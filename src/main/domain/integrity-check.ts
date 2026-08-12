// Wrappt ffprobe -show_streams -show_format -of json + entscheidet, ob eine
// fertige Recording-/Download-Datei strukturell valide ist.
// Pure-Parser-Layer ist getrennt testbar; das eigentliche Spawn ist im Caller.

export interface ProbeStream {
    index: number;
    codecType: string;            // 'video' | 'audio' | 'subtitle' | ...
    codecName?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
}

export interface ProbeResult {
    streams: ProbeStream[];
    durationSeconds: number;
    sizeBytes: number;
}

export interface IntegrityVerdict {
    ok: boolean;
    reasons: string[];
    durationSeconds: number;
    hasVideo: boolean;
    hasAudio: boolean;
}

export interface IntegrityCheckOptions {
    expectedDurationSeconds?: number;
    durationToleranceSeconds?: number;     // default 5
    minDurationSeconds?: number;            // default 1
}

interface FfprobeJsonStream {
    index?: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string | number;
}

interface FfprobeJson {
    streams?: FfprobeJsonStream[];
    format?: {
        duration?: string | number;
        size?: string | number;
    };
}

function toNumber(v: unknown, fallback = 0): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return fallback;
}

export function parseFfprobeJson(rawJson: string): ProbeResult {
    let parsed: FfprobeJson;
    try {
        parsed = JSON.parse(rawJson) as FfprobeJson;
    } catch (e) {
        throw new Error(`integrity-check: ffprobe JSON parse failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }

    const streams: ProbeStream[] = (parsed.streams ?? []).map((s, idx) => ({
        index: typeof s.index === 'number' ? s.index : idx,
        codecType: typeof s.codec_type === 'string' ? s.codec_type : 'unknown',
        codecName: typeof s.codec_name === 'string' ? s.codec_name : undefined,
        width: typeof s.width === 'number' ? s.width : undefined,
        height: typeof s.height === 'number' ? s.height : undefined,
        durationSeconds: s.duration !== undefined ? toNumber(s.duration) : undefined,
    }));

    const formatDuration = toNumber(parsed.format?.duration, 0);
    const formatSize = toNumber(parsed.format?.size, 0);

    return {
        streams,
        durationSeconds: formatDuration,
        sizeBytes: formatSize,
    };
}

export function assessIntegrity(probe: ProbeResult, opts: IntegrityCheckOptions = {}): IntegrityVerdict {
    const minDuration = opts.minDurationSeconds ?? 1;
    const tolerance = opts.durationToleranceSeconds ?? 5;

    const hasVideo = probe.streams.some(s => s.codecType === 'video');
    const hasAudio = probe.streams.some(s => s.codecType === 'audio');

    const reasons: string[] = [];

    if (!hasVideo) {
        reasons.push('no-video-stream');
    }

    if (probe.durationSeconds < minDuration) {
        reasons.push(`duration-too-short:${probe.durationSeconds.toFixed(2)}s<${minDuration}s`);
    }

    if (typeof opts.expectedDurationSeconds === 'number' && opts.expectedDurationSeconds > 0) {
        const diff = Math.abs(probe.durationSeconds - opts.expectedDurationSeconds);
        if (diff > tolerance) {
            reasons.push(
                `duration-mismatch:actual=${probe.durationSeconds.toFixed(2)}s,` +
                `expected=${opts.expectedDurationSeconds.toFixed(2)}s,` +
                `tolerance=${tolerance}s`
            );
        }
    }

    return {
        ok: reasons.length === 0,
        reasons,
        durationSeconds: probe.durationSeconds,
        hasVideo,
        hasAudio,
    };
}

/**
 * Convenience: vollstaendige integrity-check Pipeline. Caller liefert die
 * ffprobe-JSON-Ausgabe als String (so bleibt das Modul Spawn-frei + leicht
 * testbar; die main.ts hat schon ffprobe-Spawn-Helpers).
 */
export function verifyIntegrityFromJson(rawJson: string, opts?: IntegrityCheckOptions): IntegrityVerdict {
    const probe = parseFfprobeJson(rawJson);
    return assessIntegrity(probe, opts);
}

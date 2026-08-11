import type { EditorSegment } from './video-editor';

export interface CutterExportPlanOptions {
    inputFile: string;
    outputFile: string;
    segments: readonly EditorSegment[];
    hasAudio: boolean;
}

export interface CutterExportPlan {
    segments: EditorSegment[];
    remainingDuration: number;
    filterComplex: string;
    ffmpegArgs: string[];
}

const precision = 9;

function round(value: number): number {
    return Number(value.toFixed(precision));
}

function formatSeconds(value: number): string {
    return value.toFixed(precision).replace(/\.?0+$/, '');
}

function validatePath(value: string, name: string): string {
    if (!value.trim()) throw new Error(`${name} must not be empty`);
    return value;
}

function normalizeSegments(segments: readonly EditorSegment[]): EditorSegment[] {
    if (segments.length === 0) throw new Error('At least one playable segment is required');
    const normalized = segments.map((segment) => {
        if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
            throw new Error('Segment boundaries must be finite');
        }
        if (segment.start < 0 || segment.end <= segment.start) {
            throw new Error('Segment boundaries must be ordered and non-negative');
        }
        const start = round(segment.start);
        const end = round(segment.end);
        if (end <= start) throw new Error('Segment duration is below export precision');
        return { start, end };
    }).sort((left, right) => left.start - right.start || left.end - right.end);

    for (let index = 1; index < normalized.length; index += 1) {
        if (normalized[index].start < normalized[index - 1].end) {
            throw new Error('Playable segments must not overlap');
        }
    }

    return normalized;
}

function createFilterComplex(segments: readonly EditorSegment[], hasAudio: boolean): string {
    const filters: string[] = [];
    const concatInputs: string[] = [];

    segments.forEach((segment, index) => {
        const start = formatSeconds(segment.start);
        const end = formatSeconds(segment.end);
        filters.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`);
        concatInputs.push(`[v${index}]`);
        if (hasAudio) {
            filters.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`);
            concatInputs.push(`[a${index}]`);
        }
    });

    filters.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[outv]${hasAudio ? '[outa]' : ''}`);
    return filters.join(';');
}

function createFfmpegArgs(inputFile: string, outputFile: string, filterComplex: string, hasAudio: boolean): string[] {
    const args = [
        '-i', inputFile,
        '-filter_complex', filterComplex,
        '-map', '[outv]',
    ];
    if (hasAudio) args.push('-map', '[outa]');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
    else args.push('-an');
    args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-y', outputFile);
    return args;
}

export function createCutterExportPlan(options: CutterExportPlanOptions): CutterExportPlan {
    const inputFile = validatePath(options.inputFile, 'inputFile');
    const outputFile = validatePath(options.outputFile, 'outputFile');
    const segments = normalizeSegments(options.segments);
    const remainingDuration = round(segments.reduce((total, segment) => total + segment.end - segment.start, 0));
    const filterComplex = createFilterComplex(segments, options.hasAudio);
    return {
        segments,
        remainingDuration,
        filterComplex,
        ffmpegArgs: createFfmpegArgs(inputFile, outputFile, filterComplex, options.hasAudio),
    };
}

export function calculateCutterExportProgress(processedSeconds: number, plan: Pick<CutterExportPlan, 'remainingDuration'>): number {
    if (!Number.isFinite(processedSeconds) || processedSeconds <= 0) return 0;
    if (!Number.isFinite(plan.remainingDuration) || plan.remainingDuration <= 0) {
        throw new Error('remainingDuration must be greater than zero');
    }
    return Math.min(100, round(processedSeconds / plan.remainingDuration * 100));
}

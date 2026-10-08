import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMediaProcess } from './media-process';
import { remuxMp4 } from './mp4-remux';

export interface VodPreviewRequest {
    id: string;
    url: string;
    start: number;
    duration: number;
}

export function validateVodPreviewRequest(value: unknown): VodPreviewRequest {
    const request = value as VodPreviewRequest | null;
    if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.id)
        || typeof request.url !== 'string' || !/^https:\/\/(?:www\.)?twitch\.tv\/videos\/\d+$/.test(request.url)
        || !Number.isFinite(request.start) || request.start < 0 || request.start > 7 * 86400
        || !Number.isFinite(request.duration) || request.duration < 1 || request.duration > 15) {
        throw new Error('Invalid VOD preview request');
    }
    return { id: request.id, url: request.url, start: request.start, duration: request.duration };
}

interface PreviewJob {
    id: string;
    controller: AbortController;
    directory: string | null;
    done: Promise<unknown>;
}

export class VodPreviewService {
    private current: PreviewJob | null = null;

    async cancel(id?: string): Promise<void> {
        const job = this.current;
        if (!job || (id !== undefined && job.id !== id)) return;
        this.current = null;
        job.controller.abort();
        await job.done.catch(() => undefined);
        if (job.directory) await fs.rm(job.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    async create(value: unknown, tools: {
        temporaryRoot: string;
        prepare: () => Promise<boolean>;
        streamlink: () => { command: string; prefixArgs: string[] };
        ffmpeg: () => string;
        ffprobe: () => string;
    }): Promise<{ sourceUrl: string; start: number; duration: number }> {
        const request = validateVodPreviewRequest(value);
        const previous = this.cancel();
        const job: PreviewJob = { id: request.id, controller: new AbortController(), directory: null, done: Promise.resolve() };
        this.current = job;
        const run = async () => {
            await previous;
            const signal = job.controller.signal;
            signal.throwIfAborted();
            const prepared = await new Promise<boolean>((resolve, reject) => {
                const abort = (): void => reject(new Error('Preview cancelled'));
                signal.addEventListener('abort', abort, { once: true });
                tools.prepare().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
            });
            if (!prepared) throw new Error('Preview tools unavailable');
            signal.throwIfAborted();
            job.directory = await fs.mkdtemp(path.join(tools.temporaryRoot, 'tvm-vod-preview-'));
            const inputPath = path.join(job.directory, 'source.stream');
            const outputPath = path.join(job.directory, 'preview.mp4');
            const streamlink = tools.streamlink();
            await runMediaProcess(streamlink.command, [
                ...streamlink.prefixArgs, request.url, 'best', '--output', inputPath,
                '--hls-start-offset', String(request.start), '--hls-duration', String(request.duration),
                '--stream-segment-attempts', '2', '--stream-segment-timeout', '15', '--stream-timeout', '30',
            ], { signal, timeoutMs: 90000 });
            await remuxMp4({ inputPath, outputPath, ffmpegPath: tools.ffmpeg(), ffprobePath: tools.ffprobe(), signal, timeoutMs: 30000 });
            signal.throwIfAborted();
            await fs.rm(inputPath, { force: true });
            return { sourceUrl: pathToFileURL(outputPath).href, start: request.start, duration: request.duration };
        };
        job.done = run();
        try {
            return await job.done as { sourceUrl: string; start: number; duration: number };
        } catch (error) {
            if (job.directory) await fs.rm(job.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            if (this.current === job) this.current = null;
            throw error;
        }
    }
}

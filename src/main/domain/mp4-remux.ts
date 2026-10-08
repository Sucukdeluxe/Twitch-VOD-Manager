import { runMediaProcess, type MediaProcessOptions } from './media-process';

export interface Mp4RemuxOptions extends MediaProcessOptions {
    inputPath: string;
    outputPath: string;
    ffmpegPath: string;
    ffprobePath: string;
}

export async function remuxMp4(options: Mp4RemuxOptions): Promise<void> {
    await runMediaProcess(options.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', options.inputPath,
        '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero', '-f', 'mp4', '-y', options.outputPath,
    ], { ...options, timeoutMs: options.timeoutMs ?? 30 * 60 * 1000 });
    const raw = await runMediaProcess(options.ffprobePath, [
        '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type',
        '-of', 'json', options.outputPath,
    ], options);
    const probe = JSON.parse(raw) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string }> };
    if (!probe.format?.format_name?.split(',').includes('mp4')
        || !(Number(probe.format.duration) > 0)
        || !probe.streams?.some((stream) => stream.codec_type === 'video')) {
        throw new Error('Invalid MP4 output');
    }
}

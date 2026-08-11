import { describe, expect, test } from 'vitest';
import { calculateCutterExportProgress, createCutterExportPlan } from './cutter-export';

describe('cutter export segments', () => {
    test('sorts playable segments and preserves the caller input', () => {
        const segments = [
            { start: 30, end: 45 },
            { start: 5, end: 20 },
        ];

        const plan = createCutterExportPlan({
            inputFile: 'D:\\media\\source.mp4',
            outputFile: 'D:\\media\\result.mp4',
            segments,
            hasAudio: true,
        });

        expect(plan.segments).toEqual([
            { start: 5, end: 20 },
            { start: 30, end: 45 },
        ]);
        expect(plan.remainingDuration).toBe(30);
        expect(segments).toEqual([
            { start: 30, end: 45 },
            { start: 5, end: 20 },
        ]);
    });

    test('builds an audio and video concat filter with a separated argument list', () => {
        const plan = createCutterExportPlan({
            inputFile: 'D:\\media folder\\source.mp4',
            outputFile: 'D:\\exports\\result.mp4',
            segments: [
                { start: 5, end: 20 },
                { start: 30.5, end: 45.25 },
            ],
            hasAudio: true,
        });

        expect(plan.filterComplex).toBe('[0:v]trim=start=5:end=20,setpts=PTS-STARTPTS[v0];[0:a]atrim=start=5:end=20,asetpts=PTS-STARTPTS[a0];[0:v]trim=start=30.5:end=45.25,setpts=PTS-STARTPTS[v1];[0:a]atrim=start=30.5:end=45.25,asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]');
        expect(plan.ffmpegArgs).toEqual([
            '-i', 'D:\\media folder\\source.mp4',
            '-filter_complex', plan.filterComplex,
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '20',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '160k',
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            '-y', 'D:\\exports\\result.mp4',
        ]);
    });

    test('builds a video-only concat filter without audio mappings or codecs', () => {
        const plan = createCutterExportPlan({
            inputFile: 'input.mkv',
            outputFile: 'output.mp4',
            segments: [
                { start: 0, end: 10 },
                { start: 12, end: 18 },
            ],
            hasAudio: false,
        });

        expect(plan.filterComplex).toBe('[0:v]trim=start=0:end=10,setpts=PTS-STARTPTS[v0];[0:v]trim=start=12:end=18,setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0[outv]');
        expect(plan.ffmpegArgs).toEqual([
            '-i', 'input.mkv',
            '-filter_complex', plan.filterComplex,
            '-map', '[outv]',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '20',
            '-pix_fmt', 'yuv420p',
            '-an',
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            '-y', 'output.mp4',
        ]);
    });

    test.each([
        { name: 'empty segment list', segments: [] },
        { name: 'negative start', segments: [{ start: -1, end: 2 }] },
        { name: 'zero duration', segments: [{ start: 2, end: 2 }] },
        { name: 'reversed range', segments: [{ start: 3, end: 2 }] },
        { name: 'non-finite start', segments: [{ start: Number.NaN, end: 2 }] },
        { name: 'non-finite end', segments: [{ start: 1, end: Number.POSITIVE_INFINITY }] },
        { name: 'range below export precision', segments: [{ start: 1, end: 1.0000000001 }] },
        { name: 'overlap after sorting', segments: [{ start: 10, end: 20 }, { start: 5, end: 12 }] },
    ])('rejects $name', ({ segments }) => {
        expect(() => createCutterExportPlan({
            inputFile: 'input.mp4',
            outputFile: 'output.mp4',
            segments,
            hasAudio: true,
        })).toThrow();
    });

    test('calculates progress against the remaining segment duration and clamps it', () => {
        const plan = createCutterExportPlan({
            inputFile: 'input.mp4',
            outputFile: 'output.mp4',
            segments: [{ start: 10, end: 20 }, { start: 50, end: 70 }],
            hasAudio: true,
        });

        expect(calculateCutterExportProgress(0, plan)).toBe(0);
        expect(calculateCutterExportProgress(15, plan)).toBe(50);
        expect(calculateCutterExportProgress(45, plan)).toBe(100);
        expect(calculateCutterExportProgress(-5, plan)).toBe(0);
    });
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRendererQueueItem, getMergeGroupCleanupPaths, normalizeRendererQueueInput } from './renderer-queue-input';

describe('renderer queue input', () => {
    it('keeps only validated renderer-owned queue fields', () => {
        const directory = mkdtempSync(join(tmpdir(), 'tvm-renderer-queue-'));
        const victim = join(directory, 'important.txt');
        writeFileSync(victim, 'keep');
        const normalized = normalizeRendererQueueInput({
            id: 'forged-id',
            status: 'completed',
            progress: 100,
            url: 'https://www.twitch.tv/videos/123456789',
            title: 'Fixture title',
            date: '2026-08-11T20:00:00.000Z',
            streamer: 'fixture_streamer',
            duration_str: '1h2m3s',
            outputFiles: ['C:\\Users\\victim\\important.txt'],
            mergeGroup: {
                items: [],
                mergePhase: 'done',
                currentItemIndex: 0,
                downloadedFiles: { 0: 'C:\\Users\\victim\\important.txt' },
                mergedFile: 'C:\\Users\\victim\\another-important.txt',
            },
            isLive: true,
            recordingHealth: 'ok',
            last_error: 'forged',
        });

        expect(normalized).toEqual({
            url: 'https://www.twitch.tv/videos/123456789',
            title: 'Fixture title',
            date: '2026-08-11T20:00:00.000Z',
            streamer: 'fixture_streamer',
            duration_str: '1h2m3s',
        });
        expect(JSON.stringify(normalized)).not.toContain('important.txt');
        const queueItem = createRendererQueueItem({
            ...normalized,
            mergeGroup: { downloadedFiles: { 0: victim }, mergedFile: victim },
        }, 'main-owned-id');
        for (const cleanupPath of getMergeGroupCleanupPaths(queueItem ?? undefined)) rmSync(cleanupPath, { force: true });
        expect(existsSync(victim)).toBe(true);
        rmSync(directory, { recursive: true, force: true });
    });

    it('normalizes a valid custom clip without accepting extra fields', () => {
        const normalized = normalizeRendererQueueInput({
            url: 'https://www.twitch.tv/videos/123456789',
            title: 'Fixture title',
            date: '2026-08-11T20:00:00.000Z',
            streamer: 'fixture_streamer',
            duration_str: '1h2m3s',
            customClip: {
                startSec: 12.5,
                durationSec: 30,
                startPart: 1,
                filenameFormat: 'template',
                filenameTemplate: '{date}_{title}',
                mergedFile: 'C:\\forged.mp4',
            },
        });

        expect(normalized?.customClip).toEqual({
            startSec: 12.5,
            durationSec: 30,
            startPart: 1,
            filenameFormat: 'template',
            filenameTemplate: '{date}_{title}',
        });
    });

    it('rejects malformed queue requests before they can enter persistent state', () => {
        expect(normalizeRendererQueueInput(null)).toBeNull();
        expect(normalizeRendererQueueInput({ url: 'file:///C:/victim.txt', title: 'x', date: 'x', streamer: 'x', duration_str: '1s' })).toBeNull();
        expect(normalizeRendererQueueInput({ url: 'https://www.twitch.tv/videos/1', title: '', date: 'x', streamer: 'x', duration_str: '1s' })).toBeNull();
        expect(normalizeRendererQueueInput({
            url: 'https://www.twitch.tv/videos/1',
            title: 'x',
            date: 'x',
            streamer: 'x',
            duration_str: '1s',
            customClip: { startSec: -1, durationSec: 10, startPart: 1, filenameFormat: 'simple' },
        })).toBeNull();
    });

    it('cleans interrupted merge artifacts without deleting completed published outputs', () => {
        const base = createRendererQueueItem({
            url: 'https://www.twitch.tv/videos/1',
            title: 'Merge',
            date: '2026-08-13T00:00:00.000Z',
            streamer: 'fixture_streamer',
            duration_str: '1h',
        }, 'merge-id')!;
        const interrupted = {
            ...base,
            status: 'error' as const,
            mergeGroup: {
                items: [],
                mergePhase: 'splitting' as const,
                currentItemIndex: 0,
                downloadedFiles: { 0: 'C:\\downloads\\merge_tmp_0_1.mp4' },
                mergedFile: 'C:\\downloads\\merged_2.mp4',
                splitFiles: ['C:\\downloads\\Part01.mp4'],
                splitTempFiles: ['C:\\downloads\\.merge_split_2_0.mp4'],
            },
        };
        expect(getMergeGroupCleanupPaths(interrupted)).toEqual([
            'C:\\downloads\\merge_tmp_0_1.mp4',
            'C:\\downloads\\merged_2.mp4',
            'C:\\downloads\\Part01.mp4',
            'C:\\downloads\\.merge_split_2_0.mp4',
        ]);
        expect(getMergeGroupCleanupPaths({
            ...interrupted,
            status: 'completed',
            mergeGroup: { ...interrupted.mergeGroup, mergePhase: 'done' },
        })).toEqual([
            'C:\\downloads\\merge_tmp_0_1.mp4',
            'C:\\downloads\\merged_2.mp4',
        ]);
    });
});

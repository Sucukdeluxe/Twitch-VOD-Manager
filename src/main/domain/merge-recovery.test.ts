import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueueItem } from '../../types';
import { getInterruptedMergeItemIds, recoverInterruptedMergeArtifacts } from './merge-recovery';

function getWindowsShortPath(targetPath: string): string {
    const command = `for %I in ("${targetPath}") do @echo %~sI`;
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], {
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `ShortPath lookup exited with ${result.status}`);
    return result.stdout.trim();
}

let directory: string;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-merge-recovery-'));
});

afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
});

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
    return {
        id: 'merge-1',
        title: 'Merge',
        url: 'https://www.twitch.tv/videos/1',
        date: '2026-08-13T00:00:00.000Z',
        streamer: 'alice',
        duration_str: '2h',
        status: 'downloading',
        progress: 84,
        mergeGroup: {
            items: [
                { url: 'https://www.twitch.tv/videos/1', title: 'A', date: '2026-08-13T00:00:00.000Z', streamer: 'alice', duration_str: '1h' },
                { url: 'https://www.twitch.tv/videos/2', title: 'B', date: '2026-08-13T00:00:00.000Z', streamer: 'alice', duration_str: '1h' },
            ],
            mergePhase: 'merging',
            currentItemIndex: 1,
            downloadedFiles: {},
        },
        ...overrides,
    };
}

describe('recoverInterruptedMergeArtifacts', () => {
    it('removes internal crash artifacts and resets an unfinished merge from the beginning', () => {
        const jobDirectory = path.join(directory, 'alice');
        fs.mkdirSync(jobDirectory);
        const first = path.join(jobDirectory, 'merge_tmp_0_100.mp4');
        const second = path.join(jobDirectory, 'merge_tmp_1_200.mp4');
        const merged = path.join(jobDirectory, '.merge_output_300_123.mp4');
        fs.writeFileSync(first, 'partial-a');
        fs.writeFileSync(second, 'partial-b');
        fs.writeFileSync(merged, 'partial-merge');
        const item = queueItem();
        item.mergeGroup!.downloadedFiles = { 0: first, 1: second };
        item.mergeGroup!.mergedFile = merged;

        const result = recoverInterruptedMergeArtifacts([item], directory, new Set([item.id]));

        expect(result.changed).toBe(true);
        expect(result.removedFiles.sort()).toEqual([first, second, merged].sort());
        expect(result.queue[0]).toMatchObject({ status: 'pending', progress: 0 });
        expect(result.queue[0].mergeGroup).toMatchObject({
            mergePhase: 'downloading',
            currentItemIndex: 0,
            downloadedFiles: {},
        });
        expect(result.queue[0].mergeGroup).not.toHaveProperty('mergedFile');
        expect(fs.existsSync(first)).toBe(false);
        expect(fs.existsSync(second)).toBe(false);
        expect(fs.existsSync(merged)).toBe(false);
        expect(result.queue[0].artifactRoot).toBe(fs.realpathSync.native(directory));
    });

    it.skipIf(process.platform !== 'win32')('removes crash artifacts referenced through a Windows 8.3 short path root', (context) => {
        const shortDirectory = getWindowsShortPath(directory);
        if (!shortDirectory || shortDirectory.toLowerCase() === fs.realpathSync.native(directory).toLowerCase()) {
            context.skip();
            return;
        }
        const jobDirectory = path.join(shortDirectory, 'alice');
        fs.mkdirSync(jobDirectory);
        const first = path.join(jobDirectory, 'merge_tmp_0_100.mp4');
        const merged = path.join(jobDirectory, '.merge_output_300_123.mp4');
        fs.writeFileSync(first, 'partial-a');
        fs.writeFileSync(merged, 'partial-merge');
        const item = queueItem();
        item.mergeGroup!.downloadedFiles = { 0: first };
        item.mergeGroup!.mergedFile = merged;

        const result = recoverInterruptedMergeArtifacts([item], shortDirectory, new Set([item.id]));

        expect(result.failedFiles).toEqual([]);
        expect(result.removedFiles.sort()).toEqual([first, merged].sort());
        expect(fs.existsSync(first)).toBe(false);
        expect(fs.existsSync(merged)).toBe(false);
        expect(result.queue[0]).toMatchObject({ status: 'pending', progress: 0 });
        expect(result.queue[0].artifactRoot).toBe(fs.realpathSync.native(directory));
    });

    it('uses persisted artifact provenance after the configured download root changes', () => {
        const previousRoot = path.join(directory, 'previous');
        const currentRoot = path.join(directory, 'current');
        fs.mkdirSync(previousRoot);
        fs.mkdirSync(currentRoot);
        const artifact = path.join(previousRoot, 'merge_tmp_0_100.mp4');
        fs.writeFileSync(artifact, 'partial');
        const item = queueItem({ artifactRoot: fs.realpathSync.native(previousRoot) });
        item.mergeGroup!.downloadedFiles = { 0: artifact };

        const result = recoverInterruptedMergeArtifacts([item], currentRoot, new Set([item.id]));

        expect(result.failedFiles).toEqual([]);
        expect(result.removedFiles).toEqual([artifact]);
        expect(fs.existsSync(artifact)).toBe(false);
    });

    it('never removes a persisted path outside the configured download root', () => {
        const outside = path.join(os.tmpdir(), `merge_tmp_0_${Date.now()}.mp4`);
        fs.writeFileSync(outside, 'keep');
        const item = queueItem();
        item.mergeGroup!.downloadedFiles = { 0: outside };

        try {
            const result = recoverInterruptedMergeArtifacts([item], directory, new Set([item.id]));
            expect(result.removedFiles).toEqual([]);
            expect(result.failedFiles).toEqual([outside]);
            expect(result.queue[0]).toMatchObject({ status: 'error', mergeRecoveryBlocked: true });
            expect(result.queue[0]).not.toHaveProperty('artifactRoot');
            expect(fs.existsSync(outside)).toBe(true);
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });

    it('leaves completed merge jobs and their published outputs untouched', () => {
        const output = path.join(directory, 'published.mp4');
        fs.writeFileSync(output, 'complete');
        const item = queueItem({ status: 'completed', progress: 100, outputFiles: [output] });
        item.mergeGroup!.mergePhase = 'done';

        const result = recoverInterruptedMergeArtifacts([item], directory, new Set([item.id]));

        expect(result).toEqual({ queue: [item], removedFiles: [], failedFiles: [], changed: false });
        expect(fs.existsSync(output)).toBe(true);
    });

    it('leaves a normal failed job untouched because it is not a hard-crash recovery', () => {
        const item = queueItem({ status: 'error', progress: 72, last_error: 'ffmpeg failed' });

        const result = recoverInterruptedMergeArtifacts([item], directory, new Set());

        expect(result).toEqual({ queue: [item], removedFiles: [], failedFiles: [], changed: false });
    });

    it('removes persisted temp and published split artifacts from an interrupted split', () => {
        const jobDirectory = path.join(directory, 'alice');
        fs.mkdirSync(jobDirectory);
        const temp = path.join(jobDirectory, '.merge_split_123_0.mp4');
        const published = path.join(jobDirectory, 'Alice_Part01.mp4');
        fs.writeFileSync(temp, 'partial');
        fs.writeFileSync(published, 'published-before-crash');
        const item = queueItem();
        item.mergeGroup!.mergePhase = 'splitting';
        item.mergeGroup!.splitTempFiles = [temp];
        item.mergeGroup!.splitFiles = [published];

        const result = recoverInterruptedMergeArtifacts([item], directory, new Set([item.id]));

        expect(result.removedFiles.sort()).toEqual([temp, published].sort());
        expect(result.failedFiles).toEqual([]);
        expect(result.queue[0].mergeGroup).not.toHaveProperty('splitFiles');
        expect(result.queue[0].mergeGroup).not.toHaveProperty('splitTempFiles');
        expect(fs.existsSync(temp)).toBe(false);
        expect(fs.existsSync(published)).toBe(false);
    });

    it('keeps references and blocks retry when an interrupted artifact cannot be removed', () => {
        const jobDirectory = path.join(directory, 'alice');
        fs.mkdirSync(jobDirectory);
        const locked = path.join(jobDirectory, '.merge_split_123_0.mp4');
        fs.mkdirSync(locked);
        const item = queueItem();
        item.mergeGroup!.mergePhase = 'splitting';
        item.mergeGroup!.splitTempFiles = [locked];

        const result = recoverInterruptedMergeArtifacts([item], directory, new Set([item.id]));

        expect(result.removedFiles).toEqual([]);
        expect(result.failedFiles).toEqual([locked]);
        expect(result.queue[0]).toMatchObject({
            status: 'error',
            mergeRecoveryBlocked: true,
            mergeGroup: { splitTempFiles: [locked] },
        });
    });

    it('derives recovery eligibility only from persisted downloading merge jobs', () => {
        expect([...getInterruptedMergeItemIds([
            { id: 'active', status: 'downloading', mergeGroup: {} },
            { id: 'failed', status: 'error', mergeGroup: {} },
            { id: 'plain', status: 'downloading' },
            null,
        ])]).toEqual(['active']);
    });
});

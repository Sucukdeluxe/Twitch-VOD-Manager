import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('phase-boundary production path', () => {
    it('pauses only at completed boundaries and never reruns a failed concat or copy-merge phase', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const concatStart = source.indexOf('async function concatVideoFiles');
        const concatEnd = source.indexOf('async function cutVideo', concatStart);
        const concat = source.slice(concatStart, concatEnd);
        const mergeStart = source.indexOf('async function mergeVideos');
        const mergeEnd = source.indexOf('async function splitMergedFile', mergeStart);
        const merge = source.slice(mergeStart, mergeEnd);

        expect(source).toContain('async function waitForQueuePhaseBoundary');
        expect(concat).not.toContain('while (true)');
        expect(concat).toContain('await waitForQueuePhaseBoundary(itemId)');
        expect(concat).toContain('fs.rmSync(outputFile, { force: true })');
        expect(merge).toContain('const boundaryReady = await waitForQueuePhaseBoundary(itemId)');
        expect(merge).toContain('if (appShutdownStarted || !boundaryReady)');
        expect(merge).not.toContain('queueProcessRegistry.isCancelled(itemId) || queueProcessRegistry.isPaused(itemId)');
    });
});

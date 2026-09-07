import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

describe('queue addition IPC contract', () => {
    it('starts pending downloads in visible order even with a legacy smart scheduler setting', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const start = source.indexOf('function pickNextPendingQueueItem');
        const end = source.indexOf('function parseClockDurationSeconds', start);
        const context = {
            config: { smart_queue_scheduler: true },
            downloadQueue: [
                { id: 'finished', status: 'completed' },
                { id: 'long-first', status: 'pending', duration_str: '10h', createdAt: '2026-09-07T10:00:00Z' },
                { id: 'short-second', status: 'pending', duration_str: '1m', customClip: { durationSec: 60 }, createdAt: '2026-09-07T10:01:00Z' },
            ],
        };
        const code = transpileModule(`${source.slice(start, end)}\nglobalThis.pickNext = pickNextPendingQueueItem;`, {
            compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
        }).outputText;
        const runtime = runInNewContext(`${code}\nglobalThis`, context);
        expect(runtime.pickNext().id).toBe('long-first');
        context.downloadQueue[1].status = 'downloading';
        expect(runtime.pickNext().id).toBe('short-second');
        context.downloadQueue[1].status = 'pending';
        context.downloadQueue.reverse();
        expect(runtime.pickNext().id).toBe('short-second');
        context.downloadQueue.forEach((item) => { item.status = 'paused'; });
        expect(runtime.pickNext()).toBeNull();
    });

    it('keeps the legacy queue result and exposes the atomic accepted result separately', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');

        expect(source).toContain("registerTrustedIpcHandler(ipcMain, 'add-to-queue-with-result'");
        expect(source).toContain('function addRendererQueueItemWithResult(input: unknown, notifyDuplicate: boolean): QueueAdditionResult<QueueItem>');
        expect(source).toContain('return addRendererQueueItemWithResult(input, true).queue;');
        expect(source).toContain('return addRendererQueueItemWithResult(input, false);');
        expect(source).toContain("reason: 'access-denied' as const");
        expect(source).toContain("reason: 'shutting-down'");
    });
});

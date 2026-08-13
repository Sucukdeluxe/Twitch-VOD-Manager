import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('queue addition IPC contract', () => {
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

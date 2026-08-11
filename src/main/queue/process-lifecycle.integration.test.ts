import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueueProcessRegistry, QueueRunLifecycle, waitForChildProcessExit } from './process-registry';

function waitForExit(process: ReturnType<typeof spawn>): Promise<void> {
    if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        process.once('close', () => resolve());
        process.once('error', () => resolve());
    });
}

describe('queue process lifecycle integration', () => {
    it('keeps quick resume behind a real child pause without deleting retry output', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'tvm-queue-pause-'));
        const retryFile = join(directory, 'merge-retry.mp4');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { windowsHide: true });
        const registry = new QueueProcessRegistry();
        let resumedAfterExit = false;

        try {
            writeFileSync(retryFile, 'retry');
            await once(child, 'spawn');
            registry.register('item-a', 'merge', {
                kill: () => child.kill(),
                wait: () => waitForChildProcessExit(child, 30),
                pause: async () => {
                    child.kill();
                    await waitForChildProcessExit(child, 30);
                },
                resume: () => {
                    resumedAfterExit = child.exitCode !== null || child.signalCode !== null;
                },
                cleanup: () => rmSync(retryFile, { force: true }),
            });

            const pausing = registry.pauseItem('item-a');
            const resuming = registry.resumeItem('item-a');
            expect(registry.isPaused('item-a')).toBe(true);

            await Promise.all([pausing, resuming]);

            expect(resumedAfterExit).toBe(true);
            expect(registry.isPaused('item-a')).toBe(false);
            expect(existsSync(retryFile)).toBe(true);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await waitForExit(child);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('waits for a late-cancelled real child before cleanup and final persistence', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'tvm-queue-lifecycle-'));
        const partialFile = join(directory, 'output.mp4.partial');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { windowsHide: true });
        const registry = new QueueProcessRegistry();
        const lifecycle = new QueueRunLifecycle(registry);
        const sequence: string[] = [];

        try {
            writeFileSync(partialFile, 'partial');
            await once(child, 'spawn');
            const childExited = waitForExit(child);
            lifecycle.schedule(async () => childExited);
            registry.register('item-a', 'merge', {
                kill: () => undefined,
                wait: () => waitForChildProcessExit(child, 30),
                cleanup: () => {
                    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
                    rmSync(partialFile, { force: true });
                    sequence.push('cleanup');
                },
            });

            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(child.exitCode).toBeNull();
            expect(child.signalCode).toBeNull();
            expect(existsSync(partialFile)).toBe(true);
            await lifecycle.shutdown(() => undefined, () => {
                expect(existsSync(partialFile)).toBe(false);
                sequence.push('persist');
            });

            expect(sequence).toEqual(['cleanup', 'persist']);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await waitForExit(child);
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

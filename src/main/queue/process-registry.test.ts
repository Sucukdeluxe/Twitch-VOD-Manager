import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { QueueProcessRegistry, QueueRunLifecycle, waitForChildProcessExit, type QueueProcessResource } from './process-registry';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function createResource(wait: Promise<void> = Promise.resolve()): QueueProcessResource {
    return {
        kill: vi.fn(),
        wait: () => wait,
        pause: vi.fn(),
        resume: vi.fn(),
        cancel: vi.fn(async () => undefined),
        cleanup: vi.fn(async () => undefined),
    };
}

describe('waitForChildProcessExit', () => {
    it('settles immediately on close without forcing termination', async () => {
        vi.useFakeTimers();
        try {
            const child = Object.assign(new EventEmitter(), {
                exitCode: null,
                signalCode: null,
                kill: vi.fn(() => true),
            }) as unknown as ChildProcess;
            let settled = false;
            const waiting = waitForChildProcessExit(child, 25).then(() => {
                settled = true;
            });

            child.emit('close', 0, null);
            await waiting;

            expect(settled).toBe(true);
            expect(child.kill).not.toHaveBeenCalled();
            expect(child.listenerCount('close')).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns immediately for an already exited child without allocating wait resources', async () => {
        vi.useFakeTimers();
        try {
            const child = Object.assign(new EventEmitter(), {
                exitCode: 0,
                signalCode: null,
                kill: vi.fn(() => true),
            }) as unknown as ChildProcess;

            await waitForChildProcessExit(child, 25);

            expect(child.kill).not.toHaveBeenCalled();
            expect(child.listenerCount('close')).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles and releases resources when close never arrives after forced termination', async () => {
        vi.useFakeTimers();
        try {
            const child = Object.assign(new EventEmitter(), {
                exitCode: null,
                signalCode: null,
                kill: vi.fn(() => true),
            }) as unknown as ChildProcess;
            let settled = false;
            const waiting = waitForChildProcessExit(child, 25).then(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(25);

            expect(child.kill).toHaveBeenCalledOnce();
            expect(child.kill).toHaveBeenCalledWith('SIGKILL');
            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(25);

            expect(settled).toBe(true);
            expect(child.listenerCount('close')).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            await waiting;
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('QueueProcessRegistry', () => {
    it('keeps parallel queue item process groups independent', async () => {
        const registry = new QueueProcessRegistry();
        const first = createResource();
        const second = createResource();

        registry.register('item-a', 'merge', first);
        registry.register('item-b', 'split', second);

        await registry.cancelItem('item-a');

        expect(first.kill).toHaveBeenCalledOnce();
        expect(first.cleanup).toHaveBeenCalledOnce();
        expect(second.kill).not.toHaveBeenCalled();
        expect(second.cleanup).not.toHaveBeenCalled();
        expect(registry.activeItemIds()).toEqual(['item-b']);
    });

    it('pauses and resumes every resource for only the selected item', async () => {
        const registry = new QueueProcessRegistry();
        const streamlink = createResource();
        const postProcessing = createResource();
        const unrelated = createResource();

        registry.register('item-a', 'streamlink', streamlink);
        registry.register('item-a', 'post-processing', postProcessing);
        registry.register('item-b', 'streamlink', unrelated);

        await registry.pauseItem('item-a');
        let resumed = false;
        const resumedSignal = registry.whenResumed('item-a').then(() => {
            resumed = true;
        });
        await Promise.resolve();

        expect(registry.isPaused('item-a')).toBe(true);
        expect(resumed).toBe(false);

        await registry.resumeItem('item-a');
        await resumedSignal;

        expect(streamlink.pause).toHaveBeenCalledOnce();
        expect(streamlink.resume).toHaveBeenCalledOnce();
        expect(postProcessing.pause).toHaveBeenCalledOnce();
        expect(postProcessing.resume).toHaveBeenCalledOnce();
        expect(unrelated.pause).not.toHaveBeenCalled();
        expect(unrelated.resume).not.toHaveBeenCalled();
        expect(registry.isPaused('item-a')).toBe(false);
    });

    it('keeps pause latched until existing and newly registered resources finish pausing', async () => {
        const registry = new QueueProcessRegistry();
        const firstPaused = deferred();
        const latePaused = deferred();
        const first = createResource();
        const late = createResource();
        first.pause = vi.fn(() => firstPaused.promise);
        late.pause = vi.fn(() => latePaused.promise);

        registry.register('item-a', 'merge', first);
        const pausing = registry.pauseItem('item-a');
        registry.register('item-a', 'post-processing', late);
        const resuming = registry.resumeItem('item-a');

        await Promise.resolve();
        expect(registry.isPaused('item-a')).toBe(true);
        expect(first.resume).not.toHaveBeenCalled();
        expect(late.pause).toHaveBeenCalledOnce();

        firstPaused.resolve();
        await Promise.resolve();
        expect(registry.isPaused('item-a')).toBe(true);

        latePaused.resolve();
        await Promise.all([pausing, resuming]);

        expect(first.resume).toHaveBeenCalledOnce();
        expect(late.resume).toHaveBeenCalledOnce();
        expect(registry.isPaused('item-a')).toBe(false);
    });

    it.each(['merge', 'split'] as const)('waits for %s termination before removing partial output', async (phase) => {
        const registry = new QueueProcessRegistry();
        const closed = deferred();
        const resource = createResource(closed.promise);

        registry.register('item-a', phase, resource);
        const cancelling = registry.cancelItem('item-a');

        await Promise.resolve();
        expect(resource.kill).toHaveBeenCalledOnce();
        expect(resource.cleanup).not.toHaveBeenCalled();

        closed.resolve();
        await cancelling;

        expect(resource.cancel).toHaveBeenCalledOnce();
        expect(resource.cleanup).toHaveBeenCalledOnce();
        expect(registry.activeItemIds()).toEqual([]);
    });

    it('allows an explicitly reset item to retry without affecting another item', async () => {
        const registry = new QueueProcessRegistry();
        const firstAttempt = createResource();
        const other = createResource();

        registry.register('item-a', 'streamlink', firstAttempt);
        registry.register('item-b', 'streamlink', other);
        await registry.cancelItem('item-a');

        registry.resetItem('item-a');
        const retry = createResource();
        const registration = registry.register('item-a', 'streamlink', retry);

        expect(registration.accepted).toBe(true);
        expect(registry.isCancelled('item-a')).toBe(false);
        expect(registry.activeItemIds()).toEqual(['item-b', 'item-a']);
        expect(other.kill).not.toHaveBeenCalled();
    });

    it('releases completed phase artifacts without deleting retry state', () => {
        const registry = new QueueProcessRegistry();
        const downloadedPart = createResource();
        const mergedIntermediate = createResource();

        registry.register('item-a', 'post-processing', downloadedPart);
        registry.register('item-a', 'post-processing', mergedIntermediate);
        registry.releaseItem('item-a');

        expect(downloadedPart.cleanup).not.toHaveBeenCalled();
        expect(mergedIntermediate.cleanup).not.toHaveBeenCalled();
        expect(registry.activeItemIds()).toEqual([]);
    });
});

describe('QueueRunLifecycle', () => {
    it('latches shutdown, cancels all groups, waits for the queue and persists once', async () => {
        const registry = new QueueProcessRegistry();
        const lifecycle = new QueueRunLifecycle(registry);
        const queueDone = deferred();
        const processClosed = deferred();
        const resource = createResource(processClosed.promise);
        const persist = vi.fn(async () => undefined);
        const beforeCancel = vi.fn(async () => undefined);

        expect(lifecycle.schedule(async () => queueDone.promise)).toBe(true);
        registry.register('item-a', 'merge', resource);

        const firstShutdown = lifecycle.shutdown(beforeCancel, persist);
        const secondShutdown = lifecycle.shutdown(beforeCancel, persist);
        const late = createResource();
        const lateRegistration = registry.register('item-late', 'streamlink', late);

        expect(lifecycle.schedule(async () => undefined)).toBe(false);
        expect(lateRegistration.accepted).toBe(false);

        processClosed.resolve();
        queueDone.resolve();
        await Promise.all([firstShutdown, secondShutdown]);

        expect(beforeCancel).toHaveBeenCalledOnce();
        expect(resource.kill).toHaveBeenCalledOnce();
        expect(resource.cleanup).toHaveBeenCalledOnce();
        expect(late.kill).toHaveBeenCalledOnce();
        expect(late.cleanup).toHaveBeenCalledOnce();
        expect(persist).toHaveBeenCalledOnce();
        expect(registry.activeItemIds()).toEqual([]);
    });
});

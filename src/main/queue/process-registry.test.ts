import { describe, expect, it, vi } from 'vitest';
import { QueueProcessRegistry, QueueRunLifecycle, type QueueProcessResource } from './process-registry';

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
        wait,
        pause: vi.fn(),
        resume: vi.fn(),
        cancel: vi.fn(async () => undefined),
        cleanup: vi.fn(async () => undefined),
    };
}

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

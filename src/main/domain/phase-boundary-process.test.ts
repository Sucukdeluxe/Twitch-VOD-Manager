import { describe, expect, it, vi } from 'vitest';
import { QueueProcessRegistry } from '../queue/process-registry';
import { createPhaseBoundaryProcessResource, waitForPhaseBoundary } from './phase-boundary-process';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('phase-boundary queue processes', () => {
    it('lets the current process finish on pause and only terminates it on cancellation', async () => {
        const registry = new QueueProcessRegistry();
        const exited = deferred();
        const kill = vi.fn();
        const cleanup = vi.fn();
        registry.register('item-a', 'merge', createPhaseBoundaryProcessResource({ kill }, () => exited.promise, cleanup));

        await registry.pauseItem('item-a');
        expect(kill).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();

        const cancelling = registry.cancelItem('item-a');
        expect(kill).toHaveBeenCalledOnce();
        expect(cleanup).not.toHaveBeenCalled();
        exited.resolve();
        await cancelling;
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('waits at a safe boundary until the paused item is resumed', async () => {
        const registry = new QueueProcessRegistry();
        registry.register('item-a', 'split', {});
        await registry.pauseItem('item-a');
        const transitions: string[] = [];
        let settled = false;
        const waiting = waitForPhaseBoundary('item-a', registry, {
            onPaused: () => { transitions.push('paused'); },
            onResumed: () => { transitions.push('resumed'); },
        }).then((result) => {
            settled = true;
            return result;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(transitions).toEqual(['paused']);

        await registry.resumeItem('item-a');
        await expect(waiting).resolves.toBe(true);
        expect(transitions).toEqual(['paused', 'resumed']);
    });

    it('does not report resumed after cancellation releases a paused boundary', async () => {
        const registry = new QueueProcessRegistry();
        registry.register('item-a', 'split', {});
        await registry.pauseItem('item-a');
        const onResumed = vi.fn();
        const waiting = waitForPhaseBoundary('item-a', registry, { onResumed });

        await registry.cancelItem('item-a');

        await expect(waiting).resolves.toBe(false);
        expect(onResumed).not.toHaveBeenCalled();
    });
});

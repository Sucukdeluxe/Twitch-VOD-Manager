import { describe, expect, it, vi } from 'vitest';
import { commitQueueAddition } from './queue-addition';

describe('commitQueueAddition', () => {
    it('returns the accepted item id from the same synchronous mutation it persists', () => {
        const current = [{ id: 'existing' }];
        const persist = vi.fn();

        const result = commitQueueAddition(current, { id: 'added' }, () => false, persist);

        expect(result).toEqual({
            queue: [{ id: 'existing' }, { id: 'added' }],
            accepted: true,
            addedId: 'added',
        });
        expect(persist).toHaveBeenCalledOnce();
        expect(persist).toHaveBeenCalledWith(result.queue);
    });

    it('returns an unmodified queue and no id for duplicates or invalid items', () => {
        const current = [{ id: 'existing' }];
        const persist = vi.fn();

        expect(commitQueueAddition(current, { id: 'duplicate' }, () => true, persist)).toEqual({
            queue: current,
            accepted: false,
            reason: 'duplicate',
        });
        expect(commitQueueAddition(current, null, () => false, persist)).toEqual({
            queue: current,
            accepted: false,
            reason: 'invalid',
        });
        expect(persist).not.toHaveBeenCalled();
    });

    it('returns an explicit persistence failure without leaking a replacement queue', () => {
        const current = [{ id: 'existing' }];

        expect(commitQueueAddition(current, { id: 'added' }, () => false, () => {
            throw new Error('disk full');
        })).toEqual({
            queue: current,
            accepted: false,
            reason: 'persistence-failed',
        });
    });
});

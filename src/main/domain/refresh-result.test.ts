import { describe, expect, it } from 'vitest';
import { resolveRefreshOutcome, type RefreshOutcome } from './refresh-result';

describe('resolveRefreshOutcome', () => {
    it('keeps the last good value when a refresh is unavailable without caching the failure', () => {
        const previous = [{ id: 'vod-1' }];
        const outcome: RefreshOutcome<Array<{ id: string }>> = { status: 'unavailable' };

        expect(resolveRefreshOutcome(previous, outcome)).toEqual({
            value: previous,
            shouldCache: false,
            stale: true,
        });
    });

    it('accepts a successful empty collection as fresh authoritative data', () => {
        expect(resolveRefreshOutcome([{ id: 'vod-1' }], { status: 'success', value: [] })).toEqual({
            value: [],
            shouldCache: true,
            stale: false,
        });
    });

    it('returns no value when the source is unavailable and no last good value exists', () => {
        expect(resolveRefreshOutcome(undefined, { status: 'unavailable' })).toEqual({
            value: null,
            shouldCache: false,
            stale: false,
        });
    });

    it('treats an authoritative not-found result differently from an outage', () => {
        expect(resolveRefreshOutcome([{ id: 'vod-1' }], { status: 'not-found' })).toEqual({
            value: null,
            shouldCache: true,
            stale: false,
        });
    });
});

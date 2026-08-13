import { describe, expect, it } from 'vitest';
import { LastGoodCache } from './last-good-cache';

describe('LastGoodCache', () => {
    it('retains the last successful value independently from expiring request caches', () => {
        const cache = new LastGoodCache<number[]>(2);
        cache.set('a', [1]);
        cache.set('a', []);

        expect(cache.get('a')).toEqual([]);
    });

    it('bounds retained values by least-recent insertion and supports authoritative deletion', () => {
        const cache = new LastGoodCache<number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe(2);
        expect(cache.delete('b')).toBe(true);
        expect(cache.get('b')).toBeUndefined();
    });
});

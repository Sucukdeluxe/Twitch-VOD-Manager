import { describe, expect, it } from 'vitest';
import { UpdateLifecycle } from './update-lifecycle';

describe('UpdateLifecycle', () => {
    it('serializes checks and downloads through ready state', () => {
        const lifecycle = new UpdateLifecycle();

        expect(lifecycle.beginCheck()).toEqual({ started: true });
        expect(lifecycle.completeCheckAvailable('1.2.3')).toBe(true);
        expect(lifecycle.beginDownload('1.2.3')).toEqual({ started: true });
        expect(lifecycle.beginCheck()).toEqual({ started: false, reason: 'downloading' });
        expect(lifecycle.completeDownload('1.2.3')).toBe(true);
        expect(lifecycle.beginCheck()).toEqual({ started: false, reason: 'ready-to-install' });
        expect(lifecycle.snapshot).toEqual({ phase: 'ready', version: '1.2.3' });
    });

    it('ignores check events that arrive during a download', () => {
        const lifecycle = new UpdateLifecycle();
        lifecycle.beginCheck();
        lifecycle.completeCheckAvailable('1.2.3');
        lifecycle.beginDownload('1.2.3');

        expect(lifecycle.completeCheckAvailable('1.2.4')).toBe(false);
        expect(lifecycle.completeCheckNotAvailable()).toBe(false);
        expect(lifecycle.failCheck()).toBe(false);
        expect(lifecycle.snapshot).toEqual({ phase: 'downloading', version: '1.2.3' });
    });

    it('restores the available version after a download failure', () => {
        const lifecycle = new UpdateLifecycle();
        lifecycle.beginCheck();
        lifecycle.completeCheckAvailable('1.2.3');
        lifecycle.beginDownload('1.2.3');

        expect(lifecycle.failDownload('1.2.3')).toBe(true);
        expect(lifecycle.snapshot).toEqual({ phase: 'available', version: '1.2.3' });
        expect(lifecycle.failDownload('1.2.3')).toBe(false);
    });

    it('restores the previous available version after a failed refresh check', () => {
        const lifecycle = new UpdateLifecycle();
        lifecycle.beginCheck();
        lifecycle.completeCheckAvailable('1.2.3');
        lifecycle.beginCheck();

        expect(lifecycle.failCheck()).toBe(true);
        expect(lifecycle.snapshot).toEqual({ phase: 'available', version: '1.2.3' });
    });

    it('rejects unavailable or mismatched download transitions', () => {
        const lifecycle = new UpdateLifecycle();

        expect(lifecycle.beginDownload('1.2.3')).toEqual({ started: false, reason: 'not-available' });
        lifecycle.beginCheck();
        lifecycle.completeCheckAvailable('1.2.3');
        expect(lifecycle.beginDownload('1.2.4')).toEqual({ started: false, reason: 'stale-version' });
        expect(lifecycle.beginDownload('1.2.3')).toEqual({ started: true });
        expect(lifecycle.completeDownload('1.2.4')).toBe(false);
        expect(lifecycle.snapshot).toEqual({ phase: 'downloading', version: '1.2.3' });
    });
});

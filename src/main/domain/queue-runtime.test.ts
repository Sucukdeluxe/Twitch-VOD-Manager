import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../../types';
import {
    canonicalQueueItemIdentity,
    clearQueueTransferState,
    getQueueCreatedAtMs,
    isValidPersistedQueueId,
    mergeQueueProgressState,
    prepareQueueRetryProgress,
} from './queue-runtime';

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
    return {
        id: '1760000000000-1',
        url: 'https://www.twitch.tv/videos/1234567890',
        title: 'Title',
        date: '2026-08-13T10:00:00.000Z',
        streamer: 'streamer',
        duration_str: '1h',
        status: 'pending',
        progress: 0,
        ...overrides,
    };
}

describe('queue runtime invariants', () => {
    it('accepts every historical generated id shape and rejects markup or selector payloads', () => {
        expect(isValidPersistedQueueId('1760000000000-1')).toBe(true);
        expect(isValidPersistedQueueId('1760000000000-999')).toBe(true);
        expect(isValidPersistedQueueId('1760000000000')).toBe(true);
        expect(isValidPersistedQueueId('item" onclick="alert(1)')).toBe(false);
        expect(isValidPersistedQueueId('1760000000000-1000')).toBe(false);
        expect(isValidPersistedQueueId('not-an-id')).toBe(false);
    });

    it('uses createdAt first and the timestamp prefix of historical ids as fallback', () => {
        expect(getQueueCreatedAtMs(queueItem({ createdAt: '2026-08-13T09:30:00.000Z' }), 1)).toBe(Date.parse('2026-08-13T09:30:00.000Z'));
        expect(getQueueCreatedAtMs(queueItem({ id: '1760000000000-27' }), 1)).toBe(1760000000000);
        expect(getQueueCreatedAtMs(queueItem({ id: 'invalid', createdAt: 'invalid' }), 123)).toBe(123);
    });

    it('canonicalizes Twitch VOD identity independently of query, fragment, and metadata', () => {
        const first = queueItem({
            url: 'https://www.twitch.tv/videos/1234567890?filter=archives#chapter',
            streamer: 'Streamer',
            date: '2026-01-01',
        });
        const second = queueItem({
            url: 'https://twitch.tv/videos/0001234567890',
            streamer: 'renamed',
            date: '2025-01-01',
        });

        expect(canonicalQueueItemIdentity(first)).toBe(canonicalQueueItemIdentity(second));
    });

    it('uses media clip coordinates but not filename metadata for custom clip identity', () => {
        const first = queueItem({
            customClip: { startSec: 10, durationSec: 20, startPart: 1, filenameFormat: 'simple' },
        });
        const renamed = queueItem({
            customClip: { startSec: 10, durationSec: 20, startPart: 1, filenameFormat: 'template', filenameTemplate: 'other' },
        });
        const differentRange = queueItem({
            customClip: { startSec: 11, durationSec: 20, startPart: 1, filenameFormat: 'simple' },
        });

        expect(canonicalQueueItemIdentity(first)).toBe(canonicalQueueItemIdentity(renamed));
        expect(canonicalQueueItemIdentity(first)).not.toBe(canonicalQueueItemIdentity(differentRange));
    });

    it('removes transient transfer state on non-active transitions', () => {
        const transitioned = clearQueueTransferState(queueItem({
            status: 'paused',
            progress: 42,
            speed: '12 MB/s',
            eta: '10s',
            progressStatus: 'Paused',
            downloadedBytes: 10,
            totalBytes: 20,
            recordingHealth: 'stale',
        }), 'pending', 0);

        expect(transitioned).toEqual(expect.objectContaining({ status: 'pending', progress: 0 }));
        expect(transitioned).not.toHaveProperty('speed');
        expect(transitioned).not.toHaveProperty('eta');
        expect(transitioned).not.toHaveProperty('progressStatus');
        expect(transitioned).not.toHaveProperty('downloadedBytes');
        expect(transitioned).not.toHaveProperty('totalBytes');
        expect(transitioned).not.toHaveProperty('recordingHealth');
    });

    it('atomically replaces stale transfer state with a retry countdown', () => {
        const item = queueItem({
            status: 'downloading',
            speed: '12 MB/s',
            eta: '10s',
            progressStatus: 'Downloading',
            recordingHealth: 'stale',
        });

        mergeQueueProgressState(item, {
            id: item.id,
            progress: -1,
            speed: '',
            eta: '',
            status: 'Retrying in 5 seconds',
        }, false);

        expect(item.speed).toBe('');
        expect(item.eta).toBe('');
        expect(item.progressStatus).toBe('Retrying in 5 seconds');
        expect(item).not.toHaveProperty('recordingHealth');
    });

    it('marks a live retry countdown as unknown instead of preserving stale health', () => {
        const item = queueItem({
            status: 'downloading',
            currentPart: 2,
            totalParts: 4,
            downloadedBytes: 10,
            totalBytes: 20,
            recordingHealth: 'stale',
        });

        const retryProgress = prepareQueueRetryProgress(item, 'Retrying in 5 seconds');
        expect(item.recordingHealth).toBe('unknown');
        expect(item).not.toHaveProperty('downloadedBytes');
        expect(item).not.toHaveProperty('totalBytes');
        mergeQueueProgressState(item, retryProgress, false);

        expect(retryProgress).toEqual({
            id: item.id,
            progress: -1,
            speed: '',
            eta: '',
            status: 'Retrying in 5 seconds',
            currentPart: 2,
            totalParts: 4,
            recordingHealth: 'unknown',
        });
        expect(item.recordingHealth).toBe('unknown');
        expect(item).not.toHaveProperty('downloadedBytes');
        expect(item).not.toHaveProperty('totalBytes');
    });

    it('does not overwrite pause-pending state with late process progress', () => {
        const item = queueItem({
            status: 'downloading',
            speed: '',
            eta: '',
            progressStatus: 'Pause pending',
        });

        mergeQueueProgressState(item, {
            id: item.id,
            progress: 75,
            speed: '12 MB/s',
            eta: '10s',
            status: 'Downloading',
            recordingHealth: 'stale',
        }, true);

        expect(item).toEqual(expect.objectContaining({
            progress: 0,
            speed: '',
            eta: '',
            progressStatus: 'Pause pending',
        }));
        expect(item).not.toHaveProperty('recordingHealth');
    });
});

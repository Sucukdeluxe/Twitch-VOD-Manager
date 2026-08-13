import { describe, expect, it } from 'vitest';
import { sanitizeConfigInput, sanitizeImportedConfig } from './config-input';

describe('sanitizeConfigInput', () => {
    it('keeps valid import fields while dropping unknown, invalid, and secret fields', () => {
        expect(sanitizeConfigInput({
            language: 'en',
            theme: 'system',
            download_mode: 'parts',
            part_minutes: 60,
            parallel_downloads: 2,
            streamers: [' Alice ', '@alice', 'bob_1', 'bad/name', '', 42],
            download_policy: {
                throttle: { maxBytesPerSecond: 500_000 },
                windows: [{ start: '22:00', end: '06:00' }],
                injected: true,
            },
            clientSecret: 'secret',
            refresh_token: 'refresh',
            unknown_setting: true,
        })).toEqual({
            language: 'en',
            theme: 'system',
            download_mode: 'parts',
            part_minutes: 60,
            parallel_downloads: 2,
            streamers: ['alice', 'bob_1'],
            download_policy: {
                throttle: { maxBytesPerSecond: 500_000 },
                windows: [{ start: '22:00', end: '06:00' }],
            },
        });
    });

    it('omits malformed known fields instead of replacing current settings with coerced values', () => {
        expect(sanitizeConfigInput({
            language: 'fr',
            theme: 'neon',
            download_mode: 'archive',
            part_minutes: '60',
            parallel_downloads: 3,
            streamers: 'alice',
            streamer_display_names: { alice: ' Alice ', 'bad/name': 'Bad', bob: 42 },
        })).toEqual({
            streamer_display_names: { alice: 'Alice' },
        });
    });

    it('normalizes bounded strings and rejects oversized or malformed persisted values', () => {
        expect(sanitizeConfigInput({
            client_id: '  abc_123  ',
            download_path: `C:\\${'a'.repeat(32767)}`,
            filename_template_vod: '{title}.mp4',
            filename_template_parts: 'x'.repeat(4097),
            downloaded_vod_ids: ['123', 'valid-id', 'bad/id', '', 'x'.repeat(129)],
        })).toEqual({
            client_id: 'abc_123',
            filename_template_vod: '{title}.mp4',
            downloaded_vod_ids: ['123', 'valid-id'],
        });
    });

    it('keeps the globally newest downloaded VOD ids when the history exceeds its limit', () => {
        const downloadedVodIds = Array.from({ length: 9000 }, (_, index) => `vod-${index}`);

        const sanitized = sanitizeConfigInput({ downloaded_vod_ids: downloadedVodIds });

        expect(sanitized.downloaded_vod_ids).toEqual(downloadedVodIds.slice(4904));
    });

    it('omits malformed policies but accepts an explicit unrestricted reset', () => {
        expect(sanitizeConfigInput({
            download_policy: { windows: 'invalid', throttle: null },
        })).toEqual({});
        expect(sanitizeConfigInput({
            download_policy: { throttle: null, windows: [] },
        })).toEqual({
            download_policy: { throttle: null, windows: [] },
        });
    });

    it('never imports a download path without a separately granted folder capability', () => {
        expect(sanitizeImportedConfig({
            download_path: 'C:\\',
            language: 'de',
        })).toEqual({ language: 'de' });
    });
});

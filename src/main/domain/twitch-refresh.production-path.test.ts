import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Twitch refresh production path', () => {
    it('deduplicates force and normal VOD refreshes and keeps a retained last-good value', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const start = source.indexOf('async function getVODs');
        const end = source.indexOf('interface LiveStreamInfo', start);
        const getVods = source.slice(start, end);

        expect(getVods).toContain("withInFlightDedup(inFlightVodRequests, cacheKey");
        expect(getVods).not.toContain("force' : 'default'");
        expect(getVods).toContain('vodListLastGood.get(cacheKey)');
        expect(getVods).toContain('requestTwitchHelixVideos(axios');
        expect(getVods).toContain('refreshTwitchProviderData(');
    });

    it('retains profiles outside their expiring cache and deletes an authoritative not-found profile', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const start = source.indexOf('async function getStreamerProfile');
        const end = source.indexOf('// ==========================================\n// VOD STORYBOARD', start);
        const getProfile = source.slice(start, end);

        expect(getProfile).toContain('streamerProfileLastGood.get(normalized)');
        expect(getProfile).toContain('streamerProfileLastGood.delete(normalized)');
        expect(getProfile).toContain('streamerProfileLastGood.set(normalized, profile)');
    });
});

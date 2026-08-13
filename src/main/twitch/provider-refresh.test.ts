import { describe, expect, it, vi } from 'vitest';
import { createTwitchProviderRefreshService, requestPublicTwitchGraphql, requestPublicTwitchVodsByLogin, requestTwitchHelixUsers, requestTwitchHelixVideos } from './provider-refresh';

describe('Twitch provider refresh product path', () => {
    it('requests and parses a public GraphQL data envelope', async () => {
        const post = vi.fn().mockResolvedValue({ data: { data: { user: { id: '42' } } } });

        await expect(requestPublicTwitchGraphql({ post }, 'query', { login: 'alice' }, 1200, 1))
            .resolves.toEqual({ status: 'success', value: { user: { id: '42' } } });
        expect(post).toHaveBeenCalledWith('https://gql.twitch.tv/gql', { query: 'query', variables: { login: 'alice' } }, {
            headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
            timeout: 1200,
        });
    });

    it('encapsulates the product VOD query and projects public rows', async () => {
        const post = vi.fn().mockResolvedValue({ data: { data: { user: { videos: { edges: [{ node: { id: '42', title: 'Archive', publishedAt: '2026-01-01T00:00:00Z', lengthSeconds: 3661, viewCount: 7, previewThumbnailURL: 'https://example.com/42.jpg' } }] } } } } });

        await expect(requestPublicTwitchVodsByLogin({ post }, 'alice', 1, 1200, 1)).resolves.toEqual({
            status: 'success',
            value: [{ id: '42', title: 'Archive', created_at: '2026-01-01T00:00:00Z', duration: '1h1m1s', thumbnail_url: 'https://example.com/42.jpg', url: 'https://www.twitch.tv/videos/42', view_count: 7, stream_id: '', user_login: 'alice' }],
        });
        expect(post.mock.calls[0][1].query).toContain('videos(first:$first, type:ARCHIVE, sort:TIME)');
        expect(post.mock.calls[0][1].variables).toEqual({ login: 'alice', first: 1 });
    });

    it.each([
        { lengthSeconds: null, viewCount: 7 },
        { lengthSeconds: '', viewCount: 7 },
        { lengthSeconds: 3661, viewCount: null },
        { lengthSeconds: 3661, viewCount: '7' },
    ])('rejects non-numeric public VOD metrics: %o', async ({ lengthSeconds, viewCount }) => {
        const post = vi.fn().mockResolvedValue({
            data: {
                data: {
                    user: {
                        videos: {
                            edges: [{ node: { id: '42', lengthSeconds, viewCount } }],
                        },
                    },
                },
            },
        });

        await expect(requestPublicTwitchVodsByLogin({ post }, 'alice', 1, 1200, 1))
            .resolves.toEqual({ status: 'unavailable' });
    });

    it('refreshes Helix after a 401, falls back to public, and retains last-good on provider outage', async () => {
        const publicValues = [
            { status: 'success' as const, value: [{ id: 'public-1' }] },
            { status: 'unavailable' as const },
        ];
        const helixValues = [
            { status: 'success' as const, value: [{ id: 'helix-1' }] },
            { status: 'unauthorized' as const },
            { status: 'unavailable' as const },
            { status: 'unavailable' as const },
        ];
        const refreshToken = vi.fn().mockResolvedValue(true);
        const service = createTwitchProviderRefreshService<{ id: string }>({
            requestPublic: vi.fn(async () => publicValues.shift() ?? { status: 'unavailable' as const }),
            requestHelix: vi.fn(async () => helixValues.shift() ?? { status: 'unavailable' as const }),
            refreshToken,
            maxLastGoodEntries: 4,
        });

        await expect(service.refresh('alice')).resolves.toEqual({ value: [{ id: 'helix-1' }], source: 'helix', stale: false });
        await expect(service.refresh('alice')).resolves.toEqual({ value: [{ id: 'public-1' }], source: 'public', stale: false });
        await expect(service.refresh('alice')).resolves.toEqual({ value: [{ id: 'public-1' }], source: 'last-good', stale: true });
        expect(refreshToken).toHaveBeenCalledOnce();
    });

    it('requests and validates Helix users and paginated archive videos', async () => {
        const get = vi.fn()
            .mockResolvedValueOnce({ data: { data: [{ id: '42', login: 'alice', display_name: 'Alice', description: '', profile_image_url: 'https://example.com/a.png', broadcaster_type: 'partner' }] } })
            .mockResolvedValueOnce({ data: { data: [{ id: '1', title: 'One', created_at: '2026-01-01T00:00:00Z', duration: '1h', thumbnail_url: '', url: 'https://www.twitch.tv/videos/1', view_count: 2, stream_id: '', user_login: 'alice' }], pagination: { cursor: 'next' } } })
            .mockResolvedValueOnce({ data: { data: [{ id: '2', title: 'Two', created_at: '2026-01-02T00:00:00Z', duration: '2h', thumbnail_url: '', url: 'https://www.twitch.tv/videos/2', view_count: 3, stream_id: '', user_login: 'alice' }], pagination: {} } });
        const auth = { clientId: 'client', accessToken: 'token' };

        await expect(requestTwitchHelixUsers({ get }, 'alice', auth, 1000)).resolves.toMatchObject({ status: 'success', value: [{ id: '42' }] });
        await expect(requestTwitchHelixVideos({ get }, '42', auth, 1000)).resolves.toMatchObject({ status: 'success', value: [{ id: '1' }, { id: '2' }] });
        expect(get).toHaveBeenNthCalledWith(3, 'https://api.twitch.tv/helix/videos', expect.objectContaining({ params: expect.objectContaining({ after: 'next' }) }));
    });

    it('reports Helix authorization expiry without projecting provider payloads', async () => {
        const get = vi.fn().mockRejectedValue({ response: { status: 401, data: { token: 'secret' } } });

        await expect(requestTwitchHelixUsers({ get }, 'alice', { clientId: 'client', accessToken: 'token' }, 1000))
            .resolves.toEqual({ status: 'unauthorized' });
    });
});

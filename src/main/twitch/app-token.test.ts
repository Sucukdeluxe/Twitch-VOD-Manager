import { describe, expect, it, vi } from 'vitest';
import { requestTwitchAppAccessToken, TwitchAppTokenService, type TwitchAppTokenCredentials } from './app-token';

function credentials(clientId = 'client-id', clientSecret = 'client-secret'): TwitchAppTokenCredentials {
    return { clientId, clientSecret };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, decline) => {
        resolve = accept;
        reject = decline;
    });
    return { promise, resolve, reject };
}

describe('TwitchAppTokenService', () => {
    it('caches a successful token for the active credentials', async () => {
        const requestToken = vi.fn().mockResolvedValue('token-one');
        const service = new TwitchAppTokenService(requestToken);

        expect(await service.ensure(credentials())).toBe('token-one');
        expect(await service.ensure(credentials())).toBe('token-one');
        expect(service.currentToken).toBe('token-one');
        expect(requestToken).toHaveBeenCalledTimes(1);
    });

    it('deduplicates parallel requests for the same credentials', async () => {
        const pending = deferred<string>();
        const requestToken = vi.fn().mockReturnValue(pending.promise);
        const service = new TwitchAppTokenService(requestToken);

        const first = service.ensure(credentials());
        const second = service.ensure(credentials());
        pending.resolve('shared-token');

        await expect(Promise.all([first, second])).resolves.toEqual(['shared-token', 'shared-token']);
        expect(requestToken).toHaveBeenCalledTimes(1);
    });

    it('refreshes a cached token once and deduplicates parallel forced refreshes', async () => {
        const refresh = deferred<string>();
        const requestToken = vi.fn()
            .mockResolvedValueOnce('token-one')
            .mockReturnValueOnce(refresh.promise);
        const service = new TwitchAppTokenService(requestToken);
        await service.ensure(credentials());

        const first = service.ensure(credentials(), true);
        const second = service.ensure(credentials(), true);
        refresh.resolve('token-two');

        await expect(Promise.all([first, second])).resolves.toEqual(['token-two', 'token-two']);
        expect(service.currentToken).toBe('token-two');
        expect(requestToken).toHaveBeenCalledTimes(2);
    });

    it('discards an in-flight token after clear', async () => {
        const stale = deferred<string>();
        const requestToken = vi.fn()
            .mockReturnValueOnce(stale.promise)
            .mockResolvedValueOnce('fresh-token');
        const service = new TwitchAppTokenService(requestToken);

        const first = service.ensure(credentials());
        service.clear();
        stale.resolve('stale-token');

        await expect(first).resolves.toBeNull();
        expect(service.currentToken).toBeNull();
        await expect(service.ensure(credentials())).resolves.toBe('fresh-token');
    });

    it('ignores an obsolete request error after clear', async () => {
        const stale = deferred<string>();
        const errors: unknown[] = [];
        const service = new TwitchAppTokenService(() => stale.promise, (error) => errors.push(error));

        const first = service.ensure(credentials());
        service.clear();
        stale.reject(new Error('obsolete request failed'));

        await expect(first).resolves.toBeNull();
        expect(errors).toEqual([]);
    });

    it('clears the cache and skips requests when credentials are missing', async () => {
        const requestToken = vi.fn().mockResolvedValue('token-one');
        const service = new TwitchAppTokenService(requestToken);
        await service.ensure(credentials());

        await expect(service.ensure(credentials('', ''))).resolves.toBeNull();
        expect(service.currentToken).toBeNull();
        expect(requestToken).toHaveBeenCalledTimes(1);
    });

    it('returns null and reports only a projected safe error', async () => {
        const errors: unknown[] = [];
        const requestToken = vi.fn().mockRejectedValue({
            name: 'AxiosError',
            isAxiosError: true,
            message: 'client_secret=provider-secret Authorization: Bearer provider-token',
            config: { params: { client_secret: 'provider-secret' } },
            response: { status: 401, data: { access_token: 'response-token' } },
        });
        const service = new TwitchAppTokenService(requestToken, (error) => errors.push(error));

        await expect(service.ensure(credentials())).resolves.toBeNull();
        expect(service.currentToken).toBeNull();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ provider: 'twitch-oauth', status: 401 });
        expect(JSON.stringify(errors[0])).not.toMatch(/provider-secret|provider-token|response-token|config|response/);
    });

    it('rejects malformed token responses without exposing them', async () => {
        const errors: unknown[] = [];
        const requestToken = vi.fn().mockResolvedValue('   ');
        const service = new TwitchAppTokenService(requestToken, (error) => errors.push(error));

        await expect(service.ensure(credentials())).resolves.toBeNull();
        expect(errors).toEqual([{
            provider: 'twitch-oauth',
            message: 'Twitch app token response was invalid',
        }]);
    });
});

describe('requestTwitchAppAccessToken', () => {
    it('uses the Twitch client-credentials endpoint and parses its token', async () => {
        const post = vi.fn().mockResolvedValue({ data: { access_token: ' live-token ' } });

        await expect(requestTwitchAppAccessToken({ post }, credentials(), 1234)).resolves.toBe('live-token');
        expect(post).toHaveBeenCalledWith('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: 'client-id',
                client_secret: 'client-secret',
                grant_type: 'client_credentials',
            },
            timeout: 1234,
        });
    });

    it('rejects malformed response envelopes', async () => {
        await expect(requestTwitchAppAccessToken({ post: vi.fn().mockResolvedValue({ data: {} }) }, credentials(), 1000))
            .rejects.toThrow('Twitch app token response was invalid');
    });
});

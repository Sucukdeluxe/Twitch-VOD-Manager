import { describe, expect, it } from 'vitest';
import { projectExternalError, sanitizeLogDetails } from './external-error';

describe('projectExternalError', () => {
    it('projects an Axios-shaped error without request config, response data, or credentials', () => {
        const error = {
            name: 'AxiosError',
            isAxiosError: true,
            message: 'Request failed: client_secret=oauth-secret Authorization: Bearer access-token',
            code: 'ERR_BAD_REQUEST',
            config: {
                params: { client_secret: 'oauth-secret' },
                headers: { Authorization: 'Bearer access-token', Cookie: 'session-cookie' },
            },
            response: {
                status: 401,
                data: { refreshToken: 'refresh-token', html: '<body>provider response</body>' },
            },
        };

        const projected = projectExternalError('twitch-oauth', error);
        const serialized = JSON.stringify(projected);

        expect(projected).toMatchObject({ provider: 'twitch-oauth', code: 'ERR_BAD_REQUEST', status: 401 });
        expect(projected.message).toContain('[REDACTED]');
        for (const forbidden of ['oauth-secret', 'access-token', 'session-cookie', 'refresh-token', 'config', 'headers', 'provider response']) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it('redacts URL userinfo and complete Discord webhook URLs from projected messages', () => {
        const authenticatedUrl = ['https://service-user', 'service-pass@example.test/private'].join(':');
        const webhookUrl = ['https://discord.com/api/webhooks', '123456789012345678', 'super-secret-webhook-token?wait=true'].join('/');
        const projected = projectExternalError('discord', new Error(
            `POST ${authenticatedUrl} failed for ${webhookUrl}`,
        ));

        expect(projected.message).toContain('example.test/private');
        expect(projected.message).not.toContain('service-user');
        expect(projected.message).not.toContain('service-pass');
        expect(projected.message).not.toContain('123456789012345678');
        expect(projected.message).not.toContain('super-secret-webhook-token');
        expect(projected.message).not.toContain('discord.com/api/webhooks');
        expect(projected.message).toContain('[REDACTED]');
    });

    it('only retains recognized operational error-code shapes', () => {
        const opaqueCredential = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyz'].join('_');
        const credentialShapedCode = ['ERR_AKIA', 'IOSFODNN7EXAMPLE'].join('');
        for (const code of ['AWS_SECRET_ACCESS_KEY', opaqueCredential, credentialShapedCode]) {
            const projected = projectExternalError('external', {
                name: 'AxiosError',
                message: 'Request failed',
                code,
            });

            expect(projected).toEqual({ provider: 'external', message: 'Request failed' });
        }
    });
});

describe('sanitizeLogDetails', () => {
    it('redacts nested secret variants, sensitive URL parameters, and cyclic Axios errors', () => {
        const axiosError: Record<string, unknown> = {
            name: 'AxiosError',
            isAxiosError: true,
            message: 'GET https://example.test/path?access_token=query-token failed',
            config: { headers: { Authorization: 'Bearer header-token' } },
            response: { status: 503 },
        };
        axiosError.self = axiosError;

        const sanitized = sanitizeLogDetails({
            error: axiosError,
            clientSecret: 'nested-secret',
            safe: 'visible',
            callbackUrl: 'https://example.test/callback?refresh_token=url-refresh&state=ok',
        });
        const serialized = JSON.stringify(sanitized);

        expect(sanitized).toMatchObject({ safe: 'visible' });
        for (const forbidden of ['query-token', 'header-token', 'nested-secret', 'url-refresh', 'Authorization', 'clientSecret']) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it('redacts secrets embedded as quoted JSON properties in error messages', () => {
        const sanitized = sanitizeLogDetails('{"refreshToken":"json-refresh","Authorization":"Bearer json-access","safe":"visible"}');

        expect(String(sanitized)).toContain('visible');
        expect(String(sanitized)).not.toContain('json-refresh');
        expect(String(sanitized)).not.toContain('json-access');
    });

    it('redacts encoded URL userinfo and legacy Discord webhook hosts in log strings', () => {
        const authenticatedUrl = ['https://encoded%2Duser', 'p%40ssword@example.test/path'].join(':');
        const webhookUrl = ['https://canary.discordapp.com/api/v10/webhooks', '987654321098765432', 'legacy-secret-token'].join('/');
        const sanitized = sanitizeLogDetails(`${authenticatedUrl} ${webhookUrl}`);
        const serialized = JSON.stringify(sanitized);

        for (const forbidden of ['encoded%2Duser', 'p%40ssword', '987654321098765432', 'legacy-secret-token', 'discordapp.com/api/v10/webhooks']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(serialized).toContain('example.test/path');
        expect(serialized).toContain('[REDACTED]');
    });

    it('redacts complete authorization and cookie header lines for every authentication scheme', () => {
        const sanitized = sanitizeLogDetails([
            'Authorization: Digest username="digest-user", nonce="digest-nonce", response="digest-response"',
            'Authorization: AWS4-HMAC-SHA256 Credential=aws-credential, SignedHeaders=host, Signature=aws-signature',
            'Authorization: Digest username="folded-user",',
            '  nonce="folded-nonce", response="folded-response"',
            '--multipart-boundary',
            'Cookie: session=browser-session; csrf=csrf-value',
            'X-Safe: visible',
        ].join('\r\n'));
        const serialized = JSON.stringify(sanitized);

        for (const forbidden of ['digest-user', 'digest-nonce', 'digest-response', 'aws-credential', 'aws-signature', 'folded-user', 'folded-nonce', 'folded-response', 'browser-session', 'csrf-value']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(serialized).toContain('multipart-boundary');
        expect(serialized).toContain('visible');
    });

    it('redacts complete authorization and cookie values from equals, tuple, and name-value representations', () => {
        const sanitized = sanitizeLogDetails({
            text: [
                'Authorization=Digest username="equals-user", nonce="equals-nonce", response="equals-response"',
                'Cookie=session=equals-session; csrf=equals-csrf',
            ].join('\n'),
            tuples: [
                ['Authorization', 'Digest username="tuple-user", nonce="tuple-nonce", response="tuple-response"'],
                ['Cookie', 'session=tuple-session; csrf=tuple-csrf'],
            ],
            header: {
                name: 'Authorization',
                value: 'AWS4-HMAC-SHA256 Credential=object-credential, SignedHeaders=host, Signature=object-signature',
            },
            safe: 'visible',
        });
        const serialized = JSON.stringify(sanitized);

        for (const forbidden of ['equals-user', 'equals-nonce', 'equals-response', 'equals-session', 'equals-csrf', 'tuple-user', 'tuple-nonce', 'tuple-response', 'tuple-session', 'tuple-csrf', 'object-credential', 'object-signature']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(serialized).toContain('visible');
    });

    it('redacts percent-encoded and escaped authenticated URLs and encoded Discord webhook paths', () => {
        const encodedUrl = encodeURIComponent(['https://encoded-user', 'encoded-pass@example.test/encoded'].join(':'));
        const escapedUrl = ['https:\\/\\/escaped-user', 'escaped-pass@example.test/escaped'].join(':');
        const webhookUrl = ['https://discord.com/api/%77ebhooks', '112233445566778899', 'encoded-webhook-secret'].join('/');
        const serialized = JSON.stringify(sanitizeLogDetails(`${encodedUrl} ${escapedUrl} ${webhookUrl}`));

        for (const forbidden of ['encoded-user', 'encoded-pass', 'escaped-user', 'escaped-pass', '112233445566778899', 'encoded-webhook-secret']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(serialized).toContain('example.test/encoded');
        expect(serialized).toContain('example.test/escaped');
    });

    it('redacts multiply encoded URLs, webhook paths, and unicode-escaped URL separators', () => {
        const authenticatedUrl = ['https://multi-user', 'multi-pass@example.test/multi?apiKey=multi-query'].join(':');
        const doublyEncodedUrl = encodeURIComponent(encodeURIComponent(authenticatedUrl));
        const doublyEncodedWebhook = ['https://discord.com/api/%2577ebhooks', '998877665544332211', 'double-webhook-secret'].join('/');
        const unicodeEscapedUrl = ['https:', '\\u002f', '\\u002f', 'unicode-user', 'unicode-pass@example.test/unicode'].join('').replace('unicode-userunicode-pass', 'unicode-user:unicode-pass');
        const serialized = JSON.stringify(sanitizeLogDetails(`${doublyEncodedUrl} ${doublyEncodedWebhook} ${unicodeEscapedUrl}`));

        for (const forbidden of ['multi-user', 'multi-pass', 'multi-query', '998877665544332211', 'double-webhook-secret', 'unicode-user', 'unicode-pass']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(serialized).toContain('example.test/multi');
        expect(serialized).toContain('example.test/unicode');
    });

    it('removes normalized nested credential keys without stripping descriptive counters and consent fields', () => {
        const sanitized = sanitizeLogDetails({
            nested: {
                'X-Api-Key': 'header-api-key',
                apiKey: 'camel-api-key',
                sessionId: 'private-session-id',
                credentials: { username: 'private-user', password: 'private-password' },
                notasecret: 'preserve-not-a-secret',
                tokenCount: 4,
                cookieConsent: true,
            },
        });
        const serialized = JSON.stringify(sanitized);

        for (const forbidden of ['header-api-key', 'camel-api-key', 'private-session-id', 'private-user', 'private-password']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(sanitized).toMatchObject({
            nested: {
                notasecret: 'preserve-not-a-secret',
                tokenCount: 4,
                cookieConsent: true,
            },
        });
    });

    it('removes percent-encoded nested credential keys', () => {
        const sanitized = sanitizeLogDetails({
            'X%2DApi%2DKey': 'encoded-api-key',
            'session%49d': 'encoded-session-id',
            'credent%69als': 'encoded-credentials',
            safe: 'visible',
        });
        const serialized = JSON.stringify(sanitized);

        for (const forbidden of ['encoded-api-key', 'encoded-session-id', 'encoded-credentials']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(sanitized).toMatchObject({ safe: 'visible' });
    });

    it('redacts percent-encoded credential keys in unstructured log text', () => {
        const serialized = JSON.stringify(sanitizeLogDetails('X%2DApi%2DKey=encoded-text-key safe=visible'));

        expect(serialized).not.toContain('encoded-text-key');
        expect(serialized).toContain('visible');
    });

    it('redacts complete values from escaped quoted JSON without leaking authentication suffixes', () => {
        const rawJson = JSON.stringify({
            Authorization: 'Digest username="escaped-user", nonce="escaped-nonce", response="escaped-response"',
            'X-Api-Key': 'escaped-api-key',
            safe: 'visible',
        });
        const escapedJson = JSON.stringify(rawJson).slice(1, -1);
        const serialized = JSON.stringify(sanitizeLogDetails(escapedJson));

        for (const forbidden of ['escaped-user', 'escaped-nonce', 'escaped-response', 'escaped-api-key']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(serialized).toContain('visible');
    });

    it('redacts direct serialized JSON values without leaking quoted authentication suffixes', () => {
        const serializedInput = JSON.stringify({
            Authorization: 'Digest username="direct-user", nonce="direct-nonce", response="direct-response"',
            safe: 'visible',
        });
        const serialized = JSON.stringify(sanitizeLogDetails(serializedInput));

        for (const forbidden of ['direct-user', 'direct-nonce', 'direct-response']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(serialized).toContain('visible');
    });

    it('redacts embedded serialized JSON values inside surrounding diagnostic text', () => {
        const embedded = JSON.stringify({
            Authorization: 'Digest username="embedded-user", nonce="embedded-nonce", response="embedded-response"',
            safe: 'visible',
        });
        const serialized = JSON.stringify(sanitizeLogDetails(`Provider failed with ${embedded} after retry`));

        for (const forbidden of ['embedded-user', 'embedded-nonce', 'embedded-response']) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(serialized).toContain('visible');
        expect(serialized).toContain('after retry');
    });

    it('preserves false-positive assignment names in unstructured log text', () => {
        const sanitized = sanitizeLogDetails('notasecret=visible tokenCount=4 cookieConsent=true');

        expect(sanitized).toBe('notasecret=visible tokenCount=4 cookieConsent=true');
    });
});

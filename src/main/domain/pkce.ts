import * as crypto from 'crypto';

/**
 * PKCE (Proof Key for Code Exchange) Helper fuer OAuth 2.1 Authorization Code Flow.
 * RFC 7636. Twitch unterstuetzt S256.
 */

export interface PkcePair {
    codeVerifier: string;   // 43-128 ASCII chars [A-Z a-z 0-9 - . _ ~]
    codeChallenge: string;  // base64url(sha256(codeVerifier))
    codeChallengeMethod: 'S256';
}

function base64url(buf: Buffer): string {
    return buf.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export function createPkcePair(): PkcePair {
    // 32 random bytes → 43-char base64url. Innerhalb der RFC-Range.
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    return {
        codeVerifier: verifier,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
    };
}

export function generateState(): string {
    // 16 random bytes als base64url-State-Parameter (CSRF-Schutz).
    return base64url(crypto.randomBytes(16));
}

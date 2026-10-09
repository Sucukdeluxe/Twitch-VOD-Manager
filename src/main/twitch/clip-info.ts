import { requestPublicTwitchGraphql, type TwitchGraphqlHttpClient } from './provider-refresh';
import type { RefreshOutcome } from '../domain/refresh-result';

export interface TwitchClipInfo {
    title: string;
    broadcaster_name: string;
}

export async function requestPublicClipInfo(client: TwitchGraphqlHttpClient, clipId: string, timeoutMs: number): Promise<RefreshOutcome<TwitchClipInfo>> {
    const outcome = await requestPublicTwitchGraphql<{ clip?: unknown }>(client,
        'query($slug: ID!) { clip(slug: $slug) { title broadcaster { login } } }', { slug: clipId }, timeoutMs);
    if (outcome.status !== 'success') return { status: 'unavailable' };
    if (outcome.value.clip === null) return { status: 'not-found' };
    if (!outcome.value.clip || typeof outcome.value.clip !== 'object') return { status: 'unavailable' };
    const clip = outcome.value.clip as Record<string, unknown>;
    const broadcaster = clip.broadcaster as Record<string, unknown> | null;
    if (typeof clip.title !== 'string' || !broadcaster || typeof broadcaster.login !== 'string') return { status: 'unavailable' };
    return { status: 'success', value: { title: clip.title, broadcaster_name: broadcaster.login } };
}

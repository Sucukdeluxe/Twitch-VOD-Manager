import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(join(__dirname, 'renderer-profile.ts'), 'utf8');

describe('renderer profile production paths', () => {
    it('invalidates an in-flight profile request when the active profile is hidden', () => {
        const from = source.indexOf('let activeProfileRequestId');
        const to = source.indexOf('function renderStreamerProfileSkeleton', from);
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeGreaterThan(from);
        const code = transpileModule(
            `${source.slice(from, to)}\nglobalThis.profilePath = { hideStreamerProfileHeader, getRequestId: () => activeProfileRequestId };`,
            { compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 } }
        ).outputText;
        const context = {
            document: { getElementById: () => null },
            Map,
            applyHtml: () => undefined
        } as Record<string, unknown>;
        runInNewContext(code, context);
        const profilePath = context.profilePath as { hideStreamerProfileHeader(): void; getRequestId(): number };

        expect(profilePath.getRequestId()).toBe(0);
        profilePath.hideStreamerProfileHeader();
        expect(profilePath.getRequestId()).toBe(1);
    });

    it.each(['unavailable', 'rejected'] as const)('keeps the last good profile visible when refresh is %s', async (outcome) => {
        const from = source.indexOf('async function loadStreamerProfile');
        const to = source.indexOf('async function fetchStreamerProfile', from);
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeGreaterThan(from);
        const code = transpileModule(
            `let activeProfileLogin = ''; let activeProfileRequestId = 0; const streamerProfileCache = globalThis.profileCache; ${source.slice(from, to)}\nglobalThis.profilePath = { loadStreamerProfile };`,
            { compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 } }
        ).outputText;
        const hide = vi.fn();
        const renderCard = vi.fn();
        const cachedProfile = { login: 'fixture-alpha', displayName: 'Fixture Alpha' };
        const context = {
            profileCache: new Map([['fixture-alpha', cachedProfile]]),
            hideStreamerProfileHeader: hide,
            renderStreamerProfileCard: renderCard,
            renderStreamerProfileSkeleton: vi.fn(),
            fetchStreamerProfile: outcome === 'unavailable'
                ? async () => null
                : async () => { throw new Error('offline'); },
            streamerProfilesMatch: () => true,
            window: {}
        } as Record<string, unknown>;
        runInNewContext(code, context);
        const profilePath = context.profilePath as { loadStreamerProfile(login: string, forceRefresh?: boolean): Promise<void> };

        await profilePath.loadStreamerProfile('fixture-alpha', true);

        expect(renderCard).toHaveBeenCalledWith(cachedProfile);
        expect(hide).not.toHaveBeenCalled();
    });
});

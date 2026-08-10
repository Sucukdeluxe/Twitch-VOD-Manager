import { describe, expect, test } from 'vitest';
import { getWindowsAppIdentity } from './app-identity';

describe('getWindowsAppIdentity', () => {
    test('trennt Hot-Dev von der veröffentlichten Windows-Identität', () => {
        expect(getWindowsAppIdentity(true)).toEqual({
            name: 'Twitch VOD Manager',
            appUserModelId: 'io.github.sucukdeluxe.twitch-vod-manager.development'
        });
        expect(getWindowsAppIdentity(false)).toEqual({
            name: 'Twitch VOD Manager',
            appUserModelId: 'io.github.sucukdeluxe.twitch-vod-manager'
        });
    });
});

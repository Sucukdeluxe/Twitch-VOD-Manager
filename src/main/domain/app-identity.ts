export interface WindowsAppIdentity {
    name: string;
    appUserModelId: string;
}

export function getWindowsAppIdentity(isDevelopment: boolean): WindowsAppIdentity {
    return {
        name: 'Twitch VOD Manager',
        appUserModelId: isDevelopment
            ? 'io.github.sucukdeluxe.twitch-vod-manager.development'
            : 'io.github.sucukdeluxe.twitch-vod-manager'
    };
}

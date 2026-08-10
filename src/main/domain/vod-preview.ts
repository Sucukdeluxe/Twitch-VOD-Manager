const TWITCH_VOD_THUMBNAIL_PATTERN = /thumb0-1920x1080\.jpg$/;

export function buildVodPreviewFrameUrls(thumbnailUrl: string): string[] {
    let parsed: URL;
    try {
        parsed = new URL(thumbnailUrl);
    } catch {
        return [];
    }

    if (parsed.protocol !== 'https:' || parsed.hostname !== 'static-cdn.jtvnw.net' || !TWITCH_VOD_THUMBNAIL_PATTERN.test(parsed.pathname)) {
        return [];
    }

    return [0, 1, 2, 3].map((index) => {
        const frameUrl = new URL(parsed.toString());
        frameUrl.pathname = frameUrl.pathname.replace('thumb0-1920x1080.jpg', `thumb${index}-1920x1080.jpg`);
        return frameUrl.toString();
    });
}

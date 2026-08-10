export interface CustomClip {
    startSec: number;
    durationSec: number;
    startPart: number;
    filenameFormat: 'simple' | 'timestamp' | 'template' | 'parts';
    filenameTemplate?: string;
}

export interface MergeGroupItem {
    url: string;
    title: string;
    date: string;
    streamer: string;
    duration_str: string;
}

export interface MergeGroup {
    items: MergeGroupItem[];
    mergePhase: 'downloading' | 'merging' | 'splitting' | 'cleanup' | 'done';
    currentItemIndex: number;
    downloadedFiles: Record<number, string>;
    mergedFile?: string;
    splitFiles?: string[];
    totalDurationSec?: number;
}

export interface QueueItem {
    id: string;
    title: string;
    url: string;
    date: string;
    streamer: string;
    duration_str: string;
    status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error';
    progress: number;
    currentPart?: number;
    totalParts?: number;
    speed?: string;
    eta?: string;
    downloadedBytes?: number;
    totalBytes?: number;
    progressStatus?: string;
    last_error?: string;
    customClip?: CustomClip;
    mergeGroup?: MergeGroup;
    // File paths produced by the download (single file for VOD/clip, multiple
    // for parts/merge-group splits). Persisted with the queue so completed
    // items keep their "Open file" / "Show in folder" actions across restarts.
    outputFiles?: string[];
    // Live stream recording — when true, item.url is the channel URL
    // (https://twitch.tv/{streamer}) and streamlink runs until the stream
    // ends instead of using --hls-start-offset / --hls-duration. The output
    // filename includes a timestamp so consecutive live recordings of the
    // same streamer don't collide.
    isLive?: boolean;
    // Live recording health snapshot. 'ok' means bytes are flowing within
    // the freshness window, 'stale' means the streamlink subprocess hasn't
    // pushed bytes recently (dropped segments, network blip, or stream just
    // ended), 'unknown' until the first progress event arrives. Only set
    // for in-flight live recordings; cleared when the recording finishes.
    recordingHealth?: 'ok' | 'stale' | 'unknown';
}

export interface DownloadProgress {
    id: string;
    progress: number;
    speed: string;
    speedBytesPerSec?: number;
    eta: string;
    status: string;
    currentPart?: number;
    totalParts?: number;
    downloadedBytes?: number;
    totalBytes?: number;
    recordingHealth?: 'ok' | 'stale' | 'unknown';
}

export interface DownloadResult {
    success: boolean;
    error?: string;
    outputFiles?: string[];
}

interface AppConfig {
    client_id?: string;
    client_secret?: string;
    download_path?: string;
    streamers?: string[];
    theme?: string;
    download_mode?: 'parts' | 'full';
    part_minutes?: number;
    [key: string]: unknown;
}

interface VOD {
    id: string;
    title: string;
    created_at: string;
    duration: string;
    thumbnail_url: string;
    url: string;
    view_count: number;
    stream_id?: string;
}

interface CustomClip {
    startSec: number;
    durationSec: number;
    startPart: number;
    filenameFormat: 'simple' | 'timestamp';
}

interface QueueItem {
    id: string;
    title: string;
    url: string;
    date: string;
    streamer: string;
    duration_str: string;
    status: 'pending' | 'downloading' | 'completed' | 'error';
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
}

interface DownloadProgress {
    id: string;
    progress: number;
    speed: string;
    eta: string;
    status: string;
    currentPart?: number;
    totalParts?: number;
    downloadedBytes?: number;
    totalBytes?: number;
}

interface VideoInfo {
    duration: number;
    width: number;
    height: number;
    fps: number;
}

interface ClipDialogData {
    url: string;
    title: string;
    date: string;
    streamer: string;
    duration: string;
}

interface UpdateInfo {
    version: string;
    releaseDate?: string;
}

interface UpdateDownloadProgress {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
}

interface ApiBridge {
    getConfig(): Promise<AppConfig>;
    saveConfig(config: Partial<AppConfig>): Promise<AppConfig>;
    login(): Promise<boolean>;
    getUserId(username: string): Promise<string | null>;
    getVODs(userId: string): Promise<VOD[]>;
    getQueue(): Promise<QueueItem[]>;
    addToQueue(item: Omit<QueueItem, 'id' | 'status' | 'progress'>): Promise<QueueItem[]>;
    removeFromQueue(id: string): Promise<QueueItem[]>;
    clearCompleted(): Promise<QueueItem[]>;
    startDownload(): Promise<boolean>;
    cancelDownload(): Promise<boolean>;
    isDownloading(): Promise<boolean>;
    downloadClip(url: string): Promise<{ success: boolean; error?: string }>;
    selectFolder(): Promise<string | null>;
    selectVideoFile(): Promise<string | null>;
    selectMultipleVideos(): Promise<string[] | null>;
    saveVideoDialog(defaultName: string): Promise<string | null>;
    openFolder(path: string): Promise<void>;
    getVideoInfo(filePath: string): Promise<VideoInfo | null>;
    extractFrame(filePath: string, timeSeconds: number): Promise<string | null>;
    cutVideo(inputFile: string, startTime: number, endTime: number): Promise<{ success: boolean; outputFile: string | null }>;
    mergeVideos(inputFiles: string[], outputFile: string): Promise<{ success: boolean; outputFile: string | null }>;
    getVersion(): Promise<string>;
    checkUpdate(): Promise<{ checking?: boolean; error?: boolean }>;
    downloadUpdate(): Promise<{ downloading?: boolean; error?: boolean }>;
    installUpdate(): Promise<void>;
    openExternal(url: string): Promise<void>;
    onDownloadProgress(callback: (progress: DownloadProgress) => void): void;
    onQueueUpdated(callback: (queue: QueueItem[]) => void): void;
    onDownloadStarted(callback: () => void): void;
    onDownloadFinished(callback: () => void): void;
    onCutProgress(callback: (percent: number) => void): void;
    onMergeProgress(callback: (percent: number) => void): void;
    onUpdateAvailable(callback: (info: UpdateInfo) => void): void;
    onUpdateDownloadProgress(callback: (progress: UpdateDownloadProgress) => void): void;
    onUpdateDownloaded(callback: (info: UpdateInfo) => void): void;
}

interface Window {
    api: ApiBridge;
}

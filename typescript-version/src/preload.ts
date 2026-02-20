import { contextBridge, ipcRenderer } from 'electron';

// Types
interface CustomClip {
    startSec: number;
    durationSec: number;
    startPart: number;
    filenameFormat: 'simple' | 'timestamp' | 'template';
    filenameTemplate?: string;
}

interface QueueItem {
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
    customClip?: CustomClip;
}

interface DownloadProgress {
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
}

interface RuntimeMetricsSnapshot {
    cacheHits: number;
    cacheMisses: number;
    duplicateSkips: number;
    retriesScheduled: number;
    retriesExhausted: number;
    integrityFailures: number;
    downloadsStarted: number;
    downloadsCompleted: number;
    downloadsFailed: number;
    downloadedBytesTotal: number;
    lastSpeedBytesPerSec: number;
    avgSpeedBytesPerSec: number;
    activeItemId: string | null;
    activeItemTitle: string | null;
    lastErrorClass: string | null;
    lastRetryDelaySeconds: number;
    timestamp: string;
    queue: {
        pending: number;
        downloading: number;
        paused: number;
        completed: number;
        error: number;
        total: number;
    };
    caches: {
        loginToUserId: number;
        vodList: number;
        clipInfo: number;
    };
    config: {
        performanceMode: 'stability' | 'balanced' | 'speed';
        smartScheduler: boolean;
        metadataCacheMinutes: number;
        duplicatePrevention: boolean;
    };
}

interface VideoInfo {
    duration: number;
    width: number;
    height: number;
    fps: number;
}

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('api', {
    // Config
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),

    // Auth
    login: () => ipcRenderer.invoke('login'),

    // Twitch API
    getUserId: (username: string) => ipcRenderer.invoke('get-user-id', username),
    getVODs: (userId: string, forceRefresh: boolean = false) => ipcRenderer.invoke('get-vods', userId, forceRefresh),

    // Queue
    getQueue: () => ipcRenderer.invoke('get-queue'),
    addToQueue: (item: Omit<QueueItem, 'id' | 'status' | 'progress'>) => ipcRenderer.invoke('add-to-queue', item),
    removeFromQueue: (id: string) => ipcRenderer.invoke('remove-from-queue', id),
    reorderQueue: (orderIds: string[]) => ipcRenderer.invoke('reorder-queue', orderIds),
    clearCompleted: () => ipcRenderer.invoke('clear-completed'),
    retryFailedDownloads: () => ipcRenderer.invoke('retry-failed-downloads'),

    // Download
    startDownload: () => ipcRenderer.invoke('start-download'),
    pauseDownload: () => ipcRenderer.invoke('pause-download'),
    cancelDownload: () => ipcRenderer.invoke('cancel-download'),
    isDownloading: () => ipcRenderer.invoke('is-downloading'),
    downloadClip: (url: string) => ipcRenderer.invoke('download-clip', url),

    // Files
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    selectVideoFile: () => ipcRenderer.invoke('select-video-file'),
    selectMultipleVideos: () => ipcRenderer.invoke('select-multiple-videos'),
    saveVideoDialog: (defaultName: string) => ipcRenderer.invoke('save-video-dialog', defaultName),
    openFolder: (path: string) => ipcRenderer.invoke('open-folder', path),

    // Video Cutter
    getVideoInfo: (filePath: string): Promise<VideoInfo | null> => ipcRenderer.invoke('get-video-info', filePath),
    extractFrame: (filePath: string, timeSeconds: number): Promise<string | null> => ipcRenderer.invoke('extract-frame', filePath, timeSeconds),
    cutVideo: (inputFile: string, startTime: number, endTime: number): Promise<{ success: boolean; outputFile: string | null }> =>
        ipcRenderer.invoke('cut-video', inputFile, startTime, endTime),

    // Merge Videos
    mergeVideos: (inputFiles: string[], outputFile: string): Promise<{ success: boolean; outputFile: string | null }> =>
        ipcRenderer.invoke('merge-videos', inputFiles, outputFile),

    // App
    getVersion: () => ipcRenderer.invoke('get-version'),
    checkUpdate: () => ipcRenderer.invoke('check-update'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
    runPreflight: (autoFix: boolean) => ipcRenderer.invoke('run-preflight', autoFix),
    getDebugLog: (lines: number) => ipcRenderer.invoke('get-debug-log', lines),
    getRuntimeMetrics: (): Promise<RuntimeMetricsSnapshot> => ipcRenderer.invoke('get-runtime-metrics'),
    exportRuntimeMetrics: (): Promise<{ success: boolean; cancelled?: boolean; error?: string; filePath?: string }> =>
        ipcRenderer.invoke('export-runtime-metrics'),

    // Events
    onDownloadProgress: (callback: (progress: DownloadProgress) => void) => {
        ipcRenderer.on('download-progress', (_, progress) => callback(progress));
    },
    onQueueUpdated: (callback: (queue: QueueItem[]) => void) => {
        ipcRenderer.on('queue-updated', (_, queue) => callback(queue));
    },
    onQueueDuplicateSkipped: (callback: (payload: { title: string; streamer: string; url: string }) => void) => {
        ipcRenderer.on('queue-duplicate-skipped', (_, payload) => callback(payload));
    },
    onDownloadStarted: (callback: () => void) => {
        ipcRenderer.on('download-started', () => callback());
    },
    onDownloadFinished: (callback: () => void) => {
        ipcRenderer.on('download-finished', () => callback());
    },
    onCutProgress: (callback: (percent: number) => void) => {
        ipcRenderer.on('cut-progress', (_, percent) => callback(percent));
    },
    onMergeProgress: (callback: (percent: number) => void) => {
        ipcRenderer.on('merge-progress', (_, percent) => callback(percent));
    },

    // Auto-Update Events
    onUpdateChecking: (callback: () => void) => {
        ipcRenderer.on('update-checking', () => callback());
    },
    onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string }) => void) => {
        ipcRenderer.on('update-available', (_, info) => callback(info));
    },
    onUpdateNotAvailable: (callback: () => void) => {
        ipcRenderer.on('update-not-available', () => callback());
    },
    onUpdateDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => {
        ipcRenderer.on('update-download-progress', (_, progress) => callback(progress));
    },
    onUpdateDownloaded: (callback: (info: { version: string }) => void) => {
        ipcRenderer.on('update-downloaded', (_, info) => callback(info));
    },
    onUpdateError: (callback: (payload: { message: string }) => void) => {
        ipcRenderer.on('update-error', (_, payload) => callback(payload));
    }
});

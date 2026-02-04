import { contextBridge, ipcRenderer } from 'electron';

// Types
interface QueueItem {
    id: string;
    title: string;
    url: string;
    date: string;
    streamer: string;
    duration_str: string;
    status: 'pending' | 'downloading' | 'completed' | 'error';
    progress: number;
}

interface DownloadProgress {
    id: string;
    progress: number;
    speed: string;
    eta: string;
    status: string;
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
    getVODs: (userId: string) => ipcRenderer.invoke('get-vods', userId),

    // Queue
    getQueue: () => ipcRenderer.invoke('get-queue'),
    addToQueue: (item: Omit<QueueItem, 'id' | 'status' | 'progress'>) => ipcRenderer.invoke('add-to-queue', item),
    removeFromQueue: (id: string) => ipcRenderer.invoke('remove-from-queue', id),
    clearCompleted: () => ipcRenderer.invoke('clear-completed'),

    // Download
    startDownload: () => ipcRenderer.invoke('start-download'),
    cancelDownload: () => ipcRenderer.invoke('cancel-download'),
    isDownloading: () => ipcRenderer.invoke('is-downloading'),
    downloadClip: (url: string) => ipcRenderer.invoke('download-clip', url),

    // Files
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    openFolder: (path: string) => ipcRenderer.invoke('open-folder', path),

    // App
    getVersion: () => ipcRenderer.invoke('get-version'),
    checkUpdate: () => ipcRenderer.invoke('check-update'),

    // Events
    onDownloadProgress: (callback: (progress: DownloadProgress) => void) => {
        ipcRenderer.on('download-progress', (_, progress) => callback(progress));
    },
    onQueueUpdated: (callback: (queue: QueueItem[]) => void) => {
        ipcRenderer.on('queue-updated', (_, queue) => callback(queue));
    },
    onDownloadStarted: (callback: () => void) => {
        ipcRenderer.on('download-started', () => callback());
    },
    onDownloadFinished: (callback: () => void) => {
        ipcRenderer.on('download-finished', () => callback());
    }
});

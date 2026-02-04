import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, execSync } from 'child_process';
import axios from 'axios';
import { autoUpdater } from 'electron-updater';

// ==========================================
// CONFIG & CONSTANTS
// ==========================================
const APP_VERSION = '3.5.3';
const UPDATE_CHECK_URL = 'http://24-music.de/version.json';

// Paths
const APPDATA_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Twitch_VOD_Manager');
const CONFIG_FILE = path.join(APPDATA_DIR, 'config.json');
const QUEUE_FILE = path.join(APPDATA_DIR, 'download_queue.json');
const DEFAULT_DOWNLOAD_PATH = path.join(app.getPath('desktop'), 'Twitch_VODs');

// Timeouts
const API_TIMEOUT = 10000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_SECONDS = 5;

// Ensure directories exist
if (!fs.existsSync(APPDATA_DIR)) {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
}

// ==========================================
// INTERFACES
// ==========================================
interface Config {
    client_id: string;
    client_secret: string;
    download_path: string;
    streamers: string[];
    theme: string;
    download_mode: 'parts' | 'full';
    part_minutes: number;
}

interface VOD {
    id: string;
    title: string;
    created_at: string;
    duration: string;
    thumbnail_url: string;
    url: string;
    view_count: number;
    stream_id: string;
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
}

interface DownloadProgress {
    id: string;
    progress: number;
    speed: string;
    eta: string;
    status: string;
}

// ==========================================
// CONFIG MANAGEMENT
// ==========================================
const defaultConfig: Config = {
    client_id: '',
    client_secret: '',
    download_path: DEFAULT_DOWNLOAD_PATH,
    streamers: [],
    theme: 'Twitch',
    download_mode: 'parts',
    part_minutes: 120
};

function loadConfig(): Config {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            return { ...defaultConfig, ...JSON.parse(data) };
        }
    } catch (e) {
        console.error('Error loading config:', e);
    }
    return defaultConfig;
}

function saveConfig(config: Config): void {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Error saving config:', e);
    }
}

// ==========================================
// QUEUE MANAGEMENT
// ==========================================
function loadQueue(): QueueItem[] {
    try {
        if (fs.existsSync(QUEUE_FILE)) {
            const data = fs.readFileSync(QUEUE_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error loading queue:', e);
    }
    return [];
}

function saveQueue(queue: QueueItem[]): void {
    try {
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
    } catch (e) {
        console.error('Error saving queue:', e);
    }
}

// ==========================================
// GLOBAL STATE
// ==========================================
let mainWindow: BrowserWindow | null = null;
let config = loadConfig();
let accessToken: string | null = null;
let downloadQueue: QueueItem[] = loadQueue();
let isDownloading = false;
let currentProcess: ChildProcess | null = null;
let currentDownloadCancelled = false;

// ==========================================
// STREAMLINK HELPER
// ==========================================
function getStreamlinkPath(): string {
    // Try to find streamlink in PATH
    try {
        if (process.platform === 'win32') {
            const result = execSync('where streamlink', { encoding: 'utf-8' });
            const paths = result.trim().split('\n');
            if (paths.length > 0) return paths[0].trim();
        } else {
            const result = execSync('which streamlink', { encoding: 'utf-8' });
            return result.trim();
        }
    } catch {
        // Streamlink not in PATH
    }

    // Common installation paths
    const commonPaths = [
        'C:\\Program Files\\Streamlink\\bin\\streamlink.exe',
        'C:\\Program Files (x86)\\Streamlink\\bin\\streamlink.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Streamlink', 'bin', 'streamlink.exe')
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }

    return 'streamlink'; // Fallback
}

// ==========================================
// DURATION HELPERS
// ==========================================
function parseDuration(duration: string): number {
    // Parse Twitch duration format like "3h45m20s"
    let seconds = 0;
    const hours = duration.match(/(\d+)h/);
    const minutes = duration.match(/(\d+)m/);
    const secs = duration.match(/(\d+)s/);

    if (hours) seconds += parseInt(hours[1]) * 3600;
    if (minutes) seconds += parseInt(minutes[1]) * 60;
    if (secs) seconds += parseInt(secs[1]);

    return seconds;
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ==========================================
// TWITCH API
// ==========================================
async function twitchLogin(): Promise<boolean> {
    if (!config.client_id || !config.client_secret) {
        return false;
    }

    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: config.client_id,
                client_secret: config.client_secret,
                grant_type: 'client_credentials'
            },
            timeout: API_TIMEOUT
        });
        accessToken = response.data.access_token;
        return true;
    } catch (e) {
        console.error('Login error:', e);
        return false;
    }
}

async function getUserId(username: string): Promise<string | null> {
    if (!accessToken) return null;

    try {
        const response = await axios.get('https://api.twitch.tv/helix/users', {
            params: { login: username },
            headers: {
                'Client-ID': config.client_id,
                'Authorization': `Bearer ${accessToken}`
            },
            timeout: API_TIMEOUT
        });
        return response.data.data[0]?.id || null;
    } catch (e) {
        console.error('Error getting user:', e);
        return null;
    }
}

async function getVODs(userId: string): Promise<VOD[]> {
    if (!accessToken) return [];

    try {
        const response = await axios.get('https://api.twitch.tv/helix/videos', {
            params: {
                user_id: userId,
                type: 'archive',
                first: 100
            },
            headers: {
                'Client-ID': config.client_id,
                'Authorization': `Bearer ${accessToken}`
            },
            timeout: API_TIMEOUT
        });
        return response.data.data;
    } catch (e) {
        console.error('Error getting VODs:', e);
        return [];
    }
}

async function getClipInfo(clipId: string): Promise<any | null> {
    if (!accessToken) return null;

    try {
        const response = await axios.get('https://api.twitch.tv/helix/clips', {
            params: { id: clipId },
            headers: {
                'Client-ID': config.client_id,
                'Authorization': `Bearer ${accessToken}`
            },
            timeout: API_TIMEOUT
        });
        return response.data.data[0] || null;
    } catch (e) {
        console.error('Error getting clip:', e);
        return null;
    }
}

// ==========================================
// DOWNLOAD FUNCTIONS
// ==========================================
function downloadVOD(item: QueueItem, onProgress: (progress: DownloadProgress) => void): Promise<boolean> {
    return new Promise((resolve) => {
        const streamer = item.streamer.replace(/[^a-zA-Z0-9_-]/g, '');
        const date = new Date(item.date);
        const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;

        const folder = path.join(config.download_path, streamer, dateStr);
        fs.mkdirSync(folder, { recursive: true });

        const safeTitle = item.title.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 50);
        const filename = path.join(folder, `${safeTitle}.mp4`);

        const streamlinkPath = getStreamlinkPath();
        const args = [
            item.url,
            'best',
            '-o', filename,
            '--force',
            '--progress', 'force'
        ];

        console.log('Starting download:', streamlinkPath, args);

        const proc = spawn(streamlinkPath, args, {
            windowsHide: true
        });

        currentProcess = proc;
        let lastProgress = 0;

        proc.stdout?.on('data', (data: Buffer) => {
            const line = data.toString();
            console.log('Streamlink:', line);

            // Parse progress from streamlink output
            const match = line.match(/(\d+\.\d+)%/);
            if (match) {
                lastProgress = parseFloat(match[1]);
                onProgress({
                    id: item.id,
                    progress: lastProgress,
                    speed: '',
                    eta: '',
                    status: `Downloading: ${lastProgress.toFixed(1)}%`
                });
            }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            console.error('Streamlink error:', data.toString());
        });

        proc.on('close', (code) => {
            currentProcess = null;

            if (currentDownloadCancelled) {
                resolve(false);
                return;
            }

            if (code === 0 && fs.existsSync(filename)) {
                const stats = fs.statSync(filename);
                if (stats.size > 1024 * 1024) { // At least 1MB
                    onProgress({
                        id: item.id,
                        progress: 100,
                        speed: '',
                        eta: '',
                        status: 'Completed'
                    });
                    resolve(true);
                    return;
                }
            }

            resolve(false);
        });

        proc.on('error', (err) => {
            console.error('Process error:', err);
            currentProcess = null;
            resolve(false);
        });
    });
}

async function processQueue(): Promise<void> {
    if (isDownloading || downloadQueue.length === 0) return;

    isDownloading = true;
    mainWindow?.webContents.send('download-started');

    for (const item of downloadQueue) {
        if (!isDownloading) break;
        if (item.status === 'completed') continue;

        currentDownloadCancelled = false;
        item.status = 'downloading';
        mainWindow?.webContents.send('queue-updated', downloadQueue);

        const success = await downloadVOD(item, (progress) => {
            mainWindow?.webContents.send('download-progress', progress);
        });

        item.status = success ? 'completed' : 'error';
        item.progress = success ? 100 : 0;
        saveQueue(downloadQueue);
        mainWindow?.webContents.send('queue-updated', downloadQueue);
    }

    isDownloading = false;
    mainWindow?.webContents.send('download-finished');
}

// ==========================================
// WINDOW CREATION
// ==========================================
function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1200,
        minHeight: 700,
        title: `Twitch VOD Manager [v${APP_VERSION}]`,
        backgroundColor: '#0e0e10',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../src/index.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Check for updates on startup
    setTimeout(() => {
        checkForUpdates();
    }, 3000);
}

async function checkForUpdates(): Promise<{ hasUpdate: boolean; version?: string; changelog?: string; downloadUrl?: string }> {
    try {
        const response = await axios.get(UPDATE_CHECK_URL, { timeout: 5000 });
        const latest = response.data.version;

        if (latest !== APP_VERSION.replace('v', '')) {
            return {
                hasUpdate: true,
                version: latest,
                changelog: response.data.changelog,
                downloadUrl: response.data.download_url
            };
        }
    } catch (e) {
        console.error('Update check failed:', e);
    }
    return { hasUpdate: false };
}

// ==========================================
// IPC HANDLERS
// ==========================================
ipcMain.handle('get-config', () => config);

ipcMain.handle('save-config', (_, newConfig: Partial<Config>) => {
    config = { ...config, ...newConfig };
    saveConfig(config);
    return config;
});

ipcMain.handle('login', async () => {
    return await twitchLogin();
});

ipcMain.handle('get-user-id', async (_, username: string) => {
    return await getUserId(username);
});

ipcMain.handle('get-vods', async (_, userId: string) => {
    return await getVODs(userId);
});

ipcMain.handle('get-queue', () => downloadQueue);

ipcMain.handle('add-to-queue', (_, item: Omit<QueueItem, 'id' | 'status' | 'progress'>) => {
    const queueItem: QueueItem = {
        ...item,
        id: Date.now().toString(),
        status: 'pending',
        progress: 0
    };
    downloadQueue.push(queueItem);
    saveQueue(downloadQueue);
    return downloadQueue;
});

ipcMain.handle('remove-from-queue', (_, id: string) => {
    downloadQueue = downloadQueue.filter(item => item.id !== id);
    saveQueue(downloadQueue);
    return downloadQueue;
});

ipcMain.handle('clear-completed', () => {
    downloadQueue = downloadQueue.filter(item => item.status !== 'completed');
    saveQueue(downloadQueue);
    return downloadQueue;
});

ipcMain.handle('start-download', async () => {
    processQueue();
    return true;
});

ipcMain.handle('cancel-download', () => {
    isDownloading = false;
    currentDownloadCancelled = true;
    if (currentProcess) {
        currentProcess.kill();
    }
    return true;
});

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory']
    });
    return result.filePaths[0] || null;
});

ipcMain.handle('open-folder', (_, folderPath: string) => {
    if (fs.existsSync(folderPath)) {
        shell.openPath(folderPath);
    }
});

ipcMain.handle('get-version', () => APP_VERSION);

ipcMain.handle('check-update', async () => {
    return await checkForUpdates();
});

ipcMain.handle('download-clip', async (_, clipUrl: string) => {
    // Extract clip ID from URL
    let clipId = '';
    const match1 = clipUrl.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/);
    const match2 = clipUrl.match(/twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9_-]+)/);

    if (match1) clipId = match1[1];
    else if (match2) clipId = match2[1];
    else return { success: false, error: 'Invalid clip URL' };

    const clipInfo = await getClipInfo(clipId);
    if (!clipInfo) return { success: false, error: 'Clip not found' };

    const folder = path.join(config.download_path, 'Clips', clipInfo.broadcaster_name);
    fs.mkdirSync(folder, { recursive: true });

    const safeTitle = clipInfo.title.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 50);
    const filename = path.join(folder, `${safeTitle}.mp4`);

    return new Promise((resolve) => {
        const streamlinkPath = getStreamlinkPath();
        const proc = spawn(streamlinkPath, [
            `https://clips.twitch.tv/${clipId}`,
            'best',
            '-o', filename,
            '--force'
        ], { windowsHide: true });

        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(filename)) {
                resolve({ success: true, filename });
            } else {
                resolve({ success: false, error: 'Download failed' });
            }
        });

        proc.on('error', () => {
            resolve({ success: false, error: 'Streamlink not found' });
        });
    });
});

ipcMain.handle('is-downloading', () => isDownloading);

// ==========================================
// APP LIFECYCLE
// ==========================================
app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (currentProcess) {
        currentProcess.kill();
    }
    saveQueue(downloadQueue);

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

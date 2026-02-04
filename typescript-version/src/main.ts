import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, execSync, exec } from 'child_process';
import axios from 'axios';
import { autoUpdater } from 'electron-updater';

// ==========================================
// CONFIG & CONSTANTS
// ==========================================
const APP_VERSION = '3.7.0';
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

// ==========================================
// CONFIG MANAGEMENT
// ==========================================
const defaultConfig: Config = {
    client_id: '',
    client_secret: '',
    download_path: DEFAULT_DOWNLOAD_PATH,
    streamers: [],
    theme: 'twitch',
    download_mode: 'full',
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
let downloadStartTime = 0;
let downloadedBytes = 0;

// ==========================================
// TOOL PATHS
// ==========================================
function getStreamlinkPath(): string {
    try {
        if (process.platform === 'win32') {
            const result = execSync('where streamlink', { encoding: 'utf-8' });
            const paths = result.trim().split('\n');
            if (paths.length > 0) return paths[0].trim();
        } else {
            const result = execSync('which streamlink', { encoding: 'utf-8' });
            return result.trim();
        }
    } catch { }

    const commonPaths = [
        'C:\\Program Files\\Streamlink\\bin\\streamlink.exe',
        'C:\\Program Files (x86)\\Streamlink\\bin\\streamlink.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Streamlink', 'bin', 'streamlink.exe')
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }

    return 'streamlink';
}

function getFFmpegPath(): string {
    try {
        if (process.platform === 'win32') {
            const result = execSync('where ffmpeg', { encoding: 'utf-8' });
            const paths = result.trim().split('\n');
            if (paths.length > 0) return paths[0].trim();
        } else {
            const result = execSync('which ffmpeg', { encoding: 'utf-8' });
            return result.trim();
        }
    } catch { }

    const commonPaths = [
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe')
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }

    return 'ffmpeg';
}

function getFFprobePath(): string {
    const ffmpegPath = getFFmpegPath();
    return ffmpegPath.replace('ffmpeg.exe', 'ffprobe.exe').replace('ffmpeg', 'ffprobe');
}

// ==========================================
// DURATION HELPERS
// ==========================================
function parseDuration(duration: string): number {
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
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
    if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

function formatETA(seconds: number): string {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
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
// VIDEO INFO (for cutter)
// ==========================================
async function getVideoInfo(filePath: string): Promise<VideoInfo | null> {
    return new Promise((resolve) => {
        const ffprobe = getFFprobePath();
        const args = [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath
        ];

        const proc = spawn(ffprobe, args, { windowsHide: true });
        let output = '';

        proc.stdout?.on('data', (data) => {
            output += data.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                resolve(null);
                return;
            }

            try {
                const info = JSON.parse(output);
                const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');

                resolve({
                    duration: parseFloat(info.format?.duration || '0'),
                    width: videoStream?.width || 0,
                    height: videoStream?.height || 0,
                    fps: eval(videoStream?.r_frame_rate || '30') || 30
                });
            } catch {
                resolve(null);
            }
        });

        proc.on('error', () => resolve(null));
    });
}

// ==========================================
// VIDEO CUTTER
// ==========================================
async function extractFrame(filePath: string, timeSeconds: number): Promise<string | null> {
    return new Promise((resolve) => {
        const ffmpeg = getFFmpegPath();
        const tempFile = path.join(app.getPath('temp'), `frame_${Date.now()}.jpg`);

        const args = [
            '-ss', timeSeconds.toString(),
            '-i', filePath,
            '-vframes', '1',
            '-q:v', '2',
            '-y',
            tempFile
        ];

        const proc = spawn(ffmpeg, args, { windowsHide: true });

        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(tempFile)) {
                const imageData = fs.readFileSync(tempFile);
                const base64 = `data:image/jpeg;base64,${imageData.toString('base64')}`;
                fs.unlinkSync(tempFile);
                resolve(base64);
            } else {
                resolve(null);
            }
        });

        proc.on('error', () => resolve(null));
    });
}

async function cutVideo(
    inputFile: string,
    outputFile: string,
    startTime: number,
    endTime: number,
    onProgress: (percent: number) => void
): Promise<boolean> {
    return new Promise((resolve) => {
        const ffmpeg = getFFmpegPath();
        const duration = endTime - startTime;

        const args = [
            '-ss', formatDuration(startTime),
            '-i', inputFile,
            '-t', formatDuration(duration),
            '-c', 'copy',
            '-progress', 'pipe:1',
            '-y',
            outputFile
        ];

        const proc = spawn(ffmpeg, args, { windowsHide: true });
        currentProcess = proc;

        proc.stdout?.on('data', (data) => {
            const line = data.toString();
            const match = line.match(/out_time_us=(\d+)/);
            if (match) {
                const currentUs = parseInt(match[1]);
                const percent = Math.min(100, (currentUs / 1000000) / duration * 100);
                onProgress(percent);
            }
        });

        proc.on('close', (code) => {
            currentProcess = null;
            resolve(code === 0 && fs.existsSync(outputFile));
        });

        proc.on('error', () => {
            currentProcess = null;
            resolve(false);
        });
    });
}

// ==========================================
// MERGE VIDEOS
// ==========================================
async function mergeVideos(
    inputFiles: string[],
    outputFile: string,
    onProgress: (percent: number) => void
): Promise<boolean> {
    return new Promise((resolve) => {
        const ffmpeg = getFFmpegPath();

        // Create concat file
        const concatFile = path.join(app.getPath('temp'), `concat_${Date.now()}.txt`);
        const concatContent = inputFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(concatFile, concatContent);

        const args = [
            '-f', 'concat',
            '-safe', '0',
            '-i', concatFile,
            '-c', 'copy',
            '-progress', 'pipe:1',
            '-y',
            outputFile
        ];

        const proc = spawn(ffmpeg, args, { windowsHide: true });
        currentProcess = proc;

        // Get total duration for progress
        let totalDuration = 0;
        for (const file of inputFiles) {
            try {
                const stats = fs.statSync(file);
                totalDuration += stats.size; // Approximate by file size
            } catch { }
        }

        proc.stdout?.on('data', (data) => {
            const line = data.toString();
            const match = line.match(/out_time_us=(\d+)/);
            if (match) {
                const currentUs = parseInt(match[1]);
                // Approximate progress
                onProgress(Math.min(99, currentUs / 10000000));
            }
        });

        proc.on('close', (code) => {
            currentProcess = null;
            try {
                fs.unlinkSync(concatFile);
            } catch { }

            if (code === 0 && fs.existsSync(outputFile)) {
                onProgress(100);
                resolve(true);
            } else {
                resolve(false);
            }
        });

        proc.on('error', () => {
            currentProcess = null;
            resolve(false);
        });
    });
}

// ==========================================
// DOWNLOAD FUNCTIONS
// ==========================================
function downloadVODPart(
    url: string,
    filename: string,
    startTime: string | null,
    endTime: string | null,
    onProgress: (progress: DownloadProgress) => void,
    itemId: string,
    partNum: number,
    totalParts: number
): Promise<boolean> {
    return new Promise((resolve) => {
        const streamlinkPath = getStreamlinkPath();
        const args = [url, 'best', '-o', filename, '--force'];

        if (startTime) {
            args.push('--hls-start-offset', startTime);
        }
        if (endTime) {
            args.push('--hls-duration', endTime);
        }

        console.log('Starting download:', streamlinkPath, args);

        const proc = spawn(streamlinkPath, args, { windowsHide: true });
        currentProcess = proc;

        downloadStartTime = Date.now();
        downloadedBytes = 0;
        let lastBytes = 0;
        let lastTime = Date.now();

        // Monitor file size for progress
        const progressInterval = setInterval(() => {
            if (fs.existsSync(filename)) {
                try {
                    const stats = fs.statSync(filename);
                    downloadedBytes = stats.size;

                    const now = Date.now();
                    const timeDiff = (now - lastTime) / 1000;
                    const bytesDiff = downloadedBytes - lastBytes;
                    const speed = timeDiff > 0 ? bytesDiff / timeDiff : 0;

                    lastBytes = downloadedBytes;
                    lastTime = now;

                    onProgress({
                        id: itemId,
                        progress: -1, // Unknown total
                        speed: formatSpeed(speed),
                        eta: '',
                        status: `Part ${partNum}/${totalParts}: ${formatBytes(downloadedBytes)}`,
                        currentPart: partNum,
                        totalParts: totalParts,
                        downloadedBytes: downloadedBytes
                    });
                } catch { }
            }
        }, 1000);

        proc.stdout?.on('data', (data: Buffer) => {
            const line = data.toString();
            console.log('Streamlink:', line);

            // Parse progress
            const match = line.match(/(\d+\.\d+)%/);
            if (match) {
                const percent = parseFloat(match[1]);
                onProgress({
                    id: itemId,
                    progress: percent,
                    speed: '',
                    eta: '',
                    status: `Part ${partNum}/${totalParts}: ${percent.toFixed(1)}%`,
                    currentPart: partNum,
                    totalParts: totalParts
                });
            }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            console.error('Streamlink error:', data.toString());
        });

        proc.on('close', (code) => {
            clearInterval(progressInterval);
            currentProcess = null;

            if (currentDownloadCancelled) {
                resolve(false);
                return;
            }

            if (code === 0 && fs.existsSync(filename)) {
                const stats = fs.statSync(filename);
                if (stats.size > 1024 * 1024) {
                    resolve(true);
                    return;
                }
            }

            resolve(false);
        });

        proc.on('error', (err) => {
            clearInterval(progressInterval);
            console.error('Process error:', err);
            currentProcess = null;
            resolve(false);
        });
    });
}

async function downloadVOD(
    item: QueueItem,
    onProgress: (progress: DownloadProgress) => void
): Promise<boolean> {
    const streamer = item.streamer.replace(/[^a-zA-Z0-9_-]/g, '');
    const date = new Date(item.date);
    const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;

    const folder = path.join(config.download_path, streamer, dateStr);
    fs.mkdirSync(folder, { recursive: true });

    const safeTitle = item.title.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 50);
    const totalDuration = parseDuration(item.duration_str);

    // Custom Clip - download specific time range
    if (item.customClip) {
        const clip = item.customClip;
        const partDuration = config.part_minutes * 60;

        // Helper to generate filename based on format
        const makeClipFilename = (partNum: number, startOffset: number): string => {
            if (clip.filenameFormat === 'timestamp') {
                const h = Math.floor(startOffset / 3600);
                const m = Math.floor((startOffset % 3600) / 60);
                const s = Math.floor(startOffset % 60);
                const timeStr = `${h.toString().padStart(2, '0')}-${m.toString().padStart(2, '0')}-${s.toString().padStart(2, '0')}`;
                return path.join(folder, `${dateStr}_CLIP_${timeStr}_${partNum}.mp4`);
            } else {
                return path.join(folder, `${dateStr}_${partNum}.mp4`);
            }
        };

        // If clip is longer than part duration, split into parts
        if (clip.durationSec > partDuration) {
            const numParts = Math.ceil(clip.durationSec / partDuration);
            const downloadedFiles: string[] = [];

            for (let i = 0; i < numParts; i++) {
                if (currentDownloadCancelled) break;

                const partNum = clip.startPart + i;
                const startOffset = clip.startSec + (i * partDuration);
                const remainingDuration = clip.durationSec - (i * partDuration);
                const thisDuration = Math.min(partDuration, remainingDuration);

                const partFilename = makeClipFilename(partNum, startOffset);

                const success = await downloadVODPart(
                    item.url,
                    partFilename,
                    formatDuration(startOffset),
                    formatDuration(thisDuration),
                    onProgress,
                    item.id,
                    i + 1,
                    numParts
                );

                if (!success) return false;
                downloadedFiles.push(partFilename);
            }

            return downloadedFiles.length === numParts;
        } else {
            // Single clip file
            const filename = makeClipFilename(clip.startPart, clip.startSec);
            return await downloadVODPart(
                item.url,
                filename,
                formatDuration(clip.startSec),
                formatDuration(clip.durationSec),
                onProgress,
                item.id,
                1,
                1
            );
        }
    }

    // Check download mode
    if (config.download_mode === 'full' || totalDuration <= config.part_minutes * 60) {
        // Full download
        const filename = path.join(folder, `${safeTitle}.mp4`);
        return await downloadVODPart(item.url, filename, null, null, onProgress, item.id, 1, 1);
    } else {
        // Part-based download
        const partDuration = config.part_minutes * 60;
        const numParts = Math.ceil(totalDuration / partDuration);
        const downloadedFiles: string[] = [];

        for (let i = 0; i < numParts; i++) {
            if (currentDownloadCancelled) break;

            const startSec = i * partDuration;
            const endSec = Math.min((i + 1) * partDuration, totalDuration);
            const duration = endSec - startSec;

            const partFilename = path.join(folder, `${dateStr}_Part${(i + 1).toString().padStart(2, '0')}.mp4`);

            const success = await downloadVODPart(
                item.url,
                partFilename,
                formatDuration(startSec),
                formatDuration(duration),
                onProgress,
                item.id,
                i + 1,
                numParts
            );

            if (!success) {
                return false;
            }

            downloadedFiles.push(partFilename);
        }

        return downloadedFiles.length === numParts;
    }
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

    // Setup auto-updater after window is ready
    setTimeout(() => {
        setupAutoUpdater();
    }, 3000);
}

// ==========================================
// AUTO-UPDATER (electron-updater)
// ==========================================
function setupAutoUpdater() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        console.log('Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
        console.log('Update available:', info.version);
        if (mainWindow) {
            mainWindow.webContents.send('update-available', {
                version: info.version,
                releaseDate: info.releaseDate
            });
        }
    });

    autoUpdater.on('update-not-available', () => {
        console.log('No updates available');
    });

    autoUpdater.on('download-progress', (progress) => {
        console.log(`Download progress: ${progress.percent.toFixed(1)}%`);
        if (mainWindow) {
            mainWindow.webContents.send('update-download-progress', {
                percent: progress.percent,
                bytesPerSecond: progress.bytesPerSecond,
                transferred: progress.transferred,
                total: progress.total
            });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('Update downloaded:', info.version);
        if (mainWindow) {
            mainWindow.webContents.send('update-downloaded', {
                version: info.version
            });
        }
    });

    autoUpdater.on('error', (err) => {
        console.error('Auto-updater error:', err);
    });

    // Check for updates
    autoUpdater.checkForUpdates().catch(err => {
        console.error('Update check failed:', err);
    });
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

ipcMain.handle('select-video-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile'],
        filters: [
            { name: 'Video Files', extensions: ['mp4', 'mkv', 'ts', 'mov', 'avi'] }
        ]
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
    try {
        const result = await autoUpdater.checkForUpdates();
        return { checking: true };
    } catch (err) {
        console.error('Update check failed:', err);
        return { error: true };
    }
});

ipcMain.handle('download-update', async () => {
    try {
        await autoUpdater.downloadUpdate();
        return { downloading: true };
    } catch (err) {
        console.error('Download failed:', err);
        return { error: true };
    }
});

ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('open-external', async (_, url: string) => {
    await shell.openExternal(url);
});

ipcMain.handle('download-clip', async (_, clipUrl: string) => {
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

// Video Cutter IPC
ipcMain.handle('get-video-info', async (_, filePath: string) => {
    return await getVideoInfo(filePath);
});

ipcMain.handle('extract-frame', async (_, filePath: string, timeSeconds: number) => {
    return await extractFrame(filePath, timeSeconds);
});

ipcMain.handle('cut-video', async (_, inputFile: string, startTime: number, endTime: number) => {
    const dir = path.dirname(inputFile);
    const baseName = path.basename(inputFile, path.extname(inputFile));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(11, 19);
    const outputFile = path.join(dir, `${baseName}_cut_${timestamp}.mp4`);

    let lastProgress = 0;
    const success = await cutVideo(inputFile, outputFile, startTime, endTime, (percent) => {
        lastProgress = percent;
        mainWindow?.webContents.send('cut-progress', percent);
    });

    return { success, outputFile: success ? outputFile : null };
});

// Merge IPC
ipcMain.handle('merge-videos', async (_, inputFiles: string[], outputFile: string) => {
    const success = await mergeVideos(inputFiles, outputFile, (percent) => {
        mainWindow?.webContents.send('merge-progress', percent);
    });

    return { success, outputFile: success ? outputFile : null };
});

ipcMain.handle('select-multiple-videos', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Video Files', extensions: ['mp4', 'mkv', 'ts', 'mov', 'avi'] }
        ]
    });
    return result.filePaths;
});

ipcMain.handle('save-video-dialog', async (_, defaultName: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: defaultName,
        filters: [
            { name: 'MP4 Video', extensions: ['mp4'] }
        ]
    });
    return result.filePath || null;
});

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

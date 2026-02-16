import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, execSync, exec, spawnSync } from 'child_process';
import axios from 'axios';
import { autoUpdater } from 'electron-updater';

// ==========================================
// CONFIG & CONSTANTS
// ==========================================
const APP_VERSION = '4.0.8';
const UPDATE_CHECK_URL = 'http://24-music.de/version.json';

// Paths
const APPDATA_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Twitch_VOD_Manager');
const CONFIG_FILE = path.join(APPDATA_DIR, 'config.json');
const QUEUE_FILE = path.join(APPDATA_DIR, 'download_queue.json');
const DEBUG_LOG_FILE = path.join(APPDATA_DIR, 'debug.log');
const TOOLS_DIR = path.join(APPDATA_DIR, 'tools');
const TOOLS_STREAMLINK_DIR = path.join(TOOLS_DIR, 'streamlink');
const TOOLS_FFMPEG_DIR = path.join(TOOLS_DIR, 'ffmpeg');
const DEFAULT_DOWNLOAD_PATH = path.join(app.getPath('desktop'), 'Twitch_VODs');
const DEFAULT_FILENAME_TEMPLATE_VOD = '{title}.mp4';
const DEFAULT_FILENAME_TEMPLATE_PARTS = '{date}_Part{part_padded}.mp4';
const DEFAULT_FILENAME_TEMPLATE_CLIP = '{date}_{part}.mp4';

// Timeouts
const API_TIMEOUT = 10000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_SECONDS = 5;
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

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
    language: 'de' | 'en';
    filename_template_vod: string;
    filename_template_parts: string;
    filename_template_clip: string;
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
    downloadedBytes?: number;
    totalBytes?: number;
    last_error?: string;
    customClip?: CustomClip;
}

interface DownloadResult {
    success: boolean;
    error?: string;
}

interface PreflightChecks {
    internet: boolean;
    streamlink: boolean;
    ffmpeg: boolean;
    ffprobe: boolean;
    downloadPathWritable: boolean;
}

interface PreflightResult {
    ok: boolean;
    autoFixApplied: boolean;
    checks: PreflightChecks;
    messages: string[];
    timestamp: string;
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
    part_minutes: 120,
    language: 'en',
    filename_template_vod: DEFAULT_FILENAME_TEMPLATE_VOD,
    filename_template_parts: DEFAULT_FILENAME_TEMPLATE_PARTS,
    filename_template_clip: DEFAULT_FILENAME_TEMPLATE_CLIP
};

function normalizeFilenameTemplate(template: string | undefined, fallback: string): string {
    const value = (template || '').trim();
    return value || fallback;
}

function normalizeConfigTemplates(input: Config): Config {
    return {
        ...input,
        filename_template_vod: normalizeFilenameTemplate(input.filename_template_vod, DEFAULT_FILENAME_TEMPLATE_VOD),
        filename_template_parts: normalizeFilenameTemplate(input.filename_template_parts, DEFAULT_FILENAME_TEMPLATE_PARTS),
        filename_template_clip: normalizeFilenameTemplate(input.filename_template_clip, DEFAULT_FILENAME_TEMPLATE_CLIP)
    };
}

function loadConfig(): Config {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            return normalizeConfigTemplates({ ...defaultConfig, ...JSON.parse(data) });
        }
    } catch (e) {
        console.error('Error loading config:', e);
    }
    return normalizeConfigTemplates(defaultConfig);
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
let pauseRequested = false;
let downloadStartTime = 0;
let downloadedBytes = 0;
const userIdLoginCache = new Map<string, string>();
let streamlinkCommandCache: { command: string; prefixArgs: string[] } | null = null;
let bundledStreamlinkPath: string | null = null;
let bundledFFmpegPath: string | null = null;
let bundledFFprobePath: string | null = null;

// ==========================================
// TOOL PATHS
// ==========================================
function getStreamlinkPath(): string {
    if (bundledStreamlinkPath && fs.existsSync(bundledStreamlinkPath)) {
        return bundledStreamlinkPath;
    }

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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDownloadPathWritable(targetPath: string): boolean {
    try {
        fs.mkdirSync(targetPath, { recursive: true });
        const probeFile = path.join(targetPath, `.write_test_${Date.now()}.tmp`);
        fs.writeFileSync(probeFile, 'ok');
        fs.unlinkSync(probeFile);
        return true;
    } catch {
        return false;
    }
}

async function hasInternetConnection(): Promise<boolean> {
    try {
        const res = await axios.get('https://id.twitch.tv/oauth2/validate', {
            timeout: 5000,
            validateStatus: () => true
        });
        return res.status > 0;
    } catch {
        return false;
    }
}

async function runPreflight(autoFix = false): Promise<PreflightResult> {
    appendDebugLog('preflight-start', { autoFix });

    refreshBundledToolPaths();

    const checks: PreflightChecks = {
        internet: await hasInternetConnection(),
        streamlink: false,
        ffmpeg: false,
        ffprobe: false,
        downloadPathWritable: isDownloadPathWritable(config.download_path)
    };

    if (autoFix) {
        await ensureStreamlinkInstalled();
        await ensureFfmpegInstalled();
        refreshBundledToolPaths();
    }

    const streamlinkCmd = getStreamlinkCommand();
    checks.streamlink = canExecuteCommand(streamlinkCmd.command, [...streamlinkCmd.prefixArgs, '--version']);

    const ffmpegPath = getFFmpegPath();
    const ffprobePath = getFFprobePath();
    checks.ffmpeg = canExecuteCommand(ffmpegPath, ['-version']);
    checks.ffprobe = canExecuteCommand(ffprobePath, ['-version']);

    const messages: string[] = [];
    if (!checks.internet) messages.push('Keine Internetverbindung erkannt.');
    if (!checks.streamlink) messages.push('Streamlink fehlt oder ist nicht startbar.');
    if (!checks.ffmpeg) messages.push('FFmpeg fehlt oder ist nicht startbar.');
    if (!checks.ffprobe) messages.push('FFprobe fehlt oder ist nicht startbar.');
    if (!checks.downloadPathWritable) messages.push('Download-Ordner ist nicht beschreibbar.');

    const result: PreflightResult = {
        ok: messages.length === 0,
        autoFixApplied: autoFix,
        checks,
        messages,
        timestamp: new Date().toISOString()
    };

    appendDebugLog('preflight-finished', result);
    return result;
}

function readDebugLog(lines = 200): string {
    try {
        if (!fs.existsSync(DEBUG_LOG_FILE)) {
            return 'Debug-Log ist leer.';
        }

        const text = fs.readFileSync(DEBUG_LOG_FILE, 'utf-8');
        const rows = text.split(/\r?\n/).filter(Boolean);
        return rows.slice(-lines).join('\n') || 'Debug-Log ist leer.';
    } catch (e) {
        return `Debug-Log konnte nicht gelesen werden: ${String(e)}`;
    }
}

function canExecute(cmd: string): boolean {
    try {
        execSync(cmd, { stdio: 'ignore', windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

function canExecuteCommand(command: string, args: string[]): boolean {
    try {
        const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
        return result.status === 0;
    } catch {
        return false;
    }
}

function findFileRecursive(rootDir: string, fileName: string): string | null {
    if (!fs.existsSync(rootDir)) return null;

    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
            return fullPath;
        }

        if (entry.isDirectory()) {
            const nested = findFileRecursive(fullPath, fileName);
            if (nested) return nested;
        }
    }

    return null;
}

function refreshBundledToolPaths(): void {
    bundledStreamlinkPath = findFileRecursive(TOOLS_STREAMLINK_DIR, process.platform === 'win32' ? 'streamlink.exe' : 'streamlink');
    bundledFFmpegPath = findFileRecursive(TOOLS_FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    bundledFFprobePath = findFileRecursive(TOOLS_FFMPEG_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

async function downloadFile(url: string, destinationPath: string): Promise<boolean> {
    try {
        const response = await axios.get(url, { responseType: 'stream', timeout: 120000 });

        await new Promise<void>((resolve, reject) => {
            const writer = fs.createWriteStream(destinationPath);
            response.data.pipe(writer);
            writer.on('finish', () => resolve());
            writer.on('error', (err) => reject(err));
        });

        return true;
    } catch (e) {
        appendDebugLog('download-file-failed', { url, destinationPath, error: String(e) });
        return false;
    }
}

async function extractZip(zipPath: string, destinationDir: string): Promise<boolean> {
    try {
        fs.mkdirSync(destinationDir, { recursive: true });

        const command = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`;

        await new Promise<void>((resolve, reject) => {
            const proc = spawn('powershell', [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-Command',
                command
            ], { windowsHide: true });

            let stderr = '';
            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Expand-Archive exit code ${code}: ${stderr.trim()}`));
                }
            });

            proc.on('error', (err) => reject(err));
        });

        return true;
    } catch (e) {
        appendDebugLog('extract-zip-failed', { zipPath, destinationDir, error: String(e) });
        return false;
    }
}

async function ensureStreamlinkInstalled(): Promise<boolean> {
    refreshBundledToolPaths();

    const current = getStreamlinkCommand();
    if (canExecuteCommand(current.command, [...current.prefixArgs, '--version'])) {
        return true;
    }

    if (process.platform !== 'win32') {
        return false;
    }

    appendDebugLog('streamlink-install-start');
    try {
        fs.mkdirSync(TOOLS_STREAMLINK_DIR, { recursive: true });

        const release = await axios.get('https://api.github.com/repos/streamlink/windows-builds/releases/latest', {
            timeout: 120000,
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'Twitch-VOD-Manager'
            }
        });

        const assets = release.data?.assets || [];
        const zipAsset = assets.find((a: any) => typeof a?.name === 'string' && /x86_64\.zip$/i.test(a.name));
        if (!zipAsset?.browser_download_url) {
            appendDebugLog('streamlink-install-no-asset-found');
            return false;
        }

        const zipPath = path.join(app.getPath('temp'), `streamlink_portable_${Date.now()}.zip`);
        const downloadOk = await downloadFile(zipAsset.browser_download_url, zipPath);
        if (!downloadOk) return false;

        fs.rmSync(TOOLS_STREAMLINK_DIR, { recursive: true, force: true });
        fs.mkdirSync(TOOLS_STREAMLINK_DIR, { recursive: true });

        const extractOk = await extractZip(zipPath, TOOLS_STREAMLINK_DIR);
        try { fs.unlinkSync(zipPath); } catch { }
        if (!extractOk) return false;

        refreshBundledToolPaths();
        streamlinkCommandCache = null;

        const cmd = getStreamlinkCommand();
        const works = canExecuteCommand(cmd.command, [...cmd.prefixArgs, '--version']);
        appendDebugLog('streamlink-install-finished', { works, command: cmd.command, prefixArgs: cmd.prefixArgs });
        return works;
    } catch (e) {
        appendDebugLog('streamlink-install-failed', String(e));
        return false;
    }
}

async function ensureFfmpegInstalled(): Promise<boolean> {
    refreshBundledToolPaths();

    const ffmpegPath = getFFmpegPath();
    const ffprobePath = getFFprobePath();
    if (canExecuteCommand(ffmpegPath, ['-version']) && canExecuteCommand(ffprobePath, ['-version'])) {
        return true;
    }

    if (process.platform !== 'win32') {
        return false;
    }

    appendDebugLog('ffmpeg-install-start');
    try {
        fs.mkdirSync(TOOLS_FFMPEG_DIR, { recursive: true });

        const zipPath = path.join(app.getPath('temp'), `ffmpeg_essentials_${Date.now()}.zip`);
        const downloadOk = await downloadFile('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', zipPath);
        if (!downloadOk) return false;

        fs.rmSync(TOOLS_FFMPEG_DIR, { recursive: true, force: true });
        fs.mkdirSync(TOOLS_FFMPEG_DIR, { recursive: true });

        const extractOk = await extractZip(zipPath, TOOLS_FFMPEG_DIR);
        try { fs.unlinkSync(zipPath); } catch { }
        if (!extractOk) return false;

        refreshBundledToolPaths();

        const newFfmpegPath = getFFmpegPath();
        const newFfprobePath = getFFprobePath();
        const works = canExecuteCommand(newFfmpegPath, ['-version']) && canExecuteCommand(newFfprobePath, ['-version']);
        appendDebugLog('ffmpeg-install-finished', { works, ffmpeg: newFfmpegPath, ffprobe: newFfprobePath });
        return works;
    } catch (e) {
        appendDebugLog('ffmpeg-install-failed', String(e));
        return false;
    }
}

function getStreamlinkCommand(): { command: string; prefixArgs: string[] } {
    if (streamlinkCommandCache) {
        return streamlinkCommandCache;
    }

    const directPath = getStreamlinkPath();
    if (directPath !== 'streamlink' || canExecute('streamlink --version')) {
        streamlinkCommandCache = { command: directPath, prefixArgs: [] };
        return streamlinkCommandCache;
    }

    if (process.platform === 'win32') {
        if (canExecute('py -3 -m streamlink --version')) {
            streamlinkCommandCache = { command: 'py', prefixArgs: ['-3', '-m', 'streamlink'] };
            return streamlinkCommandCache;
        }

        if (canExecute('python -m streamlink --version')) {
            streamlinkCommandCache = { command: 'python', prefixArgs: ['-m', 'streamlink'] };
            return streamlinkCommandCache;
        }
    } else {
        if (canExecute('python3 -m streamlink --version')) {
            streamlinkCommandCache = { command: 'python3', prefixArgs: ['-m', 'streamlink'] };
            return streamlinkCommandCache;
        }

        if (canExecute('python -m streamlink --version')) {
            streamlinkCommandCache = { command: 'python', prefixArgs: ['-m', 'streamlink'] };
            return streamlinkCommandCache;
        }
    }

    streamlinkCommandCache = { command: directPath, prefixArgs: [] };
    return streamlinkCommandCache;
}

function getFFmpegPath(): string {
    if (bundledFFmpegPath && fs.existsSync(bundledFFmpegPath)) {
        return bundledFFmpegPath;
    }

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
    if (bundledFFprobePath && fs.existsSync(bundledFFprobePath)) {
        return bundledFFprobePath;
    }

    const ffmpegPath = getFFmpegPath();
    const ffprobeExe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    return path.join(path.dirname(ffmpegPath), ffprobeExe);
}

function appendDebugLog(message: string, details?: unknown): void {
    try {
        const ts = new Date().toISOString();
        const payload = details === undefined
            ? ''
            : ` | ${typeof details === 'string' ? details : JSON.stringify(details)}`;
        fs.appendFileSync(DEBUG_LOG_FILE, `[${ts}] ${message}${payload}\n`);
    } catch {
        // ignore debug log errors
    }
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

function formatDurationDashed(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}-${m.toString().padStart(2, '0')}-${s.toString().padStart(2, '0')}`;
}

function sanitizeFilenamePart(input: string, fallback = 'unnamed'): string {
    const cleaned = (input || '')
        .replace(/[<>:"|?*\x00-\x1f]/g, '_')
        .replace(/[\\/]/g, '_')
        .trim();
    return cleaned || fallback;
}

function formatDateWithPattern(date: Date, pattern: string): string {
    const tokenMap: Record<string, string> = {
        yyyy: date.getFullYear().toString(),
        yy: date.getFullYear().toString().slice(-2),
        MM: (date.getMonth() + 1).toString().padStart(2, '0'),
        M: (date.getMonth() + 1).toString(),
        dd: date.getDate().toString().padStart(2, '0'),
        d: date.getDate().toString(),
        HH: date.getHours().toString().padStart(2, '0'),
        H: date.getHours().toString(),
        hh: date.getHours().toString().padStart(2, '0'),
        h: date.getHours().toString(),
        mm: date.getMinutes().toString().padStart(2, '0'),
        m: date.getMinutes().toString(),
        ss: date.getSeconds().toString().padStart(2, '0'),
        s: date.getSeconds().toString()
    };

    return pattern
        .replace(/yyyy|yy|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s/g, (token) => tokenMap[token] ?? token)
        .replace(/\\(.)/g, '$1');
}

function formatSecondsWithPattern(totalSeconds: number, pattern: string): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;

    const tokenMap: Record<string, string> = {
        HH: hours.toString().padStart(2, '0'),
        H: hours.toString(),
        hh: hours.toString().padStart(2, '0'),
        h: hours.toString(),
        mm: minutes.toString().padStart(2, '0'),
        m: minutes.toString(),
        ss: seconds.toString().padStart(2, '0'),
        s: seconds.toString()
    };

    return pattern
        .replace(/HH|H|hh|h|mm|m|ss|s/g, (token) => tokenMap[token] ?? token)
        .replace(/\\(.)/g, '$1');
}

function parseVodId(url: string): string {
    const match = url.match(/videos\/(\d+)/i);
    return match?.[1] || '';
}

interface ClipTemplateContext {
    template: string;
    title: string;
    vodId: string;
    channel: string;
    date: Date;
    part: number;
    partPadded: string;
    trimStartSec: number;
    trimEndSec: number;
    trimLengthSec: number;
    fullLengthSec: number;
}

function renderClipFilenameTemplate(context: ClipTemplateContext): string {
    const baseDate = `${context.date.getDate().toString().padStart(2, '0')}.${(context.date.getMonth() + 1).toString().padStart(2, '0')}.${context.date.getFullYear()}`;
    let rendered = context.template
        .replace(/\{title\}/g, sanitizeFilenamePart(context.title, 'untitled'))
        .replace(/\{id\}/g, sanitizeFilenamePart(context.vodId, 'unknown'))
        .replace(/\{channel\}/g, sanitizeFilenamePart(context.channel, 'unknown'))
        .replace(/\{channel_id\}/g, '')
        .replace(/\{date\}/g, baseDate)
        .replace(/\{part\}/g, String(context.part))
        .replace(/\{part_padded\}/g, context.partPadded)
        .replace(/\{trim_start\}/g, formatDurationDashed(context.trimStartSec))
        .replace(/\{trim_end\}/g, formatDurationDashed(context.trimEndSec))
        .replace(/\{trim_length\}/g, formatDurationDashed(context.trimLengthSec))
        .replace(/\{length\}/g, formatDurationDashed(context.fullLengthSec))
        .replace(/\{ext\}/g, 'mp4')
        .replace(/\{random_string\}/g, Math.random().toString(36).slice(2, 10));

    rendered = rendered.replace(/\{date_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatDateWithPattern(context.date, pattern), 'date');
    });
    rendered = rendered.replace(/\{trim_start_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatSecondsWithPattern(context.trimStartSec, pattern), '00-00-00');
    });
    rendered = rendered.replace(/\{trim_end_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatSecondsWithPattern(context.trimEndSec, pattern), '00-00-00');
    });
    rendered = rendered.replace(/\{trim_length_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatSecondsWithPattern(context.trimLengthSec, pattern), '00-00-00');
    });
    rendered = rendered.replace(/\{length_custom="(.*?)"\}/g, (_, pattern: string) => {
        return sanitizeFilenamePart(formatSecondsWithPattern(context.fullLengthSec, pattern), '00-00-00');
    });

    const parts = rendered
        .split(/[\\/]+/)
        .map((segment) => sanitizeFilenamePart(segment, 'unnamed'))
        .filter((segment) => segment !== '.' && segment !== '..');

    if (parts.length === 0) {
        return 'clip.mp4';
    }

    const lastIdx = parts.length - 1;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(parts[lastIdx])) {
        parts[lastIdx] = `${parts[lastIdx]}.mp4`;
    }

    return path.join(...parts);
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

async function ensureTwitchAuth(forceRefresh = false): Promise<boolean> {
    if (!config.client_id || !config.client_secret) {
        accessToken = null;
        return false;
    }

    if (!forceRefresh && accessToken) {
        return true;
    }

    return await twitchLogin();
}

function normalizeLogin(input: string): string {
    return input.trim().replace(/^@+/, '').toLowerCase();
}

function formatTwitchDurationFromSeconds(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (h > 0) return `${h}h${m}m${s}s`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
}

async function fetchPublicTwitchGql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    try {
        const response = await axios.post<{ data?: T; errors?: Array<{ message: string }> }>(
            'https://gql.twitch.tv/gql',
            { query, variables },
            {
                headers: {
                    'Client-ID': TWITCH_WEB_CLIENT_ID,
                    'Content-Type': 'application/json'
                },
                timeout: API_TIMEOUT
            }
        );

        if (response.data.errors?.length) {
            console.error('Public Twitch GQL errors:', response.data.errors.map((err) => err.message).join('; '));
            return null;
        }

        return response.data.data || null;
    } catch (e) {
        console.error('Public Twitch GQL request failed:', e);
        return null;
    }
}

async function getPublicUserId(username: string): Promise<string | null> {
    const login = normalizeLogin(username);
    if (!login) return null;

    type UserQueryResult = { user: { id: string; login: string } | null };
    const data = await fetchPublicTwitchGql<UserQueryResult>(
        'query($login:String!){ user(login:$login){ id login } }',
        { login }
    );

    const user = data?.user;
    if (!user?.id) return null;

    userIdLoginCache.set(user.id, user.login || login);
    return user.id;
}

async function getPublicVODsByLogin(loginName: string): Promise<VOD[]> {
    const login = normalizeLogin(loginName);
    if (!login) return [];

    type VideoNode = {
        id: string;
        title: string;
        publishedAt: string;
        lengthSeconds: number;
        viewCount: number;
        previewThumbnailURL: string;
    };

    type VodsQueryResult = {
        user: {
            videos: {
                edges: Array<{ node: VideoNode }>;
            };
        } | null;
    };

    const data = await fetchPublicTwitchGql<VodsQueryResult>(
        'query($login:String!,$first:Int!){ user(login:$login){ videos(first:$first, type:ARCHIVE, sort:TIME){ edges{ node{ id title publishedAt lengthSeconds viewCount previewThumbnailURL(width:320,height:180) } } } } }',
        { login, first: 100 }
    );

    const edges = data?.user?.videos?.edges || [];

    return edges
        .map(({ node }) => {
            const id = node?.id;
            if (!id) return null;

            return {
                id,
                title: node.title || 'Untitled VOD',
                created_at: node.publishedAt || new Date(0).toISOString(),
                duration: formatTwitchDurationFromSeconds(node.lengthSeconds || 0),
                thumbnail_url: node.previewThumbnailURL || '',
                url: `https://www.twitch.tv/videos/${id}`,
                view_count: node.viewCount || 0,
                stream_id: ''
            } as VOD;
        })
        .filter((vod): vod is VOD => Boolean(vod));
}

async function getUserId(username: string): Promise<string | null> {
    const login = normalizeLogin(username);
    if (!login) return null;

    const getUserViaPublicApi = async () => {
        return await getPublicUserId(login);
    };

    if (!(await ensureTwitchAuth())) return await getUserViaPublicApi();

    const fetchUser = async () => {
        return await axios.get('https://api.twitch.tv/helix/users', {
            params: { login },
            headers: {
                'Client-ID': config.client_id,
                'Authorization': `Bearer ${accessToken}`
            },
            timeout: API_TIMEOUT
        });
    };

    try {
        const response = await fetchUser();
        const user = response.data.data[0];
        if (!user?.id) return await getUserViaPublicApi();

        userIdLoginCache.set(user.id, user.login || login);
        return user.id;
    } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 401 && (await ensureTwitchAuth(true))) {
            try {
                const retryResponse = await fetchUser();
                const user = retryResponse.data.data[0];
                if (!user?.id) return await getUserViaPublicApi();

                userIdLoginCache.set(user.id, user.login || login);
                return user.id;
            } catch (retryError) {
                console.error('Error getting user after relogin:', retryError);
                return await getUserViaPublicApi();
            }
        }

        console.error('Error getting user:', e);
        return await getUserViaPublicApi();
    }
}

async function getVODs(userId: string): Promise<VOD[]> {
    const getVodsViaPublicApi = async () => {
        const login = userIdLoginCache.get(userId);
        if (!login) return [];

        return await getPublicVODsByLogin(login);
    };

    if (!(await ensureTwitchAuth())) return await getVodsViaPublicApi();

    const fetchVods = async () => {
        return await axios.get('https://api.twitch.tv/helix/videos', {
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
    };

    try {
        const response = await fetchVods();
        const vods = response.data.data || [];
        const login = vods[0]?.user_login;
        if (login) {
            userIdLoginCache.set(userId, normalizeLogin(login));
        }

        return vods;
    } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 401 && (await ensureTwitchAuth(true))) {
            try {
                const retryResponse = await fetchVods();
                const vods = retryResponse.data.data || [];
                const login = vods[0]?.user_login;
                if (login) {
                    userIdLoginCache.set(userId, normalizeLogin(login));
                }

                return vods;
            } catch (retryError) {
                console.error('Error getting VODs after relogin:', retryError);
                return await getVodsViaPublicApi();
            }
        }

        console.error('Error getting VODs:', e);
        return await getVodsViaPublicApi();
    }
}

async function getClipInfo(clipId: string): Promise<any | null> {
    if (!(await ensureTwitchAuth())) return null;

    const fetchClip = async () => {
        return await axios.get('https://api.twitch.tv/helix/clips', {
            params: { id: clipId },
            headers: {
                'Client-ID': config.client_id,
                'Authorization': `Bearer ${accessToken}`
            },
            timeout: API_TIMEOUT
        });
    };

    try {
        const response = await fetchClip();
        return response.data.data[0] || null;
    } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 401 && (await ensureTwitchAuth(true))) {
            try {
                const retryResponse = await fetchClip();
                return retryResponse.data.data[0] || null;
            } catch (retryError) {
                console.error('Error getting clip after relogin:', retryError);
                return null;
            }
        }

        console.error('Error getting clip:', e);
        return null;
    }
}

// ==========================================
// VIDEO INFO (for cutter)
// ==========================================
async function getVideoInfo(filePath: string): Promise<VideoInfo | null> {
    const ffmpegReady = await ensureFfmpegInstalled();
    if (!ffmpegReady) {
        appendDebugLog('get-video-info-missing-ffmpeg');
        return null;
    }

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
    const ffmpegReady = await ensureFfmpegInstalled();
    if (!ffmpegReady) {
        appendDebugLog('extract-frame-missing-ffmpeg');
        return null;
    }

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
    const ffmpegReady = await ensureFfmpegInstalled();
    if (!ffmpegReady) {
        appendDebugLog('cut-video-missing-ffmpeg');
        return false;
    }

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
    const ffmpegReady = await ensureFfmpegInstalled();
    if (!ffmpegReady) {
        appendDebugLog('merge-videos-missing-ffmpeg');
        return false;
    }

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
): Promise<DownloadResult> {
    return new Promise((resolve) => {
        const streamlinkCmd = getStreamlinkCommand();
        const args = [...streamlinkCmd.prefixArgs, url, 'best', '-o', filename, '--force'];
        let lastErrorLine = '';

        if (startTime) {
            args.push('--hls-start-offset', startTime);
        }
        if (endTime) {
            args.push('--hls-duration', endTime);
        }

        console.log('Starting download:', streamlinkCmd.command, args);
        appendDebugLog('download-part-start', { itemId, command: streamlinkCmd.command, filename, args });

        const proc = spawn(streamlinkCmd.command, args, { windowsHide: true });
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
                        status: `${formatBytes(downloadedBytes)} heruntergeladen`,
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
                    status: `${percent.toFixed(1)}%`,
                    currentPart: partNum,
                    totalParts: totalParts
                });
            }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const message = data.toString().trim();
            if (message) {
                lastErrorLine = message.split('\n').pop() || message;
                appendDebugLog('download-part-stderr', { itemId, message: lastErrorLine });
                console.error('Streamlink error:', message);
            }
        });

        proc.on('close', (code) => {
            clearInterval(progressInterval);
            currentProcess = null;

            if (currentDownloadCancelled) {
                appendDebugLog('download-part-cancelled', { itemId, filename });
                resolve({ success: false, error: 'Download wurde abgebrochen.' });
                return;
            }

            if (code === 0 && fs.existsSync(filename)) {
                const stats = fs.statSync(filename);
                if (stats.size > 1024 * 1024) {
                    appendDebugLog('download-part-success', { itemId, filename, bytes: stats.size });
                    resolve({ success: true });
                    return;
                }

                const tooSmall = `Datei zu klein (${stats.size} Bytes)`;
                appendDebugLog('download-part-failed-small-file', { itemId, filename, bytes: stats.size });
                resolve({ success: false, error: tooSmall });
                return;
            }

            const genericError = lastErrorLine || `Streamlink Fehlercode ${code ?? -1}`;
            appendDebugLog('download-part-failed', { itemId, filename, code, error: genericError });
            resolve({ success: false, error: genericError });
        });

        proc.on('error', (err) => {
            clearInterval(progressInterval);
            console.error('Process error:', err);
            currentProcess = null;
            const rawError = String(err);
            const errorMessage = rawError.includes('ENOENT')
                ? 'Streamlink nicht gefunden. Installiere Streamlink oder Python+streamlink (py -3 -m pip install streamlink).'
                : rawError;
            appendDebugLog('download-part-process-error', { itemId, error: errorMessage, rawError });
            resolve({ success: false, error: errorMessage });
        });
    });
}

async function downloadVOD(
    item: QueueItem,
    onProgress: (progress: DownloadProgress) => void
): Promise<DownloadResult> {
    onProgress({
        id: item.id,
        progress: -1,
        speed: '',
        eta: '',
        status: 'Prufe Download-Tools...',
        currentPart: 0,
        totalParts: 0
    });

    const streamlinkReady = await ensureStreamlinkInstalled();
    if (!streamlinkReady) {
        return {
            success: false,
            error: 'Streamlink fehlt und konnte nicht automatisch installiert werden. Siehe debug.log.'
        };
    }

    onProgress({
        id: item.id,
        progress: -1,
        speed: '',
        eta: '',
        status: 'Download gestartet',
        currentPart: 0,
        totalParts: 0
    });

    const streamer = item.streamer.replace(/[^a-zA-Z0-9_-]/g, '');
    const date = new Date(item.date);
    const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;

    const folder = path.join(config.download_path, streamer, dateStr);
    fs.mkdirSync(folder, { recursive: true });

    const totalDuration = parseDuration(item.duration_str);
    const vodId = parseVodId(item.url);

    const makeTemplateFilename = (
        template: string,
        templateFallback: string,
        partNum: number,
        trimStartSec: number,
        trimLengthSec: number
    ): string => {
        const relativeName = renderClipFilenameTemplate({
            template: normalizeFilenameTemplate(template, templateFallback),
            title: item.title,
            vodId,
            channel: item.streamer,
            date,
            part: partNum,
            partPadded: partNum.toString().padStart(2, '0'),
            trimStartSec,
            trimEndSec: trimStartSec + trimLengthSec,
            trimLengthSec,
            fullLengthSec: totalDuration
        });

        return path.join(folder, relativeName);
    };

    // Custom Clip - download specific time range
    if (item.customClip) {
        const clip = item.customClip;
        const partDuration = config.part_minutes * 60;

        // Helper to generate filename based on format
        const makeClipFilename = (partNum: number, startOffset: number, clipLengthSec: number): string => {
            if (clip.filenameFormat === 'template') {
                return makeTemplateFilename(
                    clip.filenameTemplate || config.filename_template_clip,
                    DEFAULT_FILENAME_TEMPLATE_CLIP,
                    partNum,
                    startOffset,
                    clipLengthSec
                );
            }

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

                const partFilename = makeClipFilename(partNum, startOffset, thisDuration);

                const result = await downloadVODPart(
                    item.url,
                    partFilename,
                    formatDuration(startOffset),
                    formatDuration(thisDuration),
                    onProgress,
                    item.id,
                    i + 1,
                    numParts
                );

                if (!result.success) return result;
                downloadedFiles.push(partFilename);
            }

            return {
                success: downloadedFiles.length === numParts,
                error: downloadedFiles.length === numParts ? undefined : 'Nicht alle Clip-Teile konnten heruntergeladen werden.'
            };
        } else {
            // Single clip file
            const filename = makeClipFilename(clip.startPart, clip.startSec, clip.durationSec);
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
        const filename = makeTemplateFilename(
            config.filename_template_vod,
            DEFAULT_FILENAME_TEMPLATE_VOD,
            1,
            0,
            totalDuration
        );
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

            const partFilename = makeTemplateFilename(
                config.filename_template_parts,
                DEFAULT_FILENAME_TEMPLATE_PARTS,
                i + 1,
                startSec,
                duration
            );

            const result = await downloadVODPart(
                item.url,
                partFilename,
                formatDuration(startSec),
                formatDuration(duration),
                onProgress,
                item.id,
                i + 1,
                numParts
            );

            if (!result.success) {
                return result;
            }

            downloadedFiles.push(partFilename);
        }

        return {
            success: downloadedFiles.length === numParts,
            error: downloadedFiles.length === numParts ? undefined : 'Nicht alle Teile konnten heruntergeladen werden.'
        };
    }
}

async function processQueue(): Promise<void> {
    if (isDownloading || downloadQueue.length === 0) return;

    appendDebugLog('queue-start', { items: downloadQueue.length });
    isDownloading = true;
    pauseRequested = false;
    mainWindow?.webContents.send('download-started');
    mainWindow?.webContents.send('queue-updated', downloadQueue);

    for (const item of downloadQueue) {
        if (!isDownloading || pauseRequested) break;
        if (item.status === 'completed' || item.status === 'error' || item.status === 'paused') continue;

        appendDebugLog('queue-item-start', { itemId: item.id, title: item.title, url: item.url });

        currentDownloadCancelled = false;
        item.status = 'downloading';
        saveQueue(downloadQueue);
        mainWindow?.webContents.send('queue-updated', downloadQueue);

        item.last_error = '';

        let finalResult: DownloadResult = { success: false, error: 'Unbekannter Fehler beim Download' };

        for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
            appendDebugLog('queue-item-attempt', { itemId: item.id, attempt, max: MAX_RETRY_ATTEMPTS });

            const result = await downloadVOD(item, (progress) => {
                mainWindow?.webContents.send('download-progress', progress);
            });

            if (result.success) {
                finalResult = result;
                break;
            }

            finalResult = result;

            if (!isDownloading || currentDownloadCancelled || pauseRequested) {
                finalResult = { success: false, error: pauseRequested ? 'Download wurde pausiert.' : 'Download wurde abgebrochen.' };
                break;
            }

            if (attempt < MAX_RETRY_ATTEMPTS) {
                item.last_error = `Versuch ${attempt}/${MAX_RETRY_ATTEMPTS} fehlgeschlagen: ${result.error || 'Unbekannter Fehler'}`;
                mainWindow?.webContents.send('download-progress', {
                    id: item.id,
                    progress: -1,
                    speed: '',
                    eta: '',
                    status: `Neuer Versuch in ${RETRY_DELAY_SECONDS}s...`,
                    currentPart: item.currentPart,
                    totalParts: item.totalParts
                } as DownloadProgress);
                saveQueue(downloadQueue);
                mainWindow?.webContents.send('queue-updated', downloadQueue);
                await sleep(RETRY_DELAY_SECONDS * 1000);
            }
        }

        const wasPaused = pauseRequested || (finalResult.error || '').includes('pausiert');
        item.status = finalResult.success ? 'completed' : (wasPaused ? 'paused' : 'error');
        item.progress = finalResult.success ? 100 : item.progress;
        item.last_error = finalResult.success || wasPaused ? '' : (finalResult.error || 'Unbekannter Fehler beim Download');
        appendDebugLog('queue-item-finished', {
            itemId: item.id,
            status: item.status,
            error: item.last_error
        });
        saveQueue(downloadQueue);
        mainWindow?.webContents.send('queue-updated', downloadQueue);
    }

    isDownloading = false;
    pauseRequested = false;
    saveQueue(downloadQueue);
    mainWindow?.webContents.send('queue-updated', downloadQueue);
    mainWindow?.webContents.send('download-finished');
    appendDebugLog('queue-finished', { items: downloadQueue.length });
}

// ==========================================
// WINDOW CREATION
// ==========================================
function createWindow(): void {
    nativeTheme.themeSource = 'dark';

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1200,
        minHeight: 700,
        title: `Twitch VOD Manager [v${APP_VERSION}]`,
        backgroundColor: '#0e0e10',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    if (process.platform !== 'darwin') {
        mainWindow.removeMenu();
    }

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
    const previousClientId = config.client_id;
    const previousClientSecret = config.client_secret;

    config = normalizeConfigTemplates({ ...config, ...newConfig });

    if (config.client_id !== previousClientId || config.client_secret !== previousClientSecret) {
        accessToken = null;
    }

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
    mainWindow?.webContents.send('queue-updated', downloadQueue);
    return downloadQueue;
});

ipcMain.handle('remove-from-queue', (_, id: string) => {
    downloadQueue = downloadQueue.filter(item => item.id !== id);
    saveQueue(downloadQueue);
    mainWindow?.webContents.send('queue-updated', downloadQueue);
    return downloadQueue;
});

ipcMain.handle('clear-completed', () => {
    downloadQueue = downloadQueue.filter(item => item.status !== 'completed');
    saveQueue(downloadQueue);
    mainWindow?.webContents.send('queue-updated', downloadQueue);
    return downloadQueue;
});

ipcMain.handle('reorder-queue', (_, orderIds: string[]) => {
    const order = new Map(orderIds.map((id, idx) => [id, idx]));
    const withOrder = [...downloadQueue].sort((a, b) => {
        const ai = order.has(a.id) ? (order.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = order.has(b.id) ? (order.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
    });

    downloadQueue = withOrder;
    saveQueue(downloadQueue);
    mainWindow?.webContents.send('queue-updated', downloadQueue);
    return downloadQueue;
});

ipcMain.handle('retry-failed-downloads', () => {
    downloadQueue = downloadQueue.map((item) => {
        if (item.status !== 'error') return item;

        return {
            ...item,
            status: 'pending',
            progress: 0,
            last_error: ''
        };
    });

    saveQueue(downloadQueue);
    mainWindow?.webContents.send('queue-updated', downloadQueue);

    if (!isDownloading) {
        void processQueue();
    }

    return downloadQueue;
});

ipcMain.handle('start-download', async () => {
    downloadQueue = downloadQueue.map((item) => item.status === 'paused' ? { ...item, status: 'pending' } : item);

    const hasPendingItems = downloadQueue.some(item => item.status === 'pending');
    if (!hasPendingItems) {
        mainWindow?.webContents.send('queue-updated', downloadQueue);
        return false;
    }

    saveQueue(downloadQueue);
    mainWindow?.webContents.send('queue-updated', downloadQueue);

    processQueue();
    return true;
});

ipcMain.handle('pause-download', () => {
    if (!isDownloading) return false;

    pauseRequested = true;
    currentDownloadCancelled = true;
    if (currentProcess) {
        currentProcess.kill();
    }
    return true;
});

ipcMain.handle('cancel-download', () => {
    isDownloading = false;
    pauseRequested = false;
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
    else return { success: false, error: 'Ungueltige Clip-URL' };

    const clipInfo = await getClipInfo(clipId);
    if (!clipInfo) return { success: false, error: 'Clip nicht gefunden' };

    const folder = path.join(config.download_path, 'Clips', clipInfo.broadcaster_name);
    fs.mkdirSync(folder, { recursive: true });

    const safeTitle = clipInfo.title.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 50);
    const filename = path.join(folder, `${safeTitle}.mp4`);

    return new Promise((resolve) => {
        const streamlinkCmd = getStreamlinkCommand();
        const proc = spawn(streamlinkCmd.command, [
            ...streamlinkCmd.prefixArgs,
            `https://clips.twitch.tv/${clipId}`,
            'best',
            '-o', filename,
            '--force'
        ], { windowsHide: true });

        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(filename)) {
                resolve({ success: true, filename });
            } else {
                resolve({ success: false, error: `Download fehlgeschlagen (Exit-Code ${code ?? -1})` });
            }
        });

        proc.on('error', () => {
            resolve({ success: false, error: 'Streamlink nicht gefunden' });
        });
    });
});

ipcMain.handle('run-preflight', async (_, autoFix: boolean = false) => {
    return await runPreflight(autoFix);
});

ipcMain.handle('get-debug-log', async (_, lines: number = 200) => {
    return readDebugLog(lines);
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
    refreshBundledToolPaths();
    createWindow();
    appendDebugLog('startup-tools-check-skipped', 'Deferred to first use');

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

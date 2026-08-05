import * as path from 'path';
import * as fs from 'fs';
import { spawn, execSync, spawnSync } from 'child_process';
import axios from 'axios';

// ==========================================
// CONSTANTS
// ==========================================
const TOOL_PATH_REFRESH_TTL_MS = 10 * 1000;

// ==========================================
// DEBUG LOG CALLBACK
// ==========================================
let _appendDebugLog: (message: string, details?: unknown) => void = () => {};

export function setDebugLogFn(fn: (message: string, details?: unknown) => void): void {
    _appendDebugLog = fn;
}

// ==========================================
// TOOL DIRECTORIES (set once from main)
// ==========================================
let TOOLS_STREAMLINK_DIR = '';
let TOOLS_FFMPEG_DIR = '';
let _getTempPath: () => string = () => '';

export function initToolDirs(streamlinkDir: string, ffmpegDir: string, getTempPath: () => string): void {
    TOOLS_STREAMLINK_DIR = streamlinkDir;
    TOOLS_FFMPEG_DIR = ffmpegDir;
    _getTempPath = getTempPath;
}

// ==========================================
// CACHE STATE
// ==========================================
let streamlinkPathCache: string | null = null;
let streamlinkCommandCache: { command: string; prefixArgs: string[] } | null = null;
let ffmpegPathCache: string | null = null;
let ffprobePathCache: string | null = null;
let bundledStreamlinkPath: string | null = null;
let bundledFFmpegPath: string | null = null;
let bundledFFprobePath: string | null = null;
let verifiedStreamlinkCommandKey: string | null = null;
let verifiedFfmpegCommandKey: string | null = null;
let bundledToolPathSignature = '';
let bundledToolPathRefreshedAt = 0;

// ==========================================
// INTERNAL HELPERS
// ==========================================
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

function getDirectoryMtimeMs(directoryPath: string): number {
    try {
        return fs.statSync(directoryPath).mtimeMs;
    } catch {
        return 0;
    }
}

function getCommandCacheKey(command: string, args: string[]): string {
    return [command, ...args].join('\u0000');
}

export function canExecute(cmd: string): boolean {
    try {
        execSync(cmd, { stdio: 'ignore', windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

export function canExecuteCommand(command: string, args: string[]): boolean {
    try {
        const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
        return result.status === 0;
    } catch {
        return false;
    }
}

// ==========================================
// VERIFIED COMMAND CACHES
// ==========================================
export function cacheVerifiedStreamlinkCommand(command: string, args: string[]): void {
    verifiedStreamlinkCommandKey = getCommandCacheKey(command, args);
}

export function isVerifiedStreamlinkCommand(command: string, args: string[]): boolean {
    return verifiedStreamlinkCommandKey === getCommandCacheKey(command, args);
}

export function cacheVerifiedFfmpegCommands(ffmpegCommand: string, ffprobeCommand: string): void {
    verifiedFfmpegCommandKey = getCommandCacheKey(ffmpegCommand, [ffprobeCommand]);
}

export function isVerifiedFfmpegCommands(ffmpegCommand: string, ffprobeCommand: string): boolean {
    return verifiedFfmpegCommandKey === getCommandCacheKey(ffmpegCommand, [ffprobeCommand]);
}

export function invalidateVerifiedToolCaches(): void {
    verifiedStreamlinkCommandKey = null;
    verifiedFfmpegCommandKey = null;
}

// ==========================================
// TOOL PATH DISCOVERY
// ==========================================
export function getStreamlinkPath(): string {
    if (streamlinkPathCache) {
        if (streamlinkPathCache === 'streamlink' || fs.existsSync(streamlinkPathCache)) {
            return streamlinkPathCache;
        }
        streamlinkPathCache = null;
    }

    if (bundledStreamlinkPath && fs.existsSync(bundledStreamlinkPath)) {
        streamlinkPathCache = bundledStreamlinkPath;
        return streamlinkPathCache;
    }

    try {
        if (process.platform === 'win32') {
            const result = execSync('where streamlink', { encoding: 'utf-8' });
            const paths = result.trim().split('\n');
            if (paths.length > 0) {
                streamlinkPathCache = paths[0].trim();
                return streamlinkPathCache;
            }
        } else {
            const result = execSync('which streamlink', { encoding: 'utf-8' });
            streamlinkPathCache = result.trim();
            return streamlinkPathCache;
        }
    } catch { }

    const commonPaths = [
        'C:\\Program Files\\Streamlink\\bin\\streamlink.exe',
        'C:\\Program Files (x86)\\Streamlink\\bin\\streamlink.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Streamlink', 'bin', 'streamlink.exe')
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            streamlinkPathCache = p;
            return streamlinkPathCache;
        }
    }

    streamlinkPathCache = 'streamlink';
    return streamlinkPathCache;
}

export function getStreamlinkCommand(): { command: string; prefixArgs: string[] } {
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

export function getFFmpegPath(): string {
    if (ffmpegPathCache) {
        if (ffmpegPathCache === 'ffmpeg' || fs.existsSync(ffmpegPathCache)) {
            return ffmpegPathCache;
        }
        ffmpegPathCache = null;
    }

    if (bundledFFmpegPath && fs.existsSync(bundledFFmpegPath)) {
        ffmpegPathCache = bundledFFmpegPath;
        return ffmpegPathCache;
    }

    try {
        if (process.platform === 'win32') {
            const result = execSync('where ffmpeg', { encoding: 'utf-8' });
            const paths = result.trim().split('\n');
            if (paths.length > 0) {
                ffmpegPathCache = paths[0].trim();
                return ffmpegPathCache;
            }
        } else {
            const result = execSync('which ffmpeg', { encoding: 'utf-8' });
            ffmpegPathCache = result.trim();
            return ffmpegPathCache;
        }
    } catch { }

    const commonPaths = [
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe')
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            ffmpegPathCache = p;
            return ffmpegPathCache;
        }
    }

    ffmpegPathCache = 'ffmpeg';
    return ffmpegPathCache;
}

export function getFFprobePath(): string {
    if (ffprobePathCache) {
        if (ffprobePathCache === 'ffprobe' || ffprobePathCache === 'ffprobe.exe' || fs.existsSync(ffprobePathCache)) {
            return ffprobePathCache;
        }
        ffprobePathCache = null;
    }

    if (bundledFFprobePath && fs.existsSync(bundledFFprobePath)) {
        ffprobePathCache = bundledFFprobePath;
        return ffprobePathCache;
    }

    const ffmpegPath = getFFmpegPath();
    const ffprobeExe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

    if (ffmpegPath === 'ffmpeg') {
        ffprobePathCache = ffprobeExe;
        return ffprobePathCache;
    }

    const derivedFfprobePath = path.join(path.dirname(ffmpegPath), ffprobeExe);
    if (fs.existsSync(derivedFfprobePath)) {
        ffprobePathCache = derivedFfprobePath;
        return ffprobePathCache;
    }

    ffprobePathCache = ffprobeExe;
    return ffprobePathCache;
}

// ==========================================
// BUNDLED TOOL PATH REFRESH
// ==========================================
export function refreshBundledToolPaths(force = false): void {
    const now = Date.now();
    const signature = `${getDirectoryMtimeMs(TOOLS_STREAMLINK_DIR)}|${getDirectoryMtimeMs(TOOLS_FFMPEG_DIR)}`;

    if (!force && signature === bundledToolPathSignature && (now - bundledToolPathRefreshedAt) < TOOL_PATH_REFRESH_TTL_MS) {
        return;
    }

    bundledToolPathSignature = signature;
    bundledToolPathRefreshedAt = now;

    const nextBundledStreamlinkPath = findFileRecursive(TOOLS_STREAMLINK_DIR, process.platform === 'win32' ? 'streamlink.exe' : 'streamlink');
    const nextBundledFFmpegPath = findFileRecursive(TOOLS_FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const nextBundledFFprobePath = findFileRecursive(TOOLS_FFMPEG_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

    const changed =
        nextBundledStreamlinkPath !== bundledStreamlinkPath ||
        nextBundledFFmpegPath !== bundledFFmpegPath ||
        nextBundledFFprobePath !== bundledFFprobePath;

    bundledStreamlinkPath = nextBundledStreamlinkPath;
    bundledFFmpegPath = nextBundledFFmpegPath;
    bundledFFprobePath = nextBundledFFprobePath;

    if (changed) {
        streamlinkPathCache = null;
        ffmpegPathCache = null;
        ffprobePathCache = null;
        streamlinkCommandCache = null;
        invalidateVerifiedToolCaches();
    }
}

// ==========================================
// DOWNLOAD & EXTRACT HELPERS
// ==========================================
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
        _appendDebugLog('download-file-failed', { url, destinationPath, error: String(e) });
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
        _appendDebugLog('extract-zip-failed', { zipPath, destinationDir, error: String(e) });
        return false;
    }
}

// ==========================================
// AUTO-INSTALL TOOLS
// ==========================================
export async function ensureStreamlinkInstalled(): Promise<boolean> {
    refreshBundledToolPaths();

    const current = getStreamlinkCommand();
    const versionArgs = [...current.prefixArgs, '--version'];
    if (isVerifiedStreamlinkCommand(current.command, versionArgs)) {
        return true;
    }

    if (canExecuteCommand(current.command, versionArgs)) {
        cacheVerifiedStreamlinkCommand(current.command, versionArgs);
        return true;
    }

    if (process.platform !== 'win32') {
        return false;
    }

    _appendDebugLog('streamlink-install-start');
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
            _appendDebugLog('streamlink-install-no-asset-found');
            return false;
        }

        const zipPath = path.join(_getTempPath(), `streamlink_portable_${Date.now()}.zip`);
        const downloadOk = await downloadFile(zipAsset.browser_download_url, zipPath);
        if (!downloadOk) return false;

        fs.rmSync(TOOLS_STREAMLINK_DIR, { recursive: true, force: true });
        fs.mkdirSync(TOOLS_STREAMLINK_DIR, { recursive: true });

        const extractOk = await extractZip(zipPath, TOOLS_STREAMLINK_DIR);
        try { fs.unlinkSync(zipPath); } catch { }
        if (!extractOk) return false;

        refreshBundledToolPaths(true);
        streamlinkCommandCache = null;

        const cmd = getStreamlinkCommand();
        const installedVersionArgs = [...cmd.prefixArgs, '--version'];
        const works = canExecuteCommand(cmd.command, installedVersionArgs);
        if (works) {
            cacheVerifiedStreamlinkCommand(cmd.command, installedVersionArgs);
        }
        _appendDebugLog('streamlink-install-finished', { works, command: cmd.command, prefixArgs: cmd.prefixArgs });
        return works;
    } catch (e) {
        _appendDebugLog('streamlink-install-failed', String(e));
        return false;
    }
}

export async function ensureFfmpegInstalled(): Promise<boolean> {
    refreshBundledToolPaths();

    const ffmpegPath = getFFmpegPath();
    const ffprobePath = getFFprobePath();
    if (isVerifiedFfmpegCommands(ffmpegPath, ffprobePath)) {
        return true;
    }

    if (canExecuteCommand(ffmpegPath, ['-version']) && canExecuteCommand(ffprobePath, ['-version'])) {
        cacheVerifiedFfmpegCommands(ffmpegPath, ffprobePath);
        return true;
    }

    if (process.platform !== 'win32') {
        return false;
    }

    _appendDebugLog('ffmpeg-install-start');
    try {
        fs.mkdirSync(TOOLS_FFMPEG_DIR, { recursive: true });

        const zipPath = path.join(_getTempPath(), `ffmpeg_essentials_${Date.now()}.zip`);
        const downloadOk = await downloadFile('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', zipPath);
        if (!downloadOk) return false;

        fs.rmSync(TOOLS_FFMPEG_DIR, { recursive: true, force: true });
        fs.mkdirSync(TOOLS_FFMPEG_DIR, { recursive: true });

        const extractOk = await extractZip(zipPath, TOOLS_FFMPEG_DIR);
        try { fs.unlinkSync(zipPath); } catch { }
        if (!extractOk) return false;

        refreshBundledToolPaths(true);

        const newFfmpegPath = getFFmpegPath();
        const newFfprobePath = getFFprobePath();
        const works = canExecuteCommand(newFfmpegPath, ['-version']) && canExecuteCommand(newFfprobePath, ['-version']);
        if (works) {
            cacheVerifiedFfmpegCommands(newFfmpegPath, newFfprobePath);
        }
        _appendDebugLog('ffmpeg-install-finished', { works, ffmpeg: newFfmpegPath, ffprobe: newFfprobePath });
        return works;
    } catch (e) {
        _appendDebugLog('ffmpeg-install-failed', String(e));
        return false;
    }
}

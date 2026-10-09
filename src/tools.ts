import * as path from 'path';
import * as fs from 'fs';
import { extractZipArchive } from './main/infra/extract-zip';
import { execFile, type ChildProcess } from 'child_process';
import axios from 'axios';
import { createManagedToolInstaller, type ManagedToolInstaller, type ManagedToolStatus } from './main/domain/managed-tools';
import { APPLICATION_TOOL_MANIFEST } from './main/domain/tool-manifest';

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
    managedToolInstallers.clear();
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
const managedToolInstallers = new Map<'streamlink' | 'ffmpeg', ManagedToolInstaller>();

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

let managedToolExecutionObserver: ((command: string) => void) | null = null;

export function setManagedToolExecutionObserver(observer: ((command: string) => void) | null): void {
    managedToolExecutionObserver = observer;
}

const pendingToolProcesses = new Set<ChildProcess>();
const commandChecks = new Map<string, { expires: number; result: Promise<boolean> }>();

export function canExecuteCommand(command: string, args: string[]): Promise<boolean> {
    const key = getCommandCacheKey(command, args);
    const cached = commandChecks.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    const entry = { expires: Infinity, result: Promise.resolve(false) };
    entry.result = new Promise<boolean>(resolve => {
        let child: ChildProcess | undefined;
        try {
            managedToolExecutionObserver?.(command);
            child = execFile(command, args, { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, error => {
                if (child) pendingToolProcesses.delete(child);
                entry.expires = Date.now() + (error ? 1000 : 10000);
                resolve(!error);
            });
            if (child) pendingToolProcesses.add(child);
        } catch {
            entry.expires = Date.now() + 1000;
            resolve(false);
        }
    });
    commandChecks.set(key, entry);
    return entry.result;
}

export function cancelPendingToolChecks(): void {
    for (const child of pendingToolProcesses) child.kill();
    pendingToolProcesses.clear();
    commandChecks.clear();
}

async function findExecutable(name: string): Promise<string | null> {
    const extensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        const cleanDirectory = directory.replace(/^"|"$/g, '');
        if (!cleanDirectory || (process.platform === 'win32' && /[\\/]WindowsApps(?:[\\/]|$)/i.test(cleanDirectory))) continue;
        for (const extension of extensions) {
            const candidate = path.join(cleanDirectory, name + extension);
            try { if ((await fs.promises.stat(candidate)).isFile()) return candidate; } catch { }
        }
    }
    return null;
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
    commandChecks.clear();
}

// ==========================================
// TOOL PATH DISCOVERY
// ==========================================
export async function getStreamlinkPath(): Promise<string> {
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

    const executable = await findExecutable('streamlink');
    if (executable) { streamlinkPathCache = executable; return executable; }

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

let streamlinkCommandPending: Promise<{ command: string; prefixArgs: string[] }> | null = null;

export async function getStreamlinkCommand(): Promise<{ command: string; prefixArgs: string[] }> {
    if (streamlinkCommandCache) return streamlinkCommandCache;
    if (streamlinkCommandPending) return streamlinkCommandPending;
    streamlinkCommandPending = resolveStreamlinkCommand();
    try { return await streamlinkCommandPending; }
    finally { streamlinkCommandPending = null; }
}

async function resolveStreamlinkCommand(): Promise<{ command: string; prefixArgs: string[] }> {
    const directPath = await getStreamlinkPath();
    if (directPath !== 'streamlink' || await canExecuteCommand(directPath, ['--version'])) {
        streamlinkCommandCache = { command: directPath, prefixArgs: [] };
        return streamlinkCommandCache;
    }
    const candidates = process.platform === 'win32'
        ? [{ name: 'py', args: ['-3', '-m', 'streamlink'] }, { name: 'python', args: ['-m', 'streamlink'] }]
        : [{ name: 'python3', args: ['-m', 'streamlink'] }, { name: 'python', args: ['-m', 'streamlink'] }];
    for (const candidate of candidates) {
        const command = await findExecutable(candidate.name);
        if (command && await canExecuteCommand(command, [...candidate.args, '--version'])) {
            streamlinkCommandCache = { command, prefixArgs: candidate.args };
            return streamlinkCommandCache;
        }
    }
    streamlinkCommandCache = { command: directPath, prefixArgs: [] };
    return streamlinkCommandCache;
}

export async function getFFmpegPath(): Promise<string> {
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

    const executable = await findExecutable('ffmpeg');
    if (executable) { ffmpegPathCache = executable; return executable; }

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

export async function getFFprobePath(): Promise<string> {
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

    const ffmpegPath = await getFFmpegPath();
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
            response.data.on('error', (err: Error) => {
                writer.destroy();
                reject(err);
            });
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

        await extractZipArchive(zipPath, destinationDir);

        return true;
    } catch (e) {
        _appendDebugLog('extract-zip-failed', { zipPath, destinationDir, error: String(e) });
        return false;
    }
}

function getManagedToolInstaller(toolId: 'streamlink' | 'ffmpeg'): ManagedToolInstaller {
    const existing = managedToolInstallers.get(toolId);
    if (existing) return existing;

    const installationDirectory = toolId === 'streamlink' ? TOOLS_STREAMLINK_DIR : TOOLS_FFMPEG_DIR;
    const installer = createManagedToolInstaller({
        installationDirectory,
        temporaryDirectory: _getTempPath(),
        download: async (sourceUrl, archivePath) => {
            if (!await downloadFile(sourceUrl, archivePath)) {
                throw new Error('tool archive download failed');
            }
        },
        extract: async (archivePath, destinationPath) => {
            if (!await extractZip(archivePath, destinationPath)) {
                throw new Error('tool archive extraction failed');
            }
        },
        diagnostic: (message, details) => _appendDebugLog(message, details)
    });
    managedToolInstallers.set(toolId, installer);
    return installer;
}

export interface ManagedToolStatuses {
    streamlink: ManagedToolStatus & { fallbackRunnable: boolean };
    ffmpeg: ManagedToolStatus & { fallbackRunnable: boolean };
}

export async function getManagedToolStatuses(): Promise<ManagedToolStatuses> {
    refreshBundledToolPaths();
    const streamlinkCommand = await getStreamlinkCommand();
    const streamlinkVersionArgs = [...streamlinkCommand.prefixArgs, '--version'];
    const ffmpegPath = await getFFmpegPath();
    const ffprobePath = await getFFprobePath();
    return {
        streamlink: {
            ...(await getManagedToolInstaller('streamlink').status(APPLICATION_TOOL_MANIFEST.streamlink)),
            fallbackRunnable: isVerifiedStreamlinkCommand(streamlinkCommand.command, streamlinkVersionArgs)
                || await fallbackToRunnableStreamlink(streamlinkCommand.command, streamlinkVersionArgs)
        },
        ffmpeg: {
            ...(await getManagedToolInstaller('ffmpeg').status(APPLICATION_TOOL_MANIFEST.ffmpeg)),
            fallbackRunnable: isVerifiedFfmpegCommands(ffmpegPath, ffprobePath)
                || await fallbackToRunnableFfmpeg(ffmpegPath, ffprobePath)
        }
    };
}

export async function repairManagedTools(): Promise<{ success: boolean; statuses: ManagedToolStatuses }> {
    const [streamlink, ffmpeg] = await Promise.all([
        getManagedToolInstaller('streamlink').repair(APPLICATION_TOOL_MANIFEST.streamlink),
        getManagedToolInstaller('ffmpeg').repair(APPLICATION_TOOL_MANIFEST.ffmpeg)
    ]);
    refreshBundledToolPaths(true);
    return {
        success: streamlink.success && ffmpeg.success,
        statuses: await getManagedToolStatuses()
    };
}

export async function resetManagedTools(): Promise<{ success: boolean; statuses: ManagedToolStatuses }> {
    const [streamlink, ffmpeg] = await Promise.all([
        getManagedToolInstaller('streamlink').reset(APPLICATION_TOOL_MANIFEST.streamlink),
        getManagedToolInstaller('ffmpeg').reset(APPLICATION_TOOL_MANIFEST.ffmpeg)
    ]);
    refreshBundledToolPaths(true);
    return {
        success: streamlink.state !== 'installing' && ffmpeg.state !== 'installing',
        statuses: await getManagedToolStatuses()
    };
}

// ==========================================
// AUTO-INSTALL TOOLS
// ==========================================
async function fallbackToRunnableStreamlink(command: string, versionArgs: string[]): Promise<boolean> {
    if (!await canExecuteCommand(command, versionArgs)) {
        return false;
    }
    cacheVerifiedStreamlinkCommand(command, versionArgs);
    return true;
}

async function fallbackToRunnableFfmpeg(ffmpegPath: string, ffprobePath: string): Promise<boolean> {
    if (!await canExecuteCommand(ffmpegPath, ['-version']) || !await canExecuteCommand(ffprobePath, ['-version'])) {
        return false;
    }
    cacheVerifiedFfmpegCommands(ffmpegPath, ffprobePath);
    return true;
}

export async function ensureStreamlinkInstalled(): Promise<boolean> {
    refreshBundledToolPaths();

    const manifest = APPLICATION_TOOL_MANIFEST.streamlink;
    const managedStatus = await getManagedToolInstaller('streamlink').status(manifest);
    const requiresManagedRepair = Boolean(bundledStreamlinkPath) && !managedStatus.verified;
    const current = await getStreamlinkCommand();
    const versionArgs = [...current.prefixArgs, '--version'];
    if (!requiresManagedRepair && isVerifiedStreamlinkCommand(current.command, versionArgs)) {
        return true;
    }

    if (!requiresManagedRepair && await canExecuteCommand(current.command, versionArgs)) {
        cacheVerifiedStreamlinkCommand(current.command, versionArgs);
        return true;
    }

    if (process.platform !== 'win32') {
        return fallbackToRunnableStreamlink(current.command, versionArgs);
    }

    _appendDebugLog('streamlink-install-start');
    try {
        const result = await getManagedToolInstaller('streamlink').install(manifest);
        if (!result.success) {
            _appendDebugLog('streamlink-install-failed', { error: result.error, status: result.status });
            return fallbackToRunnableStreamlink(current.command, versionArgs);
        }

        refreshBundledToolPaths(true);
        streamlinkCommandCache = null;

        const cmd = await getStreamlinkCommand();
        const installedVersionArgs = [...cmd.prefixArgs, '--version'];
        const works = await canExecuteCommand(cmd.command, installedVersionArgs);
        if (works) {
            cacheVerifiedStreamlinkCommand(cmd.command, installedVersionArgs);
        }
        _appendDebugLog('streamlink-install-finished', { works, command: cmd.command, prefixArgs: cmd.prefixArgs });
        return works || await fallbackToRunnableStreamlink(current.command, versionArgs);
    } catch (e) {
        _appendDebugLog('streamlink-install-failed', String(e));
        return fallbackToRunnableStreamlink(current.command, versionArgs);
    }
}

export async function ensureFfmpegInstalled(): Promise<boolean> {
    refreshBundledToolPaths();

    const manifest = APPLICATION_TOOL_MANIFEST.ffmpeg;
    const managedStatus = await getManagedToolInstaller('ffmpeg').status(manifest);
    const requiresManagedRepair = Boolean(bundledFFmpegPath || bundledFFprobePath) && !managedStatus.verified;
    const ffmpegPath = await getFFmpegPath();
    const ffprobePath = await getFFprobePath();
    if (!requiresManagedRepair && isVerifiedFfmpegCommands(ffmpegPath, ffprobePath)) {
        return true;
    }

    if (!requiresManagedRepair && await canExecuteCommand(ffmpegPath, ['-version']) && await canExecuteCommand(ffprobePath, ['-version'])) {
        cacheVerifiedFfmpegCommands(ffmpegPath, ffprobePath);
        return true;
    }

    if (process.platform !== 'win32') {
        return fallbackToRunnableFfmpeg(ffmpegPath, ffprobePath);
    }

    _appendDebugLog('ffmpeg-install-start');
    try {
        const result = await getManagedToolInstaller('ffmpeg').install(manifest);
        if (!result.success) {
            _appendDebugLog('ffmpeg-install-failed', { error: result.error, status: result.status });
            return fallbackToRunnableFfmpeg(ffmpegPath, ffprobePath);
        }

        refreshBundledToolPaths(true);

        const newFfmpegPath = await getFFmpegPath();
        const newFfprobePath = await getFFprobePath();
        const works = await canExecuteCommand(newFfmpegPath, ['-version']) && await canExecuteCommand(newFfprobePath, ['-version']);
        if (works) {
            cacheVerifiedFfmpegCommands(newFfmpegPath, newFfprobePath);
        }
        _appendDebugLog('ffmpeg-install-finished', { works, ffmpeg: newFfmpegPath, ffprobe: newFfprobePath });
        return works || await fallbackToRunnableFfmpeg(ffmpegPath, ffprobePath);
    } catch (e) {
        _appendDebugLog('ffmpeg-install-failed', String(e));
        return fallbackToRunnableFfmpeg(ffmpegPath, ffprobePath);
    }
}

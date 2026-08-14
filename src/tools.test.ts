import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

vi.mock('axios', () => ({
    default: {
        get: vi.fn()
    }
}));

vi.mock('child_process', () => ({
    spawn: vi.fn(),
    execSync: vi.fn(() => {
        throw new Error('not on PATH');
    }),
    spawnSync: vi.fn(() => ({ status: 1 }))
}));

interface ToolsModule {
    initToolDirs(streamlinkDir: string, ffmpegDir: string, getTempPath: () => string): void;
    setDebugLogFn(fn: (message: string, details?: unknown) => void): void;
    ensureStreamlinkInstalled(): Promise<boolean>;
    ensureFfmpegInstalled(): Promise<boolean>;
    getManagedToolStatuses(): Promise<{
        streamlink: { state: string; verified: boolean; fallbackRunnable: boolean };
        ffmpeg: { state: string; verified: boolean; fallbackRunnable: boolean };
    }>;
}

const originalPlatform = process.platform;
let tempRoot: string;
let streamlinkDir: string;
let ffmpegDir: string;
let debugMessages: string[];

function forcePlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function writeUnverifiedStreamlinkInstall(): string {
    const binDir = path.join(streamlinkDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exePath = path.join(binDir, 'streamlink.exe');
    fs.writeFileSync(exePath, 'dummy-streamlink-binary');
    return exePath;
}

function writeUnverifiedFfmpegInstall(): { ffmpegPath: string; ffprobePath: string } {
    const binDir = path.join(ffmpegDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const ffmpegPath = path.join(binDir, 'ffmpeg.exe');
    const ffprobePath = path.join(binDir, 'ffprobe.exe');
    fs.writeFileSync(ffmpegPath, 'dummy-ffmpeg-binary');
    fs.writeFileSync(ffprobePath, 'dummy-ffprobe-binary');
    return { ffmpegPath, ffprobePath };
}

async function loadTools(): Promise<{ tools: ToolsModule; axiosGet: ReturnType<typeof vi.fn>; spawnSync: ReturnType<typeof vi.fn> }> {
    vi.resetModules();
    const axios = (await import('axios')).default as unknown as { get: ReturnType<typeof vi.fn> };
    const childProcess = await import('child_process') as unknown as { spawnSync: ReturnType<typeof vi.fn> };
    const tools = await import('./tools') as unknown as ToolsModule;
    tools.initToolDirs(streamlinkDir, ffmpegDir, () => path.join(tempRoot, 'tmp'));
    tools.setDebugLogFn((message) => {
        debugMessages.push(message);
    });
    return { tools, axiosGet: axios.get, spawnSync: childProcess.spawnSync };
}

function allowExecutionOf(spawnSync: ReturnType<typeof vi.fn>, runnablePaths: string[]): void {
    spawnSync.mockImplementation((command: string) => (
        runnablePaths.includes(command) ? { status: 0 } : { status: 1 }
    ));
}

beforeEach(() => {
    forcePlatform('win32');
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-tools-test-'));
    streamlinkDir = path.join(tempRoot, 'tools', 'streamlink');
    ffmpegDir = path.join(tempRoot, 'tools', 'ffmpeg');
    fs.mkdirSync(streamlinkDir, { recursive: true });
    fs.mkdirSync(ffmpegDir, { recursive: true });
    debugMessages = [];
});

afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('ensureStreamlinkInstalled with an unverified managed install', () => {
    it('returns true when the forced repair download fails but the existing streamlink runs', async () => {
        const exePath = writeUnverifiedStreamlinkInstall();
        const { tools, axiosGet, spawnSync } = await loadTools();
        allowExecutionOf(spawnSync, [exePath]);
        axiosGet.mockRejectedValue(new Error('offline'));

        await expect(tools.ensureStreamlinkInstalled()).resolves.toBe(true);
        expect(debugMessages).toContain('streamlink-install-start');
        expect(debugMessages).toContain('streamlink-install-failed');
    });

    it('returns false when the forced repair fails and the existing streamlink does not run', async () => {
        writeUnverifiedStreamlinkInstall();
        const { tools, axiosGet, spawnSync } = await loadTools();
        allowExecutionOf(spawnSync, []);
        axiosGet.mockRejectedValue(new Error('offline'));

        await expect(tools.ensureStreamlinkInstalled()).resolves.toBe(false);
        expect(debugMessages).toContain('streamlink-install-failed');
    });

    it('resolves instead of hanging when the download response stream errors mid-transfer', async () => {
        const exePath = writeUnverifiedStreamlinkInstall();
        const { tools, axiosGet, spawnSync } = await loadTools();
        allowExecutionOf(spawnSync, [exePath]);
        const brokenStream = new PassThrough();
        let errorScheduled = false;
        brokenStream.on('newListener', (event) => {
            if (event === 'error' && !errorScheduled) {
                errorScheduled = true;
                setImmediate(() => brokenStream.emit('error', new Error('connection reset')));
            }
        });
        axiosGet.mockResolvedValue({ data: brokenStream });

        await expect(tools.ensureStreamlinkInstalled()).resolves.toBe(true);
        expect(debugMessages).toContain('streamlink-install-failed');
    }, 8000);
});

describe('getManagedToolStatuses fallback availability', () => {
    it('reports a runnable unverified install as still downloadable', async () => {
        const exePath = writeUnverifiedStreamlinkInstall();
        const { tools, spawnSync } = await loadTools();
        allowExecutionOf(spawnSync, [exePath]);

        const statuses = await tools.getManagedToolStatuses();
        expect(statuses.streamlink.verified).toBe(false);
        expect(statuses.streamlink.fallbackRunnable).toBe(true);
        expect(statuses.ffmpeg.fallbackRunnable).toBe(false);
    });

    it('reports nothing runnable when no installation responds', async () => {
        writeUnverifiedStreamlinkInstall();
        const { tools, spawnSync } = await loadTools();
        allowExecutionOf(spawnSync, []);

        const statuses = await tools.getManagedToolStatuses();
        expect(statuses.streamlink.fallbackRunnable).toBe(false);
        expect(statuses.ffmpeg.fallbackRunnable).toBe(false);
    });
});

describe('ensureFfmpegInstalled with an unverified managed install', () => {
    it('returns true when the forced repair download fails but the existing ffmpeg and ffprobe run', async () => {
        const { ffmpegPath, ffprobePath } = writeUnverifiedFfmpegInstall();
        const { tools, axiosGet, spawnSync } = await loadTools();
        allowExecutionOf(spawnSync, [ffmpegPath, ffprobePath]);
        axiosGet.mockRejectedValue(new Error('offline'));

        await expect(tools.ensureFfmpegInstalled()).resolves.toBe(true);
        expect(debugMessages).toContain('ffmpeg-install-start');
        expect(debugMessages).toContain('ffmpeg-install-failed');
    });

    it('returns false when the forced repair fails and the existing ffmpeg does not run', async () => {
        writeUnverifiedFfmpegInstall();
        const { tools, axiosGet, spawnSync } = await loadTools();
        allowExecutionOf(spawnSync, []);
        axiosGet.mockRejectedValue(new Error('offline'));

        await expect(tools.ensureFfmpegInstalled()).resolves.toBe(false);
        expect(debugMessages).toContain('ffmpeg-install-failed');
    });
});

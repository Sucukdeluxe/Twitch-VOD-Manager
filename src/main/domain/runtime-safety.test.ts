import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    readSecretSafely,
    createManagedToolExecutionTracker,
    runResilientSteps,
    secureImportedConfigTransition,
} from './runtime-safety';

describe('runtime safety', () => {
    it('isolates a secret read failure without invalidating the store', () => {
        const onError = vi.fn();
        const store = {
            get: vi.fn((key: string) => {
                if (key === 'broken') throw new Error('foreign DPAPI ciphertext');
                return 'usable';
            }),
        };

        expect(readSecretSafely(store, 'broken', onError)).toBe('');
        expect(readSecretSafely(store, 'valid', onError)).toBe('usable');
        expect(onError).toHaveBeenCalledOnce();
    });

    it('does not activate an imported all-files delete policy from a safe state', () => {
        expect(secureImportedConfigTransition(
            { auto_cleanup_enabled: false, auto_cleanup_target: 'live_only', auto_cleanup_action: 'archive' },
            { auto_cleanup_enabled: true, auto_cleanup_target: 'all', auto_cleanup_action: 'delete' },
        )).toEqual({ auto_cleanup_enabled: false, auto_cleanup_target: 'all', auto_cleanup_action: 'delete' });
    });

    it('does not alter an already active cleanup policy when unrelated values are imported', () => {
        expect(secureImportedConfigTransition(
            { auto_cleanup_enabled: true, auto_cleanup_target: 'all', auto_cleanup_action: 'delete' },
            { language: 'en' },
        )).toEqual({ language: 'en' });
    });

    it('runs every cleanup step after earlier failures', async () => {
        const calls: string[] = [];
        const errors: Array<{ name: string; error: unknown }> = [];

        await runResilientSteps([
            ['persist-config', () => { calls.push('persist-config'); throw new Error('disk full'); }],
            ['persist-queue', async () => { calls.push('persist-queue'); }],
            ['cleanup-partial', () => { calls.push('cleanup-partial'); }],
        ], (name, error) => errors.push({ name, error }));

        expect(calls).toEqual(['persist-config', 'persist-queue', 'cleanup-partial']);
        expect(errors.map((entry) => entry.name)).toEqual(['persist-config']);
    });

    it('continues cleanup when failure reporting itself throws', async () => {
        const calls: string[] = [];

        await runResilientSteps([
            ['first', () => { calls.push('first'); throw new Error('cleanup failed'); }],
            ['second', () => { calls.push('second'); }],
        ], () => {
            throw new Error('reporting failed');
        });

        expect(calls).toEqual(['first', 'second']);
    });

    it('records native canonical paths and execution counts only while the cutter E2E gate is enabled', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-tool-diagnostics-'));
        const nested = path.join(directory, 'nested');
        fs.mkdirSync(nested);
        const ffmpeg = path.join(directory, 'ffmpeg.exe');
        const ffprobe = path.join(directory, 'ffprobe.exe');
        const streamlink = path.join(directory, 'streamlink.exe');
        for (const filePath of [ffmpeg, ffprobe, streamlink]) fs.writeFileSync(filePath, 'tool');
        try {
            const disabled = createManagedToolExecutionTracker(false);
            disabled.record('ffmpeg', ffmpeg);
            expect(disabled.snapshot()).toBeNull();
            const tracker = createManagedToolExecutionTracker(true);
            tracker.record('ffmpeg', path.join(nested, '..', 'ffmpeg.exe'));
            tracker.record('ffmpeg', ffmpeg);
            tracker.record('ffprobe', path.join(nested, '..', 'ffprobe.exe'));
            tracker.record('streamlink', path.join(nested, '..', 'streamlink.exe'));
            expect(tracker.snapshot()).toEqual({
                ffmpeg: { path: fs.realpathSync.native(ffmpeg), count: 2 },
                ffprobe: { path: fs.realpathSync.native(ffprobe), count: 1 },
                streamlink: { path: fs.realpathSync.native(streamlink), count: 1 },
            });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

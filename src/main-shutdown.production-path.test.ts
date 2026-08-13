import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, test, vi } from 'vitest';

function mainSource(): string {
    return readFileSync(join(__dirname, 'main.ts'), 'utf8');
}

function sourceFragment(start: string, end: string): string {
    const source = mainSource();
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error('Missing main production fragment');
    return source.slice(from, to);
}

describe('main shutdown production paths', () => {
    test('does not spawn a cutter probe after shutdown starts', async () => {
        const spawn = vi.fn(() => {
            const child = Object.assign(new EventEmitter(), {
                stderr: { resume: () => undefined },
                stdout: new EventEmitter(),
                kill: () => true,
            });
            queueMicrotask(() => child.emit('close', 0));
            return child;
        });
        const context: Record<string, unknown> = {
            appShutdownStarted: true,
            spawn,
            getFFmpegPath: () => 'ffmpeg.exe',
            currentCutterProbeProcesses: new Set(),
            setTimeout,
            clearTimeout,
            globalThis: null,
        };
        context.globalThis = context;
        const fragment = sourceFragment('async function runCutterFfmpegProbe', 'async function getCutterHardwareEncoders');
        const compiled = transpileModule(`${fragment}\nglobalThis.__runCutterFfmpegProbe = runCutterFfmpegProbe;`, {
            compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
        }).outputText;
        runInNewContext(compiled, context);

        const result = await (context.__runCutterFfmpegProbe as (args: string[], capture: boolean) => Promise<{ success: boolean; output: string }>)([], false);

        expect(result).toEqual({ success: false, output: '' });
        expect(spawn).not.toHaveBeenCalled();
    });

    test('applies imported configuration through the shared transition before returning success', () => {
        const handler = sourceFragment("ipcMain.handle('import-config'", 'function isTrustedRendererEvent');
        const transition = sourceFragment('function applyConfigTransition', "ipcMain.handle('save-config'");
        const appliedTransition = handler.indexOf('applyConfigTransition(previousConfig, merged);');
        const returned = handler.indexOf('return { success: true');
        const persisted = transition.indexOf('config = persistStateChange');
        const appliedTheme = transition.indexOf('nativeTheme.themeSource = resolveNativeThemeSource(config.theme)');

        expect(persisted).toBeGreaterThan(-1);
        expect(appliedTheme).toBeGreaterThan(persisted);
        expect(appliedTransition).toBeGreaterThan(-1);
        expect(returned).toBeGreaterThan(appliedTransition);
    });
});

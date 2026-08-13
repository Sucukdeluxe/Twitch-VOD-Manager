import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, test } from 'vitest';

function sourceFragment(start: string, end: string): string {
    const source = readFileSync(join(__dirname, 'renderer-cutter.ts'), 'utf8');
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error('Missing renderer cutter production fragment');
    return source.slice(from, to);
}

function streamerSourceFragment(start: string, end: string): string {
    const source = readFileSync(join(__dirname, 'renderer-streamers.ts'), 'utf8');
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error('Missing renderer streamers production fragment');
    return source.slice(from, to);
}

function cutterFileValidationFragment(): string {
    return streamerSourceFragment('function isSupportedCutterVideoFile', 'function initCutterDragDrop');
}

function evaluate(source: string, context: Record<string, unknown>, expose: string): Record<string, (...args: unknown[]) => unknown> {
    context.globalThis = context;
    context.window = context;
    const compiled = transpileModule(`${source}\nObject.assign(globalThis, { __cutterProductionPath: { ${expose} } });`, {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, context);
    return (context as { __cutterProductionPath: Record<string, (...args: unknown[]) => unknown> }).__cutterProductionPath;
}

interface FakeOption {
    value: string;
    textContent: string;
}

interface FakeSelect {
    value: string;
    disabled: boolean;
    options: FakeOption[];
    replaceChildren(...children: FakeOption[]): void;
    append(child: FakeOption): void;
}

function createCutterSelects(): Map<string, FakeSelect> {
    const createSelect = (): FakeSelect => ({
        value: '',
        disabled: false,
        options: [],
        replaceChildren(...children) { this.options = [...children]; },
        append(child) { this.options.push(child); },
    });
    return new Map([
        ['cutterAudioStream', createSelect()],
        ['cutterExportProfile', createSelect()],
        ['cutterExportEncoder', createSelect()],
    ]);
}

describe('cutter production paths', () => {
    test('rejects a PNG drop before requesting a capability or loader', async () => {
        const listeners = new Map<string, (event: Record<string, unknown>) => Promise<void> | void>();
        let capabilityRequests = 0;
        let loadRequests = 0;
        const toasts: Array<[string, string]> = [];
        const tab = {
            addEventListener: (name: string, listener: (event: Record<string, unknown>) => Promise<void> | void) => listeners.set(name, listener),
        };
        const preview = { classList: { toggle: () => undefined } };
        const api = evaluate(`${cutterFileValidationFragment()}\n${streamerSourceFragment('function initCutterDragDrop', 'let streamerContextMenu')}`, {
            document: { getElementById: (id: string) => id === 'cutterTab' ? tab : preview },
            UI_TEXT: { cutter: { unsupportedFile: 'unsupported' } },
            showAppToast: (message: string, type: string) => toasts.push([message, type]),
            requestCutterVideoReplacement: async () => { loadRequests += 1; },
            api: {
                selectDroppedVideo: async () => {
                    capabilityRequests += 1;
                    return { token: 'png-capability', name: 'frame.png' };
                },
            },
        }, 'initCutterDragDrop');
        api.initCutterDragDrop();

        await listeners.get('drop')?.({
            dataTransfer: { files: [{ name: 'frame.png', type: 'image/png' }] },
            preventDefault: () => undefined,
        });

        expect(toasts).toEqual([['unsupported', 'warn']]);
        expect(capabilityRequests).toBe(0);
        expect(loadRequests).toBe(0);
    });

    test('opens a saved project without first overwriting its autosave', async () => {
        let saves = 0;
        let opens = 0;
        const api = evaluate(sourceFragment('async function openCutterProject', 'function setCutterExportProfile'), {
            cutterFile: { token: 'source-capability' },
            persistCutterProject: async () => { saves += 1; return true; },
            applyCutterProject: () => true,
            renderCutterProjectRecovery: () => undefined,
            showAppToast: () => undefined,
            api: {
                openCutterProject: async () => {
                    opens += 1;
                    return { trimStart: 42 };
                },
            },
        }, 'openCutterProject');

        await api.openCutterProject();

        expect(opens).toBe(1);
        expect(saves).toBe(0);
    });

    test('does not autosave while recovery still requires a user decision', async () => {
        const scheduled: Array<() => void> = [];
        let saves = 0;
        const file = { token: 'source-capability' };
        const api = evaluate(sourceFragment('function scheduleCutterAutosave', 'function renderCutterProjectRecovery'), {
            cutterAutosaveTimer: null,
            cutterRecoveryDecisionPending: true,
            cutterFile: file,
            persistCutterProject: async () => { saves += 1; return true; },
            setTimeout: (callback: () => void) => {
                scheduled.push(callback);
                return scheduled.length;
            },
            clearTimeout: () => undefined,
        }, 'scheduleCutterAutosave');

        api.scheduleCutterAutosave();
        scheduled[0]();
        await Promise.resolve();

        expect(saves).toBe(0);
    });

    test('keeps a recovered hardware encoder while export options are still loading', () => {
        const selects = createCutterSelects();
        const context: Record<string, unknown> = {
            cutterEditorState: { duration: 90, fps: 30, trimStart: 0, trimEnd: 90, cuts: [] },
            cutterVideoInfo: {
                duration: 90,
                fps: 30,
                audioStreams: [{ index: 0, language: 'deu', codec: 'aac', channels: 2 }],
            },
            cutterExportProfile: 'balanced',
            cutterExportEncoder: 'software',
            cutterAudioStreamIndex: 0,
            cutterExportOptions: undefined,
            cutterHistoryPast: [],
            cutterHistoryFuture: [],
            cutterActiveCutId: null,
            byId: (id: string) => selects.get(id),
            document: { createElement: () => ({ value: '', textContent: '' }) },
            renderCutterEditor: () => undefined,
            seekCutterVideo: () => undefined,
        };
        const api = evaluate(sourceFragment('function updateCutterAudioStreams', 'async function recoverCutterProject'), context, 'applyCutterProject, updateCutterExportControls');

        const applied = api.applyCutterProject({
            duration: 90,
            fps: 30,
            trimStart: 12,
            trimEnd: 80,
            cuts: [],
            profile: 'balanced',
            encoder: 'h264_nvenc',
            audioStreamIndex: 0,
        });

        expect(applied).toBe(true);
        expect(context.cutterExportEncoder).toBe('h264_nvenc');
        expect(selects.get('cutterExportEncoder')?.options.map((option) => option.value)).toContain('h264_nvenc');
        expect(selects.get('cutterExportEncoder')?.value).toBe('h264_nvenc');
        expect(selects.get('cutterExportEncoder')?.disabled).toBe(true);

        api.updateCutterExportControls({
            profiles: [
                { id: 'quality', label: 'Quality', container: 'mp4' },
                { id: 'balanced', label: 'Balanced', container: 'mp4' },
                { id: 'fast', label: 'Fast', container: 'mp4' },
                { id: 'archive', label: 'Archive', container: 'mkv' },
            ],
            hardwareEncoders: ['h264_nvenc'],
        });

        expect(context.cutterExportEncoder).toBe('h264_nvenc');
        expect(selects.get('cutterExportEncoder')?.value).toBe('h264_nvenc');
        expect(selects.get('cutterExportEncoder')?.disabled).toBe(false);
    });

    test('falls back to software when the export-option probe finishes without options', async () => {
        const file = { token: 'source-capability', name: 'source.mp4' };
        const selects = createCutterSelects();
        const context: Record<string, unknown> = {
            cutterExportProfile: 'balanced',
            cutterExportEncoder: 'h264_nvenc',
            cutterExportOptions: undefined,
            cutterLoadGeneration: 4,
            cutterFile: file,
            byId: (id: string) => selects.get(id),
            document: { createElement: () => ({ value: '', textContent: '' }) },
            api: { getCutterExportOptions: async () => { throw new Error('probe failed'); } },
        };
        const api = evaluate(sourceFragment('function updateCutterExportControls', 'function applyCutterProject'), context, 'updateCutterExportControls, loadCutterExportOptions');

        api.updateCutterExportControls(undefined);
        expect(context.cutterExportEncoder).toBe('h264_nvenc');

        await api.loadCutterExportOptions(file, 4);

        expect(context.cutterExportEncoder).toBe('software');
        expect(selects.get('cutterExportEncoder')?.value).toBe('software');
        expect(selects.get('cutterExportEncoder')?.disabled).toBe(true);
    });

    test('offers recovery before enabling edits or starting the encoder probe', async () => {
        const events: string[] = [];
        const elements = new Map<string, Record<string, unknown>>();
        const element = (): Record<string, unknown> => ({
            hidden: false,
            disabled: false,
            textContent: '',
            value: '1',
            classList: { add: () => undefined, remove: () => undefined },
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
            removeAttribute: () => undefined,
        });
        [
            'cutterPreview', 'cutterPlayerLoading', 'cutterPreviewEmpty', 'cutterWorkspace', 'btnCut', 'cutterZoom', 'cutterFilePath',
            'cutterInfo', 'timelineContainer', 'infoDuration', 'infoResolution', 'infoFps', 'cutterTotalTime', 'cutterWaveform',
            'cutterAudioEmpty', 'cutterPlaybackRate',
        ].forEach((id) => elements.set(id, element()));
        const video = { pause: () => undefined, removeAttribute: () => undefined, load: () => undefined, src: '', playbackRate: 1 };
        const file = { token: 'source-capability', name: 'source.mp4' };
        const api = evaluate(sourceFragment('async function loadCutterFromPath', 'function resolveCutterDiscard'), {
            isCutting: false,
            cutterLoadGeneration: 0,
            cutterEditorState: null,
            cutterFile: null,
            cutterMediaJobId: null,
            cutterAssetsPixelWidth: 0,
            cutterAssetsPixelHeight: 0,
            cutterAssetsInFlightJobId: null,
            cutterAssetsInFlightPixelWidth: 0,
            cutterAssetsInFlightPixelHeight: 0,
            cutterAssetRefreshTimer: null,
            cutterVideoInfo: null,
            cutterHistoryPast: [],
            cutterHistoryFuture: [],
            cutterActiveCutId: null,
            cutterExportProfile: 'balanced',
            cutterExportEncoder: 'software',
            cutterAudioStreamIndex: 0,
            cutterZoom: 1,
            byId: (id: string) => elements.get(id),
            getCutterVideo: () => video,
            stopCutterPlaybackFrameSync: () => undefined,
            cancelCutterScrubFrames: () => undefined,
            updateCutterPlayUi: () => undefined,
            setCutterControlsEnabled: (enabled: boolean) => events.push(enabled ? 'enable' : 'disable'),
            renderCutterProjectRecovery: (project: unknown) => { if (project) events.push('offer'); },
            updateCutterAudioStreams: () => undefined,
            getInitialCutterZoom: () => 1,
            animateCutterWorkspaceReveal: () => undefined,
            renderCutterThumbnails: () => undefined,
            updateCutterZoom: () => undefined,
            renderCutterEditor: () => undefined,
            updateCutterPlayhead: () => undefined,
            formatCutterTimecode: () => '00:00:00',
            loadCutterExportOptions: async () => { events.push('probe'); },
            requestCutterWaveform: () => undefined,
            requestCutterAssets: () => undefined,
            showAppToast: () => undefined,
            UI_TEXT: { cutter: { unsupportedFile: 'unsupported' } },
            clearTimeout: () => undefined,
            api: {
                prepareVideoEditorMedia: async () => ({
                    jobId: 7,
                    sourceUrl: 'file:///source.mp4',
                    thumbnails: [],
                    info: { duration: 90, fps: 30, width: 1920, height: 1080, hasAudio: true, audioStreams: [{ index: 0 }] },
                }),
                getCutterProjectRecovery: async () => {
                    events.push('recovery');
                    return { trimStart: 12 };
                },
            },
        }, 'loadCutterFromPath');

        await api.loadCutterFromPath(file);
        await Promise.resolve();
        await Promise.resolve();

        expect(events.indexOf('recovery')).toBeLessThan(events.indexOf('enable'));
        expect(events.indexOf('offer')).toBeLessThan(events.indexOf('probe'));
    });

    test('rejects an unsupported file returned by the video dialog before replacement', async () => {
        let replacements = 0;
        const toasts: Array<[string, string]> = [];
        const api = evaluate(`${cutterFileValidationFragment()}\n${sourceFragment('async function selectCutterVideo', 'function updateTimeFromInput')}`, {
            requestCutterVideoReplacement: async () => { replacements += 1; },
            showAppToast: (message: string, type: string) => toasts.push([message, type]),
            UI_TEXT: { cutter: { unsupportedFile: 'unsupported' } },
            api: { selectVideoFile: async () => ({ token: 'png-capability', name: 'frame.png' }) },
        }, 'selectCutterVideo');

        await api.selectCutterVideo();

        expect(replacements).toBe(0);
        expect(toasts).toEqual([['unsupported', 'warn']]);
    });

    test('turns a rejected video dialog request into an unsupported-file warning', async () => {
        let replacements = 0;
        const toasts: Array<[string, string]> = [];
        const api = evaluate(`${cutterFileValidationFragment()}\n${sourceFragment('async function selectCutterVideo', 'function updateTimeFromInput')}`, {
            requestCutterVideoReplacement: async () => { replacements += 1; },
            showAppToast: (message: string, type: string) => toasts.push([message, type]),
            UI_TEXT: { cutter: { unsupportedFile: 'unsupported' } },
            api: { selectVideoFile: async () => { throw new Error('invalid dialog selection'); } },
        }, 'selectCutterVideo');

        await api.selectCutterVideo();

        expect(replacements).toBe(0);
        expect(toasts).toEqual([['unsupported', 'warn']]);
    });
});

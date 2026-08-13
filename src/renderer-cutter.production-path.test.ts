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

const englishCutterChoiceTexts = {
    noAudio: 'No audio track',
    audioStream: 'Audio track {index}',
    channelSingular: 'channel',
    channelPlural: 'channels',
    profileQuality: 'Quality',
    profileBalanced: 'Balanced',
    profileFast: 'Fast',
    profileArchive: 'Archive',
    encoderSoftware: 'Software',
    encoderNvenc: 'NVIDIA NVENC',
    encoderQsv: 'Intel Quick Sync',
    encoderAmf: 'AMD AMF',
};

describe('cutter production paths', () => {
    test('uses unambiguous frame timecodes and accepts pasted HH:MM:SS values', () => {
        const context = {
            cutterEditorState: { fps: 30, duration: 90 },
            cutterVideoInfo: null,
            snapCutterTime: (value: number) => value,
        };
        const api = evaluate(
            sourceFragment('function formatCutterTimecode', 'function getCutterVideo'),
            context,
            'formatCutterTimecode, parseCutterTimecode',
        );

        expect(api.formatCutterTimecode(1.5)).toBe('00:00:01:15');
        expect(api.parseCutterTimecode('00:01:15')).toBe(75);
        expect(api.parseCutterTimecode('00:00:01:15')).toBe(1.5);
    });

    test.each([
        {
            language: 'de',
            texts: {
                recoveryFound: 'Gespeicherte Bearbeitung gefunden',
                noAudio: 'Keine Audiospur',
                audioStream: 'Audiospur {index}',
                channelSingular: 'Kanal',
                channelPlural: 'Kanäle',
                profileQuality: 'Qualität',
                profileBalanced: 'Ausgewogen',
                profileFast: 'Schnell',
                profileArchive: 'Archiv',
                encoderSoftware: 'Software',
                encoderNvenc: 'NVIDIA NVENC',
                encoderQsv: 'Intel Quick Sync',
                encoderAmf: 'AMD AMF',
            },
            expectedAudio: ['Audiospur 1 (deu · aac · 1 Kanal)', 'Audiospur 3 (eng · opus · 2 Kanäle)'],
            expectedProfiles: ['Qualität', 'Ausgewogen', 'Schnell', 'Archiv'],
        },
        {
            language: 'en',
            texts: {
                recoveryFound: 'Saved edit found',
                noAudio: 'No audio track',
                audioStream: 'Audio track {index}',
                channelSingular: 'channel',
                channelPlural: 'channels',
                profileQuality: 'Quality',
                profileBalanced: 'Balanced',
                profileFast: 'Fast',
                profileArchive: 'Archive',
                encoderSoftware: 'Software',
                encoderNvenc: 'NVIDIA NVENC',
                encoderQsv: 'Intel Quick Sync',
                encoderAmf: 'AMD AMF',
            },
            expectedAudio: ['Audio track 1 (deu · aac · 1 channel)', 'Audio track 3 (eng · opus · 2 channels)'],
            expectedProfiles: ['Quality', 'Balanced', 'Fast', 'Archive'],
        },
    ])('renders $language recovery, audio and export choices from the active cutter locale', ({ texts, expectedAudio, expectedProfiles }) => {
        const selects = createCutterSelects();
        const recoveryPanel = { hidden: true };
        const recoveryText = { textContent: '' };
        const context: Record<string, unknown> = {
            cutterPendingProject: null,
            cutterVideoInfo: {
                audioStreams: [
                    { index: 0, language: 'deu', codec: 'aac', channels: 1 },
                    { index: 2, language: 'eng', codec: 'opus', channels: 2 },
                ],
            },
            cutterAudioStreamIndex: 0,
            cutterExportProfile: 'balanced',
            cutterExportEncoder: 'software',
            UI_TEXT: { cutter: texts },
            byId: (id: string) => id === 'cutterRecoveryPanel'
                ? recoveryPanel
                : id === 'cutterRecoveryText'
                    ? recoveryText
                    : selects.get(id),
            document: { createElement: () => ({ value: '', textContent: '' }) },
        };
        const api = evaluate(sourceFragment('function renderCutterProjectRecovery', 'async function loadCutterExportOptions'), context, 'renderCutterProjectRecovery, updateCutterAudioStreams, updateCutterExportControls');

        api.renderCutterProjectRecovery({ trimStart: 12 });
        api.updateCutterAudioStreams();
        api.updateCutterExportControls({
            profiles: [
                { id: 'quality', label: 'Quality', container: 'mp4' },
                { id: 'balanced', label: 'Balanced', container: 'mp4' },
                { id: 'fast', label: 'Fast', container: 'mp4' },
                { id: 'archive', label: 'Archive', container: 'mkv' },
            ],
            hardwareEncoders: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
        });

        expect(recoveryPanel.hidden).toBe(false);
        expect(recoveryText.textContent).toBe(texts.recoveryFound);
        expect(selects.get('cutterAudioStream')?.options.map((option) => option.textContent)).toEqual(expectedAudio);
        expect(selects.get('cutterExportProfile')?.options.map((option) => option.textContent)).toEqual(expectedProfiles);
        expect(selects.get('cutterExportEncoder')?.options.map((option) => option.textContent)).toEqual([
            texts.encoderSoftware,
            texts.encoderNvenc,
            texts.encoderQsv,
            texts.encoderAmf,
        ]);
    });

    test('uses active English project feedback for save, recovery and manual open actions', async () => {
        const toasts: Array<[string, string]> = [];
        const project = { duration: 90, fps: 30, trimStart: 5, trimEnd: 80, cuts: [], profile: 'balanced', encoder: 'software', audioStreamIndex: 0 };
        let openResult: unknown = project;
        const context: Record<string, unknown> = {
            cutterEditorState: { duration: 90, fps: 30, trimStart: 0, trimEnd: 90, cuts: [] },
            cutterFile: { token: 'source-capability' },
            cutterExportProfile: 'balanced',
            cutterExportEncoder: 'software',
            cutterAudioStreamIndex: 0,
            cutterPendingProject: project,
            cutterRecoveryDecisionPending: true,
            UI_TEXT: {
                cutter: {
                    projectSaved: 'Project saved',
                    projectSaveFailed: 'Project could not be saved',
                    projectRecoveryFailed: 'Project could not be restored',
                    projectRecovered: 'Project restored',
                    projectNotFound: 'No matching project found',
                    projectOpened: 'Project opened',
                },
            },
            applyCutterProject: () => true,
            renderCutterProjectRecovery: () => undefined,
            showAppToast: (message: string, type: string) => toasts.push([message, type]),
            api: {
                saveCutterProject: async () => true,
                openCutterProject: async () => openResult,
            },
        };
        context.getCutterProjectPayload = () => ({ trimStart: 0, trimEnd: 90, cuts: [], profile: 'balanced', encoder: 'software', audioStreamIndex: 0 });
        const persistence = evaluate(sourceFragment('async function persistCutterProject', 'function scheduleCutterAutosave'), context, 'persistCutterProject');
        context.persistCutterProject = persistence.persistCutterProject;
        const actions = evaluate(sourceFragment('async function recoverCutterProject', 'function setCutterExportProfile'), context, 'recoverCutterProject, openCutterProject');

        await persistence.persistCutterProject(true);
        await actions.recoverCutterProject();
        await actions.openCutterProject();
        openResult = null;
        await actions.openCutterProject();

        expect(toasts).toEqual([
            ['Project saved', 'info'],
            ['Project restored', 'info'],
            ['Project opened', 'info'],
            ['No matching project found', 'warn'],
        ]);
    });

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
            UI_TEXT: { cutter: { projectNotFound: 'No matching project found', projectOpened: 'Project opened' } },
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
            UI_TEXT: { cutter: englishCutterChoiceTexts },
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
            UI_TEXT: { cutter: englishCutterChoiceTexts },
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

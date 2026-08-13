import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Input = {
    value: string;
    checked: boolean;
};

const inputIds = [
    'clientId', 'clientSecret', 'sidebarSplitViewToggle', 'downloadMode', 'partMinutes', 'parallelDownloads',
    'performanceMode', 'smartSchedulerToggle', 'duplicatePreventionToggle', 'persistQueueToggle',
    'autoResumeQueueToggle', 'notifyEachCompletionToggle', 'streamlinkDisableAdsToggle', 'downloadChatReplayToggle',
    'captureLiveChatToggle', 'logStreamEventsToggle', 'autoResumeLiveRecordingToggle', 'autoMergeResumedPartsToggle',
    'deletePartsAfterMergeToggle', 'discordWebhookUrl', 'discordNotifyLiveStartToggle', 'discordNotifyLiveEndToggle',
    'discordNotifyVodCompleteToggle', 'discordNotifyVodAutoQueuedToggle', 'autoVodPollMinutes', 'autoVodMaxAgeHours',
    'autoCleanupEnabledToggle', 'autoCleanupDays', 'autoCleanupTarget', 'autoCleanupAction', 'streamlinkQuality',
    'metadataCacheMinutes', 'vodFilenameTemplate', 'partsFilenameTemplate', 'defaultClipFilenameTemplate',
    'downloadThrottleMiBps', 'downloadWindows', 'downloadPolicyValidation'
];

function createInput(value = '', checked = false): Input {
    return { value, checked };
}

class InteractiveInput {
    value = '';
    checked = false;
    disabled = false;
    textContent = '';
    className = '';
    readonly classList = {
        add: (..._tokens: string[]) => undefined,
        remove: (..._tokens: string[]) => undefined,
        contains: (_token: string) => false,
        toggle: (_token: string, force?: boolean) => force ?? false
    };
    private readonly listeners = new Map<string, Array<() => void>>();

    addEventListener(type: string, listener: () => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    dispatch(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) listener();
    }

    setAttribute(_name: string, _value: string): void { }

    select(): void { }
}

type AutosaveRuntime = {
    inputs: Map<string, InteractiveInput>;
    saveConfigCalls: Array<Record<string, unknown>>;
    scheduled: Array<() => void>;
};

function createAutosaveRuntime(): AutosaveRuntime {
    const inputs = new Map(inputIds.map((id) => [id, new InteractiveInput()]));
    for (const id of ['partMinutesLabel', 'downloadPolicyStatus', 'templateLint']) {
        inputs.set(id, new InteractiveInput());
    }
    const saveConfigCalls: Array<Record<string, unknown>> = [];
    const scheduled: Array<() => void> = [];
    const config = {
        download_policy: { throttle: null, windows: [] },
        auto_resume_live_recording: true,
        auto_merge_resumed_parts: false,
        delete_parts_after_merge: false,
        discord_notify_vod_auto_queued: false,
        auto_vod_download_poll_minutes: 15,
        auto_vod_max_age_hours: 24
    };
    const window = {
        api: {
            setClientSecret: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
            clearClientSecret: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
            setDiscordWebhook: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
            clearDiscordWebhook: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
            getDownloadPolicyStatus: () => Promise.resolve({ waiting: false, nextStart: null }),
            onDownloadPolicyStatus: () => undefined,
            saveConfig(payload: Record<string, unknown>) {
                saveConfigCalls.push(payload);
                return Promise.resolve(payload);
            }
        },
        setTimeout(callback: () => void) {
            scheduled.push(callback);
            return scheduled.length;
        },
        clearTimeout: () => undefined,
        addEventListener: () => undefined
    };
    const sandbox = {
        window,
        config,
        UI_TEXT: {
            status: {},
            static: {
                downloadThrottleInvalid: 'Invalid rate',
                downloadWindowsInvalid: 'Invalid window',
                downloadPolicyReady: 'Ready',
                downloadPolicyWaiting: 'Waiting until {time}',
                templateLintOk: 'Valid',
                templateLintWarn: 'Invalid'
            },
            streamers: {}
        },
        byId: (id: string) => {
            if (!inputs.has(id)) inputs.set(id, new InteractiveInput());
            return inputs.get(id);
        },
        collectUnknownTemplatePlaceholders: () => [],
        applySidebarLayoutPreference: () => undefined,
        formatUiDateTime: (value: string) => value,
        document: {
            hidden: false,
            querySelector: () => null,
            getElementById: () => null,
            addEventListener: () => undefined
        },
        setTimeout,
        clearTimeout,
        console
    };
    const context = vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer-settings.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    vm.runInContext(compiled, context);
    vm.runInContext('initSettingsAutoSave()', context);
    return { inputs, saveConfigCalls, scheduled };
}

async function settleAutosave(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function loadRuntimeErrorFormatter(language: 'de' | 'en'): (errorClass: string | null) => string {
    const localeName = language === 'de' ? 'UI_TEXT_DE' : 'UI_TEXT_EN';
    const localeSource = fs.readFileSync(path.join(process.cwd(), 'src', `renderer-locale-${language}.ts`), 'utf8');
    const settingsSource = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer-settings.ts'), 'utf8');
    const compiled = ts.transpileModule(
        `${localeSource}\nlet UI_TEXT = ${localeName};\n${settingsSource}\nglobalThis.__getRuntimeErrorClassLabel = getRuntimeErrorClassLabel;`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
    ).outputText;
    const context = vm.createContext({ console, window: {} });
    vm.runInContext(compiled, context);
    return context.__getRuntimeErrorClassLabel as (errorClass: string | null) => string;
}

describe('renderer settings autosave orchestration', () => {
    it.each([
        ['autoResumeLiveRecordingToggle', 'auto_resume_live_recording', false],
        ['autoMergeResumedPartsToggle', 'auto_merge_resumed_parts', true],
        ['deletePartsAfterMergeToggle', 'delete_parts_after_merge', true],
        ['discordNotifyVodAutoQueuedToggle', 'discord_notify_vod_auto_queued', true]
    ] as const)('persists %s through its change listener', async (controlId, configKey, nextValue) => {
        const runtime = createAutosaveRuntime();
        const control = runtime.inputs.get(controlId)!;
        control.checked = nextValue;

        control.dispatch('change');
        await settleAutosave();

        expect(runtime.saveConfigCalls).toHaveLength(1);
        expect(runtime.saveConfigCalls[0][configKey]).toBe(nextValue);
    });

    it.each([
        ['autoVodPollMinutes', 'auto_vod_download_poll_minutes', '30', 30],
        ['autoVodMaxAgeHours', 'auto_vod_max_age_hours', '48', 48]
    ] as const)('persists %s through its debounced input listener', async (controlId, configKey, nextValue, expectedValue) => {
        const runtime = createAutosaveRuntime();
        const control = runtime.inputs.get(controlId)!;
        control.value = nextValue;

        control.dispatch('input');
        expect(runtime.scheduled).toHaveLength(1);
        runtime.scheduled[0]();
        await settleAutosave();

        expect(runtime.saveConfigCalls).toHaveLength(1);
        expect(runtime.saveConfigCalls[0][configKey]).toBe(expectedValue);
    });

    it('persists a pure download policy change through the real autosave fingerprint', async () => {
        const inputs = new Map(inputIds.map((id) => [id, createInput()]));
        inputs.get('downloadThrottleMiBps')!.value = '1';
        inputs.get('downloadWindows')!.value = '22:00-06:00';
        const saveConfigCalls: Array<Record<string, unknown>> = [];
        const window = {
            api: {
                setClientSecret: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
                clearClientSecret: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
                setDiscordWebhook: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
                clearDiscordWebhook: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
                saveConfig(payload: Record<string, unknown>) {
                    saveConfigCalls.push(payload);
                    return Promise.resolve(payload);
                },
            },
        };
        const sandbox = {
            window,
            config: { download_policy: { throttle: { maxBytesPerSecond: 1_048_576 }, windows: [{ start: '22:00', end: '06:00' }] } },
            UI_TEXT: { status: {}, static: {}, streamers: {} },
            byId: (id: string) => inputs.get(id) ?? createInput(),
            collectUnknownTemplatePlaceholders: () => [],
            document: { hidden: false, querySelector: () => null, getElementById: () => null },
            setTimeout,
            clearTimeout,
            console,
        };
        const context = vm.createContext(sandbox);
        const source = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer-settings.ts'), 'utf8');
        const compiled = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
        }).outputText;
        vm.runInContext(compiled, context);

        vm.runInContext('lastPersistedSettingsFingerprint = getSettingsFingerprint(collectAutoSavePayload())', context);
        inputs.get('downloadThrottleMiBps')!.value = '1.5';
        await (vm.runInContext('flushSettingsAutoSave(false)', context) as Promise<void>);

        expect(saveConfigCalls).toHaveLength(1);
        expect(saveConfigCalls[0].download_policy).toEqual({
            throttle: { maxBytesPerSecond: 1_572_864 },
            windows: [{ start: '22:00', end: '06:00' }]
        });
    });

    it('persists a newer secret after an earlier asynchronous save settles', async () => {
        const inputs = new Map(inputIds.map((id) => [id, createInput()]));
        inputs.get('clientSecret')!.value = 'A';
        let resolveFirstSecret: ((status: unknown) => void) | undefined;
        const setClientSecretCalls: string[] = [];
        const saveConfigCalls: unknown[] = [];
        const window = {
            api: {
                setClientSecret(value: string) {
                    setClientSecretCalls.push(value);
                    if (value === 'A') {
                        return new Promise((resolve) => { resolveFirstSecret = resolve; });
                    }
                    return Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: true, discordWebhookConfigured: false });
                },
                clearClientSecret: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
                setDiscordWebhook: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: true }),
                clearDiscordWebhook: () => Promise.resolve({ encryptionAvailable: true, clientSecretConfigured: false, discordWebhookConfigured: false }),
                saveConfig(payload: unknown) {
                    saveConfigCalls.push(payload);
                    return Promise.resolve(payload);
                },
            },
        };
        const sandbox = {
            window,
            config: {},
            UI_TEXT: { status: {}, static: {}, streamers: {} },
            byId: (id: string) => inputs.get(id) ?? createInput(),
            collectUnknownTemplatePlaceholders: () => [],
            document: { hidden: false, querySelector: () => null, getElementById: () => null },
            setTimeout,
            clearTimeout,
            console,
        };
        const context = vm.createContext(sandbox);
        const source = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer-settings.ts'), 'utf8');
        const compiled = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
        }).outputText;
        vm.runInContext(compiled, context);

        const firstSave = vm.runInContext('flushSettingsAutoSave(false)', context) as Promise<void>;
        expect(setClientSecretCalls).toEqual(['A']);
        expect(vm.runInContext('settingsAutoSaveInFlight', context)).toBe(true);

        vm.runInContext("byId('clientSecret').value = 'B'; secretInputGenerations.clientSecret += 1; if (typeof settingsInputGeneration === 'number') settingsInputGeneration += 1; void flushSettingsAutoSave(false);", context);
        expect(vm.runInContext('secretInputGenerations.clientSecret', context)).toBe(1);
        resolveFirstSecret?.({ encryptionAvailable: true, clientSecretConfigured: true, discordWebhookConfigured: false });
        await firstSave;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(setClientSecretCalls).toEqual(['A', 'B']);
        expect(saveConfigCalls).toHaveLength(2);
    });
});

describe('renderer runtime metrics localization', () => {
    it('renders every runtime error class and unknown values as human-readable German and English labels', () => {
        const german = loadRuntimeErrorFormatter('de');
        const english = loadRuntimeErrorFormatter('en');
        const cases = [
            { errorClass: 'network', german: 'Netzwerk', english: 'Network' },
            { errorClass: 'rate_limit', german: 'Anfragelimit', english: 'Rate limit' },
            { errorClass: 'auth', german: 'Authentifizierung', english: 'Authentication' },
            { errorClass: 'tooling', german: 'Externe Tools', english: 'External tools' },
            { errorClass: 'integrity', german: 'Integrität', english: 'Integrity' },
            { errorClass: 'io', german: 'Dateisystem', english: 'File system' },
            { errorClass: 'validation', german: 'Validierung', english: 'Validation' },
            { errorClass: 'unknown', german: 'Unbekannt', english: 'Unknown' },
            { errorClass: 'future_error_class', german: 'Unbekannt', english: 'Unknown' },
            { errorClass: null, german: '-', english: '-' }
        ];

        expect(cases.map(({ errorClass }) => german(errorClass))).toEqual(cases.map(({ german: label }) => label));
        expect(cases.map(({ errorClass }) => english(errorClass))).toEqual(cases.map(({ english: label }) => label));
    });
});

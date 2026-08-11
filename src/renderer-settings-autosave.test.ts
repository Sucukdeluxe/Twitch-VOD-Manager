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
    'metadataCacheMinutes', 'vodFilenameTemplate', 'partsFilenameTemplate', 'defaultClipFilenameTemplate'
];

function createInput(value = '', checked = false): Input {
    return { value, checked };
}

describe('renderer settings autosave orchestration', () => {
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

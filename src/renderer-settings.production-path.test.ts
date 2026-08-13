import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

class FakeClassList {
    private readonly values = new Set<string>();

    add(...tokens: string[]): void {
        tokens.forEach((token) => this.values.add(token));
    }

    remove(...tokens: string[]): void {
        tokens.forEach((token) => this.values.delete(token));
    }

    contains(token: string): boolean {
        return this.values.has(token);
    }

    toggle(token: string, force?: boolean): boolean {
        const enabled = force ?? !this.values.has(token);
        if (enabled) this.values.add(token);
        else this.values.delete(token);
        return enabled;
    }
}

class FakeElement {
    textContent = '';
    value = '';
    checked = false;
    disabled = false;
    className = '';
    title = '';
    readonly classList = new FakeClassList();
    readonly dataset: Record<string, string> = {};
    readonly attributes = new Map<string, string>();

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }
}

const settingsSource = readFileSync(join(__dirname, 'renderer-settings.ts'), 'utf8');

function sourceFragment(start: string, end: string): string {
    const from = settingsSource.indexOf(start);
    const to = settingsSource.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`Missing renderer settings fragment: ${start}`);
    return settingsSource.slice(from, to);
}

function evaluate(
    source: string,
    context: Record<string, unknown>,
    exposedNames: string
): Record<string, (...args: unknown[]) => unknown> {
    const compiled = transpileModule(`${source}\nObject.assign(globalThis, { __settingsProductionPath: { ${exposedNames} } });`, {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, context);
    return (context as { __settingsProductionPath: Record<string, (...args: unknown[]) => unknown> }).__settingsProductionPath;
}

function createElements(...ids: string[]): Map<string, FakeElement> {
    return new Map(ids.map((id) => [id, new FakeElement()]));
}

describe('renderer settings production diagnostics paths', () => {
    it('ends every consecutive runtime metrics rejection in the localized error state', async () => {
        const elements = createElements('runtimeMetricsOutput');
        const context = {
            UI_TEXT: { static: { runtimeMetricsLoading: 'Loading metrics...', runtimeMetricsError: 'Could not load runtime metrics.' } },
            byId: (id: string) => elements.get(id),
            window: { api: { getRuntimeMetrics: () => Promise.reject(new Error('IPC unavailable')) } },
            lastRuntimeMetricsOutput: '',
        };
        const api = evaluate(
            sourceFragment('async function refreshRuntimeMetrics', 'async function exportRuntimeMetrics'),
            context,
            'refreshRuntimeMetrics'
        );

        await api.refreshRuntimeMetrics();
        expect(elements.get('runtimeMetricsOutput')?.textContent).toBe('Could not load runtime metrics.');

        await api.refreshRuntimeMetrics();
        expect(elements.get('runtimeMetricsOutput')?.textContent).toBe('Could not load runtime metrics.');
    });

    it('invalidates a prior green preflight result when the next IPC check rejects', async () => {
        const elements = createElements('btnPreflightRun', 'btnPreflightFix', 'preflightResult', 'healthBadge');
        const context = {
            UI_TEXT: {
                static: {
                    preflightChecking: 'Checking...',
                    preflightRun: 'Run check',
                    preflightFixing: 'Fixing...',
                    preflightFix: 'Auto-fix tools',
                    preflightEmpty: 'No checks run yet.',
                    preflightError: 'System check failed.',
                    preflightInternet: 'Internet',
                    preflightStreamlink: 'Streamlink',
                    preflightFfmpeg: 'FFmpeg',
                    preflightFfprobe: 'FFprobe',
                    preflightPath: 'Download path',
                    preflightNoInternet: 'No internet connection detected.',
                    preflightStreamlinkMissing: 'Streamlink is missing or not runnable.',
                    preflightFfmpegMissing: 'FFmpeg is missing or not runnable.',
                    preflightFfprobeMissing: 'FFprobe is missing or not runnable.',
                    preflightDownloadPathNotWritable: 'Download folder is not writable.',
                    preflightReady: 'Everything is ready.',
                    healthGood: 'System: Stable',
                    healthWarn: 'System: Limited',
                    healthBad: 'System: Problems',
                    healthUnknown: 'System: Unknown',
                },
            },
            byId: (id: string) => elements.get(id),
            window: { api: { runPreflight: () => Promise.reject(new Error('IPC unavailable')) } },
            preflightGeneration: 0,
            lastPreflightResult: null,
        };
        const api = evaluate(
            sourceFragment('function renderPreflightButtonLabels', 'function getManagedToolStateLabel'),
            context,
            'renderPreflightResult, runPreflight, refreshLocalizedPreflightUi'
        );
        api.renderPreflightResult({
            checks: {
                internet: true,
                streamlink: true,
                ffmpeg: true,
                ffprobe: true,
                downloadPathWritable: true,
            },
        });

        await Promise.resolve(api.runPreflight(false)).catch(() => undefined);

        expect(elements.get('preflightResult')?.textContent).toBe('System check failed.');
        expect(elements.get('healthBadge')?.textContent).toBe('System: Unknown');
        expect(elements.get('healthBadge')?.classList.contains('unknown')).toBe(true);
        expect(elements.get('healthBadge')?.classList.contains('good')).toBe(false);

        context.UI_TEXT.static.preflightError = 'System-Check fehlgeschlagen.';
        context.UI_TEXT.static.healthUnknown = 'System: Unbekannt';
        api.refreshLocalizedPreflightUi();
        expect(elements.get('preflightResult')?.textContent).toBe('System-Check fehlgeschlagen.');
        expect(elements.get('healthBadge')?.textContent).toBe('System: Unbekannt');
    });
});

type ImportRuntime = {
    context: Record<string, unknown>;
    elements: Map<string, FakeElement>;
    themeButtons: FakeElement[];
    queueLabel: FakeElement;
};

function createImportRuntime(nextConfig: Record<string, unknown>, initialConfig: Record<string, unknown>): ImportRuntime {
    const elements = createElements(
        'btnPreflightRun',
        'btnPreflightFix',
        'preflightResult',
        'healthBadge',
        'languageSelect',
        'langOptionDe',
        'langOptionEn',
        'languagePicker',
        'themeSelect',
        'statusText',
        'statusDot',
        'settingsSearchInput',
        'pageTitle'
    );
    const themeButtons = ['light', 'twitch', 'system'].map((theme) => {
        const button = new FakeElement();
        button.dataset.theme = theme;
        return button;
    });
    const queueLabel = new FakeElement();
    const body = new FakeElement();
    body.className = `theme-${String(initialConfig.theme ?? 'twitch')}`;
    elements.get('languageSelect')!.value = String(initialConfig.language ?? 'en');
    elements.get('themeSelect')!.value = String(initialConfig.theme ?? 'twitch');
    const englishText = {
        appName: 'Twitch VOD Manager',
        tabs: { settings: 'Settings' },
        static: {
            preflightChecking: 'Checking...',
            preflightRun: 'Run check',
            preflightFixing: 'Fixing...',
            preflightFix: 'Auto-fix tools',
            preflightEmpty: 'No checks run yet.',
            healthUnknown: 'System: Unknown',
            configImported: 'Configuration imported.',
        },
        queue: { title: 'Queue' },
    };
    const germanText = {
        appName: 'Twitch VOD Manager',
        tabs: { settings: 'Einstellungen' },
        static: {
            preflightChecking: 'Prüfe...',
            preflightRun: 'Check ausführen',
            preflightFixing: 'Fixe...',
            preflightFix: 'Tools reparieren',
            preflightEmpty: 'Noch kein Check ausgeführt.',
            healthUnknown: 'System: Unbekannt',
            configImported: 'Konfiguration importiert.',
        },
        queue: { title: 'Warteschlange' },
    };
    const toasts: string[] = [];
    const document = {
        body,
        querySelector: (selector: string) => selector === '.tab-content.active' ? { id: 'settingsTab' } : null,
        querySelectorAll: (selector: string) => selector === '#workspaceThemePicker [data-theme]' ? themeButtons : [],
    };
    const window = {
        api: {
            importConfig: () => Promise.resolve({ success: true }),
            getConfig: () => Promise.resolve(nextConfig),
            saveConfig: () => Promise.resolve(nextConfig),
        },
        showAppToast: (message: string) => toasts.push(message),
    };
    const context: Record<string, unknown> = {
        window,
        document,
        config: { ...initialConfig },
        currentLanguage: initialConfig.language === 'de' ? 'de' : 'en',
        UI_TEXT: initialConfig.language === 'de' ? germanText : englishText,
        isConnected: false,
        currentStreamer: '',
        lastLoadedStreamer: '',
        lastPreflightResult: null,
        preflightFailed: false,
        preflightGeneration: 0,
        byId: (id: string) => {
            if (!elements.has(id)) elements.set(id, new FakeElement());
            return elements.get(id);
        },
        setLanguage: (language: string) => {
            const normalized = language === 'en' ? 'en' : 'de';
            context.currentLanguage = normalized;
            context.UI_TEXT = normalized === 'de' ? germanText : englishText;
            return normalized;
        },
        localizeCurrentStatusText: (status: string) => status,
        updateStatus: () => undefined,
        renderQueue: () => {
            queueLabel.textContent = (context.UI_TEXT as typeof englishText).queue.title;
        },
        renderStreamers: () => undefined,
        renderVodGridFromCurrentState: () => undefined,
        refreshVodSortSelectLabels: () => undefined,
        refreshRuntimeMetrics: () => Promise.resolve(),
        refreshAutomationStatusLine: () => Promise.resolve(),
        validateFilenameTemplates: () => true,
        filterSettings: () => undefined,
        syncSettingsFormFromConfig: () => undefined,
        scheduleSegmentedIndicatorSync: () => undefined,
    };
    return { context, elements, themeButtons, queueLabel };
}

function evaluateImportRuntime(runtime: ImportRuntime): Record<string, (...args: unknown[]) => unknown> {
    return evaluate(
        [
            sourceFragment('function changeLanguage', 'function getManagedToolStateLabel'),
            sourceFragment('async function importConfigFromFile', 'async function resetDownloadedIds'),
            sourceFragment('function syncWorkspaceThemePicker', 'function formatRelativeTime'),
        ].join('\n'),
        runtime.context,
        'importConfigFromFile'
    );
}

describe('renderer settings config import production path', () => {
    it('applies imported language and theme to controls and dependent dynamic content immediately', async () => {
        const runtime = createImportRuntime(
            { language: 'de', theme: 'light', client_id: 'imported' },
            { language: 'en', theme: 'twitch', client_id: 'current' }
        );
        const api = evaluateImportRuntime(runtime);

        await api.importConfigFromFile();

        expect(runtime.elements.get('languageSelect')?.value).toBe('de');
        expect(runtime.elements.get('langOptionDe')?.classList.contains('active')).toBe(true);
        expect(runtime.queueLabel.textContent).toBe('Warteschlange');
        expect(runtime.elements.get('themeSelect')?.value).toBe('light');
        expect((runtime.context.document as { body: FakeElement }).body.className).toBe('theme-light');
        expect(runtime.themeButtons.find((button) => button.dataset.theme === 'light')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('preserves the current renderer language and theme when imported config omits them', async () => {
        const runtime = createImportRuntime(
            { client_id: 'imported' },
            { language: 'de', theme: 'light', client_id: 'current' }
        );
        const api = evaluateImportRuntime(runtime);

        await api.importConfigFromFile();

        expect(runtime.context.config).toMatchObject({ client_id: 'imported', language: 'de', theme: 'light' });
        expect(runtime.elements.get('languageSelect')?.value).toBe('de');
        expect(runtime.elements.get('themeSelect')?.value).toBe('light');
        expect((runtime.context.document as { body: FakeElement }).body.className).toBe('theme-light');
    });
});

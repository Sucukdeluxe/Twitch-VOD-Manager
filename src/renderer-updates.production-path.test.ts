import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, test } from 'vitest';

type UpdateInfoFixture = {
    version?: string;
    releaseName?: string;
    releaseDate?: string;
    releaseNotes?: string;
};

type DownloadProgressFixture = {
    percent: number;
    transferred: number;
    total: number;
};

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
    readonly classList = new FakeClassList();
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
    readonly children: FakeElement[] = [];
    hidden = false;
    disabled = false;
    textContent = '';
    innerHTML = '';
    title = '';

    constructor(readonly id: string, private readonly document: FakeDocument) { }

    get childNodes(): FakeElement[] {
        return this.children;
    }

    appendChild(child: FakeElement): FakeElement {
        if (child.id === 'fragment') {
            child.children.forEach((entry) => this.children.push(entry));
            return child;
        }
        this.children.push(child);
        return child;
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }

    addEventListener(): void { }

    matches(): boolean {
        return false;
    }

    focus(): void {
        this.document.activeElement = this;
    }
}

class FakeDocument {
    readonly body = new FakeElement('body', this);
    activeElement: FakeElement = this.body;
    activeNavigationItem: FakeElement | null = null;

    constructor(private readonly elements: Map<string, FakeElement>) { }

    createElement(tagName: string): FakeElement {
        return new FakeElement(tagName, this);
    }

    createTextNode(text: string): FakeElement {
        const node = new FakeElement('text', this);
        node.textContent = text;
        return node;
    }

    createDocumentFragment(): FakeElement {
        return new FakeElement('fragment', this);
    }

    querySelector<T extends FakeElement>(selector: string): T | null {
        if (selector === '.top-nav-item[aria-current="page"]') {
            return this.activeNavigationItem as T | null;
        }
        return null;
    }

    addEventListener(): void { }
}

interface UpdateCallbacks {
    checking: () => void;
    available: (info: UpdateInfoFixture) => void;
    notAvailable: () => void;
    progress: (progress: DownloadProgressFixture) => void;
    downloaded: (info: UpdateInfoFixture) => void;
    error: (payload: { message?: string; kind: 'check' | 'download'; version?: string }) => void;
}

interface ProductionApi {
    rememberUpdateInfo(info?: UpdateInfoFixture | null): UpdateInfoFixture | null;
    checkUpdate(): Promise<void>;
    downloadUpdate(): void;
    postponeWorkspaceUpdatePopover(): void;
    dismissWorkspaceUpdatePopover(): void;
    getState(): {
        updateBannerState: string;
        updateDownloadInProgress: boolean;
        workspaceUpdatePopoverPostponed: boolean;
    };
}

interface Runtime {
    api: ProductionApi;
    callbacks: UpdateCallbacks;
    document: FakeDocument;
    elements: Map<string, FakeElement>;
    notifications: Array<{ message: string; type: string }>;
    download: {
        resolve(result?: Record<string, unknown>): void;
        reject(error: Error): void;
    };
    check: {
        resolve(result?: Record<string, unknown>): void;
        reject(error: Error): void;
    };
}

const elementIds = [
    'checkUpdateBtn',
    'workspaceUpdateButton',
    'updateBanner',
    'workspaceUpdateLabel',
    'updateText',
    'workspaceUpdateLater',
    'workspaceUpdateDismiss',
    'updateProgress',
    'updateProgressBar',
    'updateProgressGauge',
    'updateButton',
    'updateModal',
    'updateModalTitle',
    'updateModalMessage',
    'updateModalDismissBtn',
    'updateModalConfirmBtn',
    'updateModalSkipBtn',
    'updateChangelogLabel',
    'updateChangelogEmpty',
    'updateModalMeta',
    'updateChangelogCard',
    'updateChangelogPanel',
    'updateChangelogContent',
    'updateChangelogToggle',
];

function createRuntime(): Runtime {
    const elements = new Map<string, FakeElement>();
    const document = new FakeDocument(elements);
    elementIds.forEach((id) => elements.set(id, new FakeElement(id, document)));
    const activeNavigationItem = new FakeElement('activeNavigationItem', document);
    activeNavigationItem.setAttribute('aria-current', 'page');
    document.activeNavigationItem = activeNavigationItem;
    const callbacks = {} as UpdateCallbacks;
    const notifications: Array<{ message: string; type: string }> = [];
    let resolveDownload!: (result?: Record<string, unknown>) => void;
    let rejectDownload!: (error: Error) => void;
    let resolveCheck!: (result?: Record<string, unknown>) => void;
    let rejectCheck!: (error: Error) => void;
    const downloadPromise = new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        resolveDownload = resolve;
        rejectDownload = reject;
    });
    const checkPromise = new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        resolveCheck = resolve;
        rejectCheck = reject;
    });
    const context: Record<string, unknown> = {
        console,
        document,
        updateReady: false,
        UI_TEXT: {
            static: { checkUpdates: 'Check for updates' },
            updates: {
                checking: 'Checking...',
                installNow: 'Install now',
                downloadNow: 'Download now',
                downloading: 'Downloading...',
                downloadLabel: 'Download',
                ready: 'ready to install',
                available: 'available',
                checkFailed: 'Update check failed.',
                downloadFailed: 'Update download failed.',
                downloadInProgress: 'Update download is already running.',
                readyToInstall: 'Update is ready to install.',
                checkInProgress: 'Update check is already running.',
                latest: 'You are on the latest version.',
                modalReadyTitle: 'Ready',
                modalAvailableTitle: 'Available',
                modalReadyMessage: 'Version {version} is ready.',
                modalAvailableMessage: 'Version {version} is available.',
                modalDismiss: 'Later',
                modalInstallConfirm: 'Install',
                modalDownloadConfirm: 'Download',
                modalSkipVersion: 'Skip',
                releasedLabel: 'Release',
                changelogLabel: 'Changelog',
                noChangelog: 'No changelog',
                hideChangelog: 'Hide changelog',
                showChangelog: 'Show changelog',
            },
        },
        RendererAccessibility: {
            openDialog: (id: string) => elements.get(id)?.classList.add('show'),
            closeDialog: (id: string) => elements.get(id)?.classList.remove('show'),
        },
        getIntlLocale: () => 'en-US',
        safeLocalStorageGet: () => '',
        safeLocalStorageSet: () => undefined,
        safeLocalStorageRemove: () => undefined,
        alert: (message: string) => notifications.push({ message, type: 'warn' }),
        requestAnimationFrame: (callback: () => void) => callback(),
        setTimeout,
        clearTimeout,
    };
    const windowApi = {
        checkUpdate: () => checkPromise,
        downloadUpdate: () => downloadPromise,
        installUpdate: () => Promise.resolve(),
        onUpdateChecking: (callback: () => void) => { callbacks.checking = callback; },
        onUpdateAvailable: (callback: (info: UpdateInfoFixture) => void) => { callbacks.available = callback; },
        onUpdateNotAvailable: (callback: () => void) => { callbacks.notAvailable = callback; },
        onUpdateDownloadProgress: (callback: (progress: DownloadProgressFixture) => void) => { callbacks.progress = callback; },
        onUpdateDownloaded: (callback: (info: UpdateInfoFixture) => void) => { callbacks.downloaded = callback; },
        onUpdateError: (callback: (payload: { message?: string; kind: 'check' | 'download'; version?: string }) => void) => { callbacks.error = callback; },
    };
    context.api = windowApi;
    context.showAppToast = (message: string, type = 'info') => notifications.push({ message, type });
    context.window = context;
    context.globalThis = context;
    context.byId = (id: string) => {
        const element = elements.get(id);
        if (!element) throw new Error(`Missing element ${id}`);
        return element;
    };
    const source = readFileSync(join(__dirname, 'renderer-updates.ts'), 'utf8');
    const exposed = `
        Object.assign(globalThis, {
            __updatesProductionPath: {
                rememberUpdateInfo,
                checkUpdate,
                downloadUpdate,
                postponeWorkspaceUpdatePopover,
                dismissWorkspaceUpdatePopover,
                getState: () => ({ updateBannerState, updateDownloadInProgress, workspaceUpdatePopoverPostponed })
            }
        });
    `;
    const compiled = transpileModule(`${source}\n${exposed}`, {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, context);

    return {
        api: context.__updatesProductionPath as ProductionApi,
        callbacks,
        document,
        elements,
        notifications,
        download: { resolve: resolveDownload, reject: rejectDownload },
        check: { resolve: resolveCheck, reject: rejectCheck },
    };
}

async function flushPromises(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('renderer update production paths', () => {
    test('does not create an update state without a version', () => {
        const runtime = createRuntime();

        expect(runtime.api.rememberUpdateInfo({})).toBeNull();
    });

    test('renders localized pending copy without a fabricated version', () => {
        const runtime = createRuntime();

        runtime.api.downloadUpdate();

        expect(runtime.elements.get('updateText')?.textContent).toBe('Downloading...');
    });

    test('moves focus to the current navigation control after Later hides the update trigger', () => {
        const runtime = createRuntime();
        runtime.callbacks.available({ version: '1.2.3' });
        runtime.elements.get('workspaceUpdateLater')?.focus();

        runtime.api.postponeWorkspaceUpdatePopover();

        expect(runtime.document.activeElement).toBe(runtime.document.activeNavigationItem);
        expect(runtime.elements.get('updateBanner')?.classList.contains('show')).toBe(false);
    });

    test('moves focus to the current navigation control after Dismiss hides the update trigger', () => {
        const runtime = createRuntime();
        runtime.callbacks.available({ version: '1.2.3' });
        runtime.elements.get('workspaceUpdateDismiss')?.focus();

        runtime.api.dismissWorkspaceUpdatePopover();

        expect(runtime.document.activeElement).toBe(runtime.document.activeNavigationItem);
        expect(runtime.elements.get('updateBanner')?.hidden).toBe(true);
    });

    test('keeps dismissed download progress hidden until the ready state is reached', () => {
        const runtime = createRuntime();
        runtime.api.downloadUpdate();
        runtime.api.dismissWorkspaceUpdatePopover();

        runtime.callbacks.progress({ percent: 50, transferred: 1024 * 1024, total: 2 * 1024 * 1024 });

        expect(runtime.api.getState().updateBannerState).toBe('downloading');
        expect(runtime.elements.get('updateBanner')?.classList.contains('show')).toBe(false);
        expect(runtime.elements.get('updateText')?.textContent).toBe('Download: 1.0 / 2.0 MB (50%)');
        expect(runtime.elements.get('updateProgressGauge')?.getAttribute('aria-valuenow')).toBe('50');

        runtime.callbacks.downloaded({ version: '1.2.3' });

        expect(runtime.api.getState().updateBannerState).toBe('ready');
        expect(runtime.elements.get('updateBanner')?.classList.contains('show')).toBe(true);
    });

    test('deduplicates a main error followed by a rejected download operation', async () => {
        const runtime = createRuntime();
        runtime.api.downloadUpdate();

        runtime.callbacks.error({ kind: 'download' });
        runtime.download.reject(new Error('download failed'));
        await flushPromises();

        expect(runtime.notifications.map(({ message }) => message)).toEqual(['Update download failed.']);
    });

    test('deduplicates a main error followed by the production error result', async () => {
        const runtime = createRuntime();
        runtime.api.downloadUpdate();

        runtime.callbacks.error({ kind: 'download' });
        runtime.download.resolve({ error: true });
        await flushPromises();

        expect(runtime.notifications.map(({ message }) => message)).toEqual(['Update download failed.']);
    });

    test('deduplicates a typed check error followed by the IPC error result', async () => {
        const runtime = createRuntime();
        const pending = runtime.api.checkUpdate();

        runtime.callbacks.error({ kind: 'check' });
        runtime.check.resolve({ error: true });
        await pending;

        expect(runtime.notifications.map(({ message }) => message)).toEqual(['Update check failed.']);
    });

    test('reports a blocked manual check as an active download', async () => {
        const runtime = createRuntime();
        const pending = runtime.api.checkUpdate();

        runtime.check.resolve({ checking: true, skipped: 'downloading' });
        await pending;

        expect(runtime.notifications.map(({ message }) => message)).toEqual(['Update download is already running.']);
    });

    test('keeps download failure deduplication scoped to its operation while a new check begins', async () => {
        const runtime = createRuntime();
        runtime.api.downloadUpdate();

        runtime.callbacks.error({ kind: 'download' });
        runtime.callbacks.checking();
        runtime.download.reject(new Error('download failed'));
        await flushPromises();

        expect(runtime.notifications.map(({ message }) => message)).toEqual(['Update download failed.']);
    });

    test('reports a later independent error without relying on a checking event', async () => {
        const runtime = createRuntime();
        runtime.api.downloadUpdate();
        runtime.callbacks.error({ kind: 'download' });
        runtime.download.resolve({ error: true });
        await flushPromises();

        runtime.callbacks.error({ kind: 'check' });

        expect(runtime.notifications.map(({ message }) => message)).toEqual([
            'Update download failed.',
            'Update check failed.',
        ]);
    });

    test('ignores stale check events while a download is active', () => {
        const runtime = createRuntime();
        runtime.callbacks.available({ version: '1.2.3' });
        runtime.api.downloadUpdate();
        runtime.callbacks.checking();
        runtime.callbacks.available({ version: '1.2.4' });
        runtime.callbacks.notAvailable();

        runtime.callbacks.error({ kind: 'check' });

        expect(runtime.notifications).toEqual([]);
        expect(runtime.api.getState().updateBannerState).toBe('downloading');
        expect(runtime.api.getState().updateDownloadInProgress).toBe(true);
    });

    test('reports a download failure when only the main error channel fires', () => {
        const runtime = createRuntime();
        runtime.api.downloadUpdate();

        runtime.callbacks.error({ kind: 'download' });

        expect(runtime.notifications.map(({ message }) => message)).toEqual(['Update download failed.']);
    });

    test('ignores a download terminal for another version', () => {
        const runtime = createRuntime();
        runtime.callbacks.available({ version: '1.2.3' });
        runtime.api.downloadUpdate();

        runtime.callbacks.error({ kind: 'download', version: '1.2.4' });

        expect(runtime.notifications).toEqual([]);
        expect(runtime.api.getState().updateBannerState).toBe('downloading');
        expect(runtime.api.getState().updateDownloadInProgress).toBe(true);
    });

    test('reports a download failure when only the rejected operation channel fires', async () => {
        const runtime = createRuntime();
        runtime.api.downloadUpdate();

        runtime.download.reject(new Error('download failed'));
        await flushPromises();

        expect(runtime.notifications.map(({ message }) => message)).toEqual(['Update download failed.']);
    });

    test('reports a later independent check error after a handled download failure', async () => {
        const runtime = createRuntime();
        runtime.api.downloadUpdate();
        runtime.download.reject(new Error('download failed'));
        await flushPromises();

        runtime.callbacks.checking();
        runtime.callbacks.error({ kind: 'check' });

        expect(runtime.notifications.map(({ message }) => message)).toEqual([
            'Update download failed.',
            'Update check failed.',
        ]);
    });

    test('restores the available state after download failure without reopening a dismissed popover', async () => {
        const runtime = createRuntime();
        runtime.callbacks.available({ version: '1.2.3' });
        runtime.api.downloadUpdate();
        runtime.api.dismissWorkspaceUpdatePopover();

        runtime.download.reject(new Error('download failed'));
        await flushPromises();

        expect(runtime.api.getState().updateBannerState).toBe('available');
        expect(runtime.api.getState().workspaceUpdatePopoverPostponed).toBe(true);
        expect(runtime.elements.get('updateBanner')?.classList.contains('show')).toBe(false);
    });

    test('restores and reveals the available state after an ordinary download failure', () => {
        const runtime = createRuntime();
        runtime.callbacks.available({ version: '1.2.3' });
        runtime.api.downloadUpdate();

        runtime.callbacks.error({ kind: 'download', version: '1.2.3' });

        expect(runtime.api.getState().updateBannerState).toBe('available');
        expect(runtime.api.getState().workspaceUpdatePopoverPostponed).toBe(false);
        expect(runtime.elements.get('updateBanner')?.classList.contains('show')).toBe(true);
    });

    test('leaves downloading state after an error when no update version is cached', () => {
        const runtime = createRuntime();
        runtime.api.downloadUpdate();
        runtime.callbacks.progress({ percent: 25, transferred: 512, total: 2048 });

        runtime.callbacks.error({ kind: 'download' });

        expect(runtime.api.getState().updateBannerState).toBe('idle');
        expect(runtime.api.getState().updateDownloadInProgress).toBe(false);
        expect(runtime.elements.get('updateBanner')?.hidden).toBe(true);
        expect(runtime.elements.get('updateBanner')?.classList.contains('show')).toBe(false);
        expect(runtime.elements.get('updateProgress')?.classList.contains('is-hidden')).toBe(true);
        expect(runtime.elements.get('updateProgressBar')?.style.width).toBe('0%');
        expect(runtime.elements.get('updateProgressGauge')?.getAttribute('aria-valuenow')).toBe('0');
    });

    test('does not reopen a Later update when an unrelated check later fails', () => {
        const runtime = createRuntime();
        runtime.callbacks.available({ version: '1.2.3' });
        runtime.api.postponeWorkspaceUpdatePopover();

        runtime.callbacks.checking();
        runtime.callbacks.error({ kind: 'check' });

        expect(runtime.api.getState().updateBannerState).toBe('available');
        expect(runtime.api.getState().workspaceUpdatePopoverPostponed).toBe(true);
        expect(runtime.elements.get('updateBanner')?.classList.contains('show')).toBe(false);
    });

    test('does not reopen a dismissed update when an unrelated check later fails', () => {
        const runtime = createRuntime();
        runtime.callbacks.available({ version: '1.2.3' });
        runtime.api.dismissWorkspaceUpdatePopover();

        runtime.callbacks.checking();
        runtime.callbacks.error({ kind: 'check' });

        expect(runtime.api.getState().updateBannerState).toBe('idle');
        expect(runtime.elements.get('updateBanner')?.hidden).toBe(true);
        expect(runtime.elements.get('updateBanner')?.classList.contains('show')).toBe(false);
    });
});

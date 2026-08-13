import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(join(__dirname, 'renderer-queue.ts'), 'utf8');
const rendererSource = readFileSync(join(__dirname, 'renderer.ts'), 'utf8');

function fragment(start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`Missing renderer queue fragment: ${start}`);
    return source.slice(from, to);
}

function evaluate<T extends Record<string, unknown>>(code: string, names: string, context: T): T & { exposed: Record<string, (...args: unknown[]) => unknown> } {
    const compiled = transpileModule(`${code}\nglobalThis.exposed = { ${names} };`, {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(compiled, context);
    return context as T & { exposed: Record<string, (...args: unknown[]) => unknown> };
}

const queueText = {
    openFile: 'Open file',
    showInFolder: 'Show in folder',
    viewChat: 'View chat',
    viewEvents: 'View events',
    outputFilesLabel: '{count} files',
    openFileFailed: 'Could not open file.',
    ctxCopiedUrl: 'URL copied.',
    ctxCopyFailed: 'Could not copy URL.',
    readyToDownload: 'Ready',
    statusPaused: 'Paused',
    statusDone: 'Done',
    started: 'Started',
    done: 'Done',
    failed: 'Failed',
    part: 'Part'
};

class HealthElement {
    className = '';
    title = '';
    parent: HealthElement | null = null;
    children: HealthElement[] = [];
    attributes = new Map<string, string>();

    constructor(className = '') {
        this.className = className;
    }

    querySelector(selector: string): HealthElement | null {
        const className = selector.startsWith('.') ? selector.slice(1) : '';
        for (const child of this.children) {
            if (child.className.split(/\s+/).includes(className)) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }

    append(child: HealthElement): void {
        child.parent = this;
        this.children.push(child);
    }

    prepend(child: HealthElement): void {
        child.parent = this;
        this.children.unshift(child);
    }

    insertAdjacentElement(position: string, child: HealthElement): void {
        if (position !== 'afterend' || !this.parent) return;
        const index = this.parent.children.indexOf(this);
        child.parent = this.parent;
        this.parent.children.splice(index + 1, 0, child);
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    remove(): void {
        if (!this.parent) return;
        const index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
        this.parent = null;
    }
}

class DelegatedElement {
    parent: DelegatedElement | null = null;
    dataset: Record<string, string> = {};
    clicked = false;

    constructor(readonly selectors: string[] = []) { }

    closest(selector: string): DelegatedElement | null {
        if (selector.split(',').some((entry) => this.selectors.includes(entry.trim()))) return this;
        return this.parent?.closest(selector) ?? null;
    }

    click(): void {
        this.clicked = true;
    }

    contains(candidate: DelegatedElement): boolean {
        let current: DelegatedElement | null = candidate;
        while (current) {
            if (current === this) return true;
            current = current.parent;
        }
        return false;
    }
}

class DelegatedList extends DelegatedElement {
    private listeners = new Map<string, Array<(event: { target: DelegatedElement; key?: string; preventDefault(): void }) => void>>();

    addEventListener(type: string, listener: (event: { target: DelegatedElement; key?: string; preventDefault(): void }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }

    dispatch(type: string, target: DelegatedElement, key?: string): boolean {
        let prevented = false;
        for (const listener of this.listeners.get(type) || []) {
            listener({ target, key, preventDefault: () => { prevented = true; } });
        }
        return prevented;
    }
}

function decodeHtmlAttribute(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

describe('renderer queue production paths', () => {
    it('routes rendered item controls through delegated data actions without inline JavaScript', () => {
        expect(source).not.toMatch(/\son(?:click|keydown)=/);
        expect(source).toContain('data-queue-action="details"');
        expect(source).toContain('data-queue-action="remove"');
        expect(source).toContain('data-queue-action="retry"');
        expect(source).toContain('data-id="${escapeHtml(item.id)}"');
        expect(source).toContain("list.addEventListener('click'");
        expect(source).toContain("list.addEventListener('keydown'");
    });

    it('resolves nested SVG click targets through the Element closest path', () => {
        const runtime = evaluate(
            fragment('function resolveQueueControl', 'function initQueueActions'),
            'resolveQueueControl',
            { Element: DelegatedElement }
        );
        const control = new DelegatedElement(['[data-queue-action]']);
        const svg = new DelegatedElement();
        const path = new DelegatedElement();
        svg.parent = control;
        path.parent = svg;

        expect(runtime.exposed.resolveQueueControl(path)).toBe(control);
        expect(runtime.exposed.resolveQueueControl({})).toBeNull();
    });

    it('contains rejected delegated queue actions and reports them without an unhandled rejection', async () => {
        const toasts: Array<[string, string]> = [];
        const runtime = evaluate(
            fragment('async function invokeQueueItemAction', 'function resolveQueueControl'),
            'activateQueueControl',
            {
                window: { showAppToast: (message: string, kind: string) => toasts.push([message, kind]) },
                UI_TEXT: { queue: queueText },
                invokeQueueFileAction: async () => { throw new Error('viewer rejected'); },
                toggleQueueDetails: () => undefined,
                removeFromQueue: async () => { throw new Error('remove rejected'); },
                retryQueueItem: async () => { throw new Error('retry rejected'); }
            }
        );
        const list = new DelegatedList();
        const item = new DelegatedElement(['.queue-item']);
        item.dataset.id = 'dangerous-id';
        item.parent = list;
        const remove = new DelegatedElement(['[data-queue-action]']);
        remove.dataset.queueAction = 'remove';
        remove.parent = item;

        await runtime.exposed.activateQueueControl(remove);
        expect(toasts).toEqual([['Failed', 'warn']]);
    });

    it('preserves an exact Windows path from rendered dataset through delegated click dispatch', async () => {
        const rendered = evaluate(
            fragment('function renderQueueItemFileActions', 'async function invokeOpenFile'),
            'renderQueueItemFileActions',
            {
                UI_TEXT: { queue: queueText },
                escapeHtml: (value: unknown) => String(value)
                    .replace(/&/g, '&amp;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
            }
        );
        const windowsPath = "C:\\Users\\O'Brien & Söhne\\new cut.mp4";
        const html = rendered.exposed.renderQueueItemFileActions({
            status: 'completed',
            outputFiles: [windowsPath],
            title: 'A "quoted" title'
        }) as string;

        expect(html).not.toContain('onclick=');
        expect(html).toContain('data-queue-file-action="open"');
        expect(html).toContain('data-queue-file-action="folder"');
        expect(html).toContain('C:\\Users\\O&#39;Brien &amp; Söhne\\new cut.mp4');

        const openButtonMatch = html.match(/<button[^>]+data-queue-file-action="open"[^>]+data-queue-file-path="([^"]+)"/);
        expect(openButtonMatch).not.toBeNull();
        const browserDatasetPath = decodeHtmlAttribute(openButtonMatch![1]);
        const calls: string[] = [];
        const list = new DelegatedList();
        const control = new DelegatedElement(['[data-queue-file-action]']);
        const svg = new DelegatedElement();
        const path = new DelegatedElement();
        control.dataset.queueFileAction = 'open';
        control.dataset.queueFilePath = browserDatasetPath;
        control.parent = list;
        svg.parent = control;
        path.parent = svg;
        const dispatched = evaluate(
            fragment('async function invokeOpenFile', 'async function copyQueueUrl'),
            'initQueueActions',
            {
                Element: DelegatedElement,
                byId: () => list,
                window: {
                    api: {
                        openFile: async (filePath: string) => { calls.push(filePath); return true; },
                        showInFolder: async () => true
                    }
                },
                UI_TEXT: { queue: queueText },
                openChatViewer: async () => undefined,
                openEventsViewer: async () => undefined,
                toggleQueueDetails: () => undefined,
                removeFromQueue: async () => undefined,
                retryQueueItem: async () => undefined
            }
        );

        dispatched.exposed.initQueueActions();
        list.dispatch('click', path);
        await Promise.resolve();
        await Promise.resolve();
        expect(calls).toEqual([windowsPath]);
    });

    it('reports clipboard success only after fulfillment and reports rejection as a warning', async () => {
        let resolveWrite: (() => void) | undefined;
        const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
        const toasts: Array<[string, string]> = [];
        const runtime = evaluate(
            fragment('async function copyQueueUrl', 'function buildQueueFingerprint'),
            'copyQueueUrl',
            {
                navigator: { clipboard: { writeText } },
                window: { showAppToast: (message: string, kind: string) => toasts.push([message, kind]) },
                UI_TEXT: { queue: queueText }
            }
        );

        const pending = runtime.exposed.copyQueueUrl('https://twitch.example/vod') as Promise<void>;
        expect(toasts).toEqual([]);
        expect(resolveWrite).toBeTypeOf('function');
        (resolveWrite as () => void)();
        await pending;
        expect(toasts).toEqual([['URL copied.', 'info']]);

        runtime.navigator.clipboard.writeText = vi.fn(async () => { throw new Error('denied'); });
        await runtime.exposed.copyQueueUrl('https://twitch.example/vod');
        expect(toasts.at(-1)).toEqual(['Could not copy URL.', 'warn']);
    });

    it('reports rejected and negative file open operations through the shared safe wrappers', async () => {
        const toasts: Array<[string, string]> = [];
        const openFile = vi.fn()
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error('open denied'));
        const showInFolder = vi.fn()
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error('folder denied'));
        const runtime = evaluate(
            fragment('async function invokeOpenFile', 'async function invokeQueueFileAction'),
            'invokeOpenFile, invokeShowInFolder',
            {
                window: {
                    api: { openFile, showInFolder },
                    showAppToast: (message: string, kind: string) => toasts.push([message, kind])
                },
                UI_TEXT: { queue: queueText }
            }
        );

        await runtime.exposed.invokeOpenFile('C:\\media\\video.mp4');
        await runtime.exposed.invokeOpenFile('C:\\media\\video.mp4');
        await runtime.exposed.invokeShowInFolder('C:\\media\\video.mp4');
        await runtime.exposed.invokeShowInFolder('C:\\media\\video.mp4');

        expect(toasts).toEqual([
            ['Could not open file.', 'warn'],
            ['Could not open file.', 'warn'],
            ['Could not open file.', 'warn'],
            ['Could not open file.', 'warn']
        ]);
        const contextMenuPath = fragment('function showQueueContextMenu', 'async function moveQueueItemTo');
        expect(contextMenuPath).toContain('() => invokeOpenFile(first)');
        expect(contextMenuPath).toContain('() => invokeShowInFolder(first)');
        expect(contextMenuPath).not.toContain('window.api.openFile(first)');
        expect(contextMenuPath).not.toContain('window.api.showInFolder(first)');
    });

    it('awaits rejected context menu actions through the shared warning path', () => {
        const menuPath = fragment('function showQueueContextMenu', 'async function moveQueueItemTo');
        expect(menuPath).toContain("const makeItem = (label: string, onClick: () => void | Promise<void>");
        expect(menuPath).toContain('void invokeQueueActionSafely(onClick)');
        expect(menuPath).toContain('() => moveQueueItemTo(item.id');
        expect(menuPath).toContain('() => retryQueueItem(item.id)');
        expect(menuPath).toContain('() => window.api.openExternal(item.url)');
        expect(menuPath).toContain('() => removeFromQueue(item.id)');
        expect(menuPath).not.toContain('() => { void moveQueueItemTo');
        expect(menuPath).not.toContain('() => { void retryQueueItem');
        expect(menuPath).not.toContain('() => { void window.api.openExternal');
        expect(menuPath).not.toContain('() => { void removeFromQueue');
    });

    it('removes the exact document listeners before replacing an open context menu', () => {
        const lifecyclePath = fragment('let queueContextMenuInitialized', 'function initQueueContextMenu');
        const calls: Array<[string, string, unknown, boolean]> = [];
        const firstCleanup = vi.fn();
        const runtime = evaluate(
            lifecyclePath,
            'closeQueueContextMenu, installQueueContextMenuDismissal, setActiveCleanup: (cleanup) => { activeQueueContextMenuCleanup = cleanup; }, getActiveCleanup: () => activeQueueContextMenuCleanup',
            {
                activeQueueContextMenu: null,
                activeQueueContextMenuInvoker: null,
                document: {
                    addEventListener: (type: string, listener: unknown, capture: boolean) => calls.push(['add', type, listener, capture]),
                    removeEventListener: (type: string, listener: unknown, capture: boolean) => calls.push(['remove', type, listener, capture])
                },
                Node: DelegatedElement
            }
        );

        const firstMenu = { contains: () => false };
        const installed = runtime.exposed.installQueueContextMenuDismissal(firstMenu, firstCleanup) as (restoreFocus?: boolean) => void;
        runtime.exposed.setActiveCleanup(installed);
        runtime.exposed.closeQueueContextMenu(true);

        expect(firstCleanup).toHaveBeenCalledWith(true);
        const adds = calls.filter(([operation]) => operation === 'add');
        const removes = calls.filter(([operation]) => operation === 'remove');
        expect(adds).toHaveLength(2);
        expect(removes).toHaveLength(2);
        expect(removes[0]).toEqual(['remove', adds[0][1], adds[0][2], adds[0][3]]);
        expect(removes[1]).toEqual(['remove', adds[1][1], adds[1][2], adds[1][3]]);
        expect(runtime.exposed.getActiveCleanup()).toBeNull();

        const secondCleanup = vi.fn();
        const secondInstalled = runtime.exposed.installQueueContextMenuDismissal(firstMenu, secondCleanup) as (restoreFocus?: boolean) => void;
        runtime.exposed.setActiveCleanup(secondInstalled);
        runtime.exposed.closeQueueContextMenu(false);
        expect(secondCleanup).toHaveBeenCalledWith(false);
        const allAdds = calls.filter(([operation]) => operation === 'add');
        const allRemoves = calls.filter(([operation]) => operation === 'remove');
        expect(allAdds).toHaveLength(4);
        expect(allRemoves).toHaveLength(4);
        expect(allRemoves.slice(2)).toEqual(allAdds.slice(2).map(([, type, listener, capture]) => ['remove', type, listener, capture]));
    });

    it('shows terminal and paused states before multipart progress', () => {
        const runtime = evaluate(
            fragment('function getQueueProgressStatusText', 'function getQueueProgressMetricsText'),
            'getQueueProgressStatusText',
            { UI_TEXT: { queue: queueText } }
        );
        const status = runtime.exposed.getQueueProgressStatusText;

        expect(status({ status: 'paused', currentPart: 3, totalParts: 8 })).toBe('Paused');
        expect(status({ status: 'completed', currentPart: 8, totalParts: 8 })).toBe('Done');
        expect(status({ status: 'error', currentPart: 3, totalParts: 8, last_error: 'Disk full' })).toBe('Disk full');
        expect(status({ status: 'downloading', currentPart: 3, totalParts: 8, progressStatus: 'Pause pending' })).toBe('Pause pending');
        expect(status({ status: 'downloading', currentPart: 3, totalParts: 8 })).toBe('Part 3/8');
    });

    it('shows speed and ETA only while an item is actively downloading', () => {
        const runtime = evaluate(
            fragment('function getQueueProgressMetricsText', 'function toggleQueueSelection'),
            'getQueueProgressMetricsText',
            {}
        );
        const metrics = runtime.exposed.getQueueProgressMetricsText;

        expect(metrics({ status: 'downloading', progress: 12.34, speed: '4 MB/s', eta: '2m' })).toBe('12.3% | 4 MB/s | 2m');
        expect(metrics({ status: 'pending', progress: 12.34, speed: '4 MB/s', eta: '2m' })).toBe('');
        expect(metrics({ status: 'paused', progress: 12.34, speed: '4 MB/s', eta: '2m' })).toBe('');
        expect(metrics({ status: 'error', progress: 12.34, speed: '4 MB/s', eta: '2m' })).toBe('');
        expect(metrics({ status: 'completed', progress: 100, speed: '4 MB/s', eta: '2m' })).toBe('100%');
    });

    it('keeps monotonic progress while treating explicit empty telemetry as an authoritative reset', () => {
        const mergePath = rendererSource.slice(
            rendererSource.indexOf('function mergeQueueState'),
            rendererSource.indexOf('function getQueueStateFingerprint')
        );
        const runtime = evaluate(
            `${mergePath}\n${fragment('function getQueueProgressMetricsText', 'function toggleQueueSelection')}`,
            'mergeQueueState, getQueueProgressMetricsText',
            {
                queue: [{
                    id: 'active',
                    status: 'downloading',
                    progress: 70,
                    speed: '4 MB/s',
                    eta: '2m',
                    currentPart: 2,
                    totalParts: 5,
                    downloadedBytes: 700,
                    totalBytes: 1000,
                    progressStatus: '70%',
                    recordingHealth: 'ok'
                }]
            }
        );
        const pausePending = runtime.exposed.mergeQueueState([{
            id: 'active',
            status: 'downloading',
            progress: 10,
            speed: '',
            eta: '',
            currentPart: 0,
            totalParts: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            progressStatus: 'Pause pending',
            recordingHealth: 'stale'
        }]) as Array<Record<string, unknown>>;

        expect(pausePending[0]).toMatchObject({
            progress: 70,
            speed: '',
            eta: '',
            currentPart: 0,
            totalParts: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            progressStatus: 'Pause pending',
            recordingHealth: 'stale'
        });
        expect(runtime.exposed.getQueueProgressMetricsText(pausePending[0])).toBe('70.0%');

        const retrying = runtime.exposed.mergeQueueState([{
            id: 'active',
            status: 'downloading',
            progress: -1,
            speed: '',
            eta: '',
            progressStatus: 'Retrying in 5 seconds'
        }]) as Array<Record<string, unknown>>;
        expect(retrying[0]).toMatchObject({
            progress: 70,
            speed: '',
            eta: '',
            progressStatus: 'Retrying in 5 seconds',
            recordingHealth: 'ok'
        });
        expect(runtime.exposed.getQueueProgressMetricsText(retrying[0])).toBe('70.0%');

        const missingTelemetry = runtime.exposed.mergeQueueState([{
            id: 'active',
            status: 'downloading',
            progress: 20
        }]) as Array<Record<string, unknown>>;
        expect(missingTelemetry[0]).toMatchObject({
            progress: 70,
            speed: '4 MB/s',
            eta: '2m',
            currentPart: 2,
            totalParts: 5,
            downloadedBytes: 700,
            totalBytes: 1000,
            progressStatus: '70%',
            recordingHealth: 'ok'
        });
    });

    it('includes recording health in render invalidation and updates its visible badge in place', () => {
        const fingerprints = evaluate(
            fragment('function getQueueRenderFingerprint', 'function hasActiveQueueDuplicate'),
            'getQueueRenderFingerprint',
            { currentLanguage: 'en', selectedQueueIds: [], expandedQueueIds: new Set<string>() }
        );
        const base = { id: 'live-1', status: 'downloading', progress: 1, isLive: true };
        const unknown = fingerprints.exposed.getQueueRenderFingerprint([{ ...base, recordingHealth: 'unknown' }]) as string;
        const ok = fingerprints.exposed.getQueueRenderFingerprint([{ ...base, recordingHealth: 'ok' }]) as string;
        const stale = fingerprints.exposed.getQueueRenderFingerprint([{ ...base, recordingHealth: 'stale' }]) as string;
        expect(new Set([unknown, ok, stale]).size).toBe(3);

        const healthPath = fragment('function syncQueueRecordingHealth', 'function updateQueueItemProgress');
        expect(healthPath).toContain("health === 'ok'");
        expect(healthPath).toContain("health === 'stale'");
        expect(fragment('function updateQueueItemProgress', 'function toggleQueueDetails')).toContain('syncQueueRecordingHealth(el, item)');

        const runtime = evaluate(
            healthPath,
            'syncQueueRecordingHealth',
            {
                UI_TEXT: { queue: { recordingHealth: { unknown: 'Pending', ok: 'Healthy', stale: 'Stalled' } } },
                document: { createElement: () => new HealthElement() }
            }
        );
        const root = new HealthElement('queue-item');
        const title = new HealthElement('title');
        const live = new HealthElement('queue-live-badge');
        title.append(live);
        root.append(title);

        runtime.exposed.syncQueueRecordingHealth(root, { isLive: true, status: 'downloading', recordingHealth: 'unknown' });
        const badge = root.querySelector('.queue-health-dot');
        expect(badge?.className).toBe('queue-health-dot health-unknown');
        expect(badge?.title).toBe('Pending');
        expect(badge?.attributes.get('aria-label')).toBe('Pending');

        runtime.exposed.syncQueueRecordingHealth(root, { isLive: true, status: 'downloading', recordingHealth: 'ok' });
        expect(root.querySelector('.queue-health-dot')).toBe(badge);
        expect(badge?.className).toBe('queue-health-dot health-ok');
        expect(badge?.title).toBe('Healthy');

        runtime.exposed.syncQueueRecordingHealth(root, { isLive: true, status: 'downloading', recordingHealth: 'stale' });
        expect(badge?.className).toBe('queue-health-dot health-stale');
        expect(badge?.title).toBe('Stalled');

        runtime.exposed.syncQueueRecordingHealth(root, { isLive: true, status: 'paused', recordingHealth: 'stale' });
        expect(root.querySelector('.queue-health-dot')).toBeNull();

        const mergePath = rendererSource.slice(
            rendererSource.indexOf('function mergeQueueState'),
            rendererSource.indexOf('function getQueueStateFingerprint')
        );
        expect(mergePath).toContain('recordingHealth: item.recordingHealth === undefined ? prev.recordingHealth : item.recordingHealth');
    });

    it('matches progress elements by exact dataset identity without constructing a CSS selector from the queue id', () => {
        const progressPath = fragment('function updateQueueItemProgress', 'function toggleQueueDetails');
        expect(progressPath).toContain("querySelectorAll<HTMLElement>('.queue-item')");
        expect(progressPath).toContain('candidate.dataset.id === progressId');
        expect(progressPath).not.toContain('`[data-id="${');
        expect(progressPath).not.toContain("replace(/\"/g");
    });

    it('does not offer retry actions while interrupted merge artifacts remain', () => {
        expect(source).toContain("queue.some((item) => item.status === 'error' && !item.mergeRecoveryBlocked)");
        expect(source).toContain("const isFailed = item.status === 'error' && !item.mergeRecoveryBlocked");
        expect(source).toContain("item.status === 'error' && !item.mergeRecoveryBlocked ?");
        expect(source).toContain("item.mergeRecoveryBlocked ? 'blocked' : ''");
    });
});

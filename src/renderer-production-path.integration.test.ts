import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

type Listener = (event: FakeEvent) => void;

class FakeEvent {
    defaultPrevented = false;
    propagationStopped = false;
    immediatePropagationStopped = false;
    target: FakeElement | null;
    readonly key: string;
    readonly shiftKey: boolean;
    readonly clientX: number;
    readonly clientY: number;

    constructor(readonly type: string, options: { target?: FakeElement; key?: string; shiftKey?: boolean; clientX?: number; clientY?: number } = {}) {
        this.target = options.target ?? null;
        this.key = options.key ?? '';
        this.shiftKey = options.shiftKey ?? false;
        this.clientX = options.clientX ?? 24;
        this.clientY = options.clientY ?? 24;
    }

    preventDefault(): void {
        this.defaultPrevented = true;
    }

    stopPropagation(): void {
        this.propagationStopped = true;
    }

    stopImmediatePropagation(): void {
        this.immediatePropagationStopped = true;
    }
}

class FakeMouseEvent extends FakeEvent { }

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
        const shouldAdd = force ?? !this.values.has(token);
        if (shouldAdd) this.values.add(token);
        else this.values.delete(token);
        return shouldAdd;
    }
}

class FakeElement {
    id = '';
    className = '';
    textContent = '';
    value = '';
    tabIndex = -1;
    inert = false;
    disabled = false;
    isConnected = true;
    clientHeight = 58;
    scrollTop = 0;
    parentElement: FakeElement | null = null;
    readonly children: FakeElement[] = [];
    readonly classList = new FakeClassList();
    readonly attributes = new Map<string, string>();
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, string> & { setProperty(name: string, value: string): void } = Object.assign(Object.create(null), {
        setProperty(this: Record<string, string>, name: string, value: string): void { this[name] = value; }
    });
    private readonly listeners = new Map<string, Listener[]>();

    constructor(readonly tagName: string, protected readonly document: FakeDocument) { }

    get firstChild(): FakeElement | null {
        return this.children[0] ?? null;
    }

    appendChild(child: FakeElement): FakeElement {
        if (child.tagName === 'fragment') {
            child.children.slice().forEach((entry) => this.appendChild(entry));
            return child;
        }
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    append(...children: FakeElement[]): void {
        children.forEach((child) => this.appendChild(child));
    }

    replaceChildren(...children: FakeElement[]): void {
        this.children.splice(0).forEach((child) => { child.parentElement = null; });
        children.forEach((child) => this.appendChild(child));
    }

    remove(): void {
        if (this.parentElement) {
            const index = this.parentElement.children.indexOf(this);
            if (index >= 0) this.parentElement.children.splice(index, 1);
        }
        this.parentElement = null;
        this.isConnected = false;
    }

    contains(node: FakeElement): boolean {
        return node === this || this.children.some((child) => child.contains(node));
    }

    closest(selector: string): FakeElement | null {
        if (this.matches(selector)) return this;
        return this.parentElement?.closest(selector) ?? null;
    }

    matches(selector: string): boolean {
        if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1)) || this.classList.contains(selector.slice(1));
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        if (selector === 'button') return this.tagName === 'button';
        if (selector === 'input') return this.tagName === 'input';
        return false;
    }

    getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
        return { left: 24, top: 24, width: 140, height: 36 };
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
        if (name === 'tabindex') this.tabIndex = Number(value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }

    addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    }

    dispatch(event: FakeEvent): void {
        if (!event.target) event.target = this;
        for (const listener of this.listeners.get(event.type) ?? []) {
            if (event.immediatePropagationStopped) break;
            listener(event);
        }
    }

    focus(): void {
        this.document.activeElement = this;
    }

    querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
        return this.querySelectorAll<T>(selector)[0] ?? null;
    }

    querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
        const descendants = this.descendants();
        if (selector.includes('[role="menuitem"]')) return descendants.filter((element) => element.getAttribute('role') === 'menuitem') as T[];
        if (selector.includes('a[href]') || selector.includes('[tabindex]')) return descendants.filter((element) => element.tagName === 'button' || element.tagName === 'input' || element.tabIndex >= 0) as T[];
        if (selector === 'button') return descendants.filter((element) => element.tagName === 'button') as T[];
        if (selector.startsWith('#')) return descendants.filter((element) => element.id === selector.slice(1)) as T[];
        if (selector.startsWith('.')) return descendants.filter((element) => element.matches(selector)) as T[];
        return [];
    }

    private descendants(): FakeElement[] {
        return this.children.flatMap((child) => [child, ...child.descendants()]);
    }
}

class FakeButton extends FakeElement {
    type = 'button';

    constructor(document: FakeDocument) {
        super('button', document);
    }
}

class FakeDocument {
    readonly documentElement = { lang: '' };
    readonly body: FakeElement;
    readonly elements = new Map<string, FakeElement>();
    activeElement: FakeElement;
    hidden = false;
    private readonly listeners = new Map<string, Listener[]>();

    constructor() {
        this.body = new FakeElement('body', this);
        this.activeElement = this.body;
    }

    createElement(tagName: string): FakeElement {
        if (tagName === 'button') return new FakeButton(this);
        return new FakeElement(tagName, this);
    }

    createDocumentFragment(): FakeElement {
        return new FakeElement('fragment', this);
    }

    getElementById(id: string): FakeElement | null {
        return this.elements.get(id) ?? findDescendantById(this.body, id);
    }

    querySelector(selector: string): FakeElement | null {
        if (selector === '.workspace-shell') return this.elements.get('workspace-shell') ?? null;
        return null;
    }

    addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    }

    dispatch(event: FakeEvent): void {
        for (const listener of this.listeners.get(event.type) ?? []) {
            if (event.immediatePropagationStopped) break;
            listener(event);
        }
    }

    register(element: FakeElement, id: string): FakeElement {
        element.id = id;
        this.elements.set(id, element);
        return element;
    }
}

interface Runtime {
    document: FakeDocument;
    context: Record<string, unknown>;
    scheduled: Array<() => void>;
}

function transpile(source: string): string {
    return transpileModule(source, { compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 } }).outputText;
}

function sourceFragment(fileName: string, start: string, end: string): string {
    const source = readFileSync(join(__dirname, fileName), 'utf8');
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`Missing test fragment markers in ${fileName}`);
    return source.slice(from, to);
}

function createRuntime(): Runtime {
    const document = new FakeDocument();
    const scheduled: Array<() => void> = [];
    const context: Record<string, unknown> = {
        document,
        HTMLElement: FakeElement,
        HTMLButtonElement: FakeButton,
        HTMLDivElement: FakeElement,
        HTMLInputElement: FakeElement,
        Element: FakeElement,
        Node: FakeElement,
        MouseEvent: FakeMouseEvent,
        PointerEvent: FakeEvent,
        AbortController,
        requestAnimationFrame: (callback: () => void) => callback(),
        setTimeout: (callback: () => void) => {
            scheduled.push(callback);
            return scheduled.length;
        },
        clearTimeout: () => undefined,
        performance: { now: () => 0 },
        innerWidth: 1280,
        innerHeight: 720,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        navigator: { clipboard: { writeText: () => Promise.resolve() } },
        localStorage: { getItem: () => null, setItem: () => undefined },
        UI_TEXT: {
            queue: {
                ctxCopyUrl: 'Copy URL', ctxOpenOnTwitch: 'Open', ctxRemove: 'Remove',
                viewChatLoading: 'Loading', viewChat: 'Chat', viewChatFailed: 'Failed', viewChatCount: '{count} messages', viewChatTruncatedSuffix: ' truncated',
                viewEvents: 'Events', viewEventsCount: '{count} events', viewEventsEmpty: 'No events', eventStartedAs: 'Started as', eventEndedAfter: 'Ended after',
                eventRecordingResume: 'Resume started — part {part}', eventTitleFromTo: 'Title {from} {to}', eventGameFromTo: 'Game {from} {to}'
            },
            vods: { ctxOpenOnTwitch: 'Open', ctxCopyUrl: 'Copy', trimButton: 'Trim', addQueue: 'Queue', ctxMarkDownloaded: 'Mark', ctxUnmarkDownloaded: 'Unmark' },
            streamers: { modalCloseAria: 'Close' }
        },
        config: { downloaded_vod_ids: [] },
        currentLanguage: 'en',
        queue: [],
        selectedQueueIds: [],
    };
    context.window = context;
    context.byId = (id: string) => {
        const element = document.getElementById(id);
        if (!element) throw new Error(`Missing element ${id}`);
        return element;
    };
    runInNewContext(transpile(readFileSync(join(__dirname, 'renderer-accessibility.ts'), 'utf8')), context);
    return { document, context, scheduled };
}

function evaluate(runtime: Runtime, source: string, expose: string): Record<string, (...args: unknown[]) => unknown> {
    runInNewContext(transpile(`${source}\nObject.assign(globalThis, { __productionPath: { ${expose} } });`), runtime.context);
    return (runtime.context as unknown as { __productionPath: Record<string, (...args: unknown[]) => unknown> }).__productionPath;
}

function findMenu(document: FakeDocument): FakeElement {
    const menu = document.body.children.find((element) => element.getAttribute('role') === 'menu');
    if (!menu) throw new Error('Menu was not created');
    return menu;
}

function findDescendantById(element: FakeElement, id: string): FakeElement | null {
    if (element.id === id) return element;
    for (const child of element.children) {
        const found = findDescendantById(child, id);
        if (found) return found;
    }
    return null;
}

describe('renderer production interaction paths', () => {
    it('opens queue ContextMenu and Shift+F10 menus through the delegated renderer path and restores focus', () => {
        const runtime = createRuntime();
        const list = runtime.document.register(new FakeElement('div', runtime.document), 'queueList');
        const queueItem = new FakeElement('div', runtime.document);
        queueItem.className = 'queue-item';
        queueItem.dataset.id = 'queue-1';
        list.appendChild(queueItem);
        runtime.context.queue = [{ id: 'queue-1', status: 'completed', outputFiles: [], url: 'https://twitch.example/vod' }];
        const api = evaluate(runtime, sourceFragment('renderer-queue.ts', 'let queueContextMenuInitialized', 'async function moveQueueItemTo'), 'initQueueContextMenu');

        api.initQueueContextMenu();
        queueItem.focus();
        list.dispatch(new FakeEvent('keydown', { target: queueItem, key: 'ContextMenu' }));
        let menu = findMenu(runtime.document);
        expect(runtime.document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
        menu.dispatch(new FakeEvent('keydown', { key: 'Escape' }));
        expect(runtime.document.activeElement).toBe(queueItem);

        list.dispatch(new FakeEvent('keydown', { target: queueItem, key: 'F10', shiftKey: true }));
        menu = findMenu(runtime.document);
        expect(runtime.document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
        menu.dispatch(new FakeEvent('keydown', { key: 'Escape' }));
        expect(runtime.document.activeElement).toBe(queueItem);
    });

    it('opens VOD ContextMenu and Shift+F10 menus through renderer-streamers and restores focus', () => {
        const runtime = createRuntime();
        const grid = runtime.document.register(new FakeElement('div', runtime.document), 'vodGrid');
        const card = new FakeElement('article', runtime.document);
        card.className = 'vod-card';
        Object.assign(card.dataset, { vodId: 'vod-1', vodUrl: 'https://twitch.example/vod', vodTitle: 'Title', vodDate: '2026-08-12', vodStreamer: 'streamer', vodDuration: '01:00:00' });
        grid.appendChild(card);
        const api = evaluate(runtime, sourceFragment('renderer-streamers.ts', 'let vodGridDelegationInitialized', 'async function toggleVodDownloadedMark'), 'initVodGridSelectionDelegation');

        api.initVodGridSelectionDelegation();
        card.focus();
        grid.dispatch(new FakeEvent('contextmenu', { target: card }));
        let menu = findMenu(runtime.document);
        expect(runtime.document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
        menu.dispatch(new FakeEvent('keydown', { key: 'Escape' }));
        expect(runtime.document.activeElement).toBe(card);

        grid.dispatch(new FakeEvent('keydown', { target: card, key: 'F10', shiftKey: true }));
        menu = findMenu(runtime.document);
        expect(runtime.document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
        menu.dispatch(new FakeEvent('keydown', { key: 'Escape' }));
        expect(runtime.document.activeElement).toBe(card);
    });

    it('cancels real chat and events viewer reads, rejects stale filters, and exposes clipped rows to keyboard users', async () => {
        const runtime = createRuntime();
        runtime.document.register(new FakeElement('main', runtime.document), 'workspace-shell');
        const chatModal = runtime.document.register(new FakeElement('div', runtime.document), 'chatViewerModal');
        const chatList = runtime.document.register(new FakeElement('div', runtime.document), 'chatViewerList');
        const chatFilter = runtime.document.register(new FakeElement('input', runtime.document), 'chatViewerFilter');
        const chatStatus = runtime.document.register(new FakeElement('div', runtime.document), 'chatViewerStatus');
        runtime.document.register(new FakeElement('div', runtime.document), 'chatViewerTitle');
        chatModal.append(chatFilter, chatList, chatStatus);
        const eventsModal = runtime.document.register(new FakeElement('div', runtime.document), 'eventsViewerModal');
        const eventsList = runtime.document.register(new FakeElement('div', runtime.document), 'eventsViewerList');
        const eventsStatus = runtime.document.register(new FakeElement('div', runtime.document), 'eventsViewerStatus');
        runtime.document.register(new FakeElement('div', runtime.document), 'eventsViewerTitle');
        eventsModal.append(eventsList, eventsStatus);
        const reads: Array<{ path: string; signal: AbortSignal }> = [];
        const deferred = {} as { resolve(value: { success: boolean; cancelled?: boolean; messages?: Array<Record<string, unknown>> }): void };
        const pendingResult = new Promise<{ success: boolean; cancelled?: boolean; messages?: Array<Record<string, unknown>> }>((resolve) => {
            deferred.resolve = resolve;
        });
        runtime.context.api = {
            readChatFile: (path: string, signal: AbortSignal) => {
                reads.push({ path, signal });
                if (path === 'events-pending') {
                    return pendingResult;
                }
                if (path === 'events') return Promise.resolve({ success: true, messages: [{ type: 'recording_start', title: 'Long event title', game: 'Game' }] });
                return Promise.resolve({ success: true, format: 'live', messages: Array.from({ length: 80 }, (_, index) => ({ type: 'msg', u: `viewer-${index}`, msg: `Long chat message ${index}` })) });
            }
        };
        const api = evaluate(runtime, sourceFragment('renderer.ts', 'interface EventLogEntry', 'function closeTopmostOpenModal'), 'openChatViewer, closeChatViewer, onChatViewerFilterChange, openEventsViewer, closeEventsViewer');

        await api.openChatViewer('chat', 'Chat');
        const chatRow = chatList.firstChild?.firstChild?.firstChild;
        expect(chatList.getAttribute('role')).toBe('listbox');
        expect(chatRow?.getAttribute('role')).toBe('option');
        expect(chatRow?.getAttribute('tabindex')).toBeNull();
        chatList.focus();
        chatList.scrollTop = 29 * 40;
        chatList.dispatch(new FakeEvent('scroll'));
        expect(runtime.document.activeElement).toBe(chatList);
        const chatActiveId = chatList.getAttribute('aria-activedescendant');
        expect(chatActiveId).toBeTruthy();
        expect(findDescendantById(chatList, chatActiveId || '')).not.toBeNull();
        chatList.dispatch(new FakeEvent('keydown', { key: 'ArrowDown' }));
        expect(runtime.document.activeElement).toBe(chatList);
        const chatKeyboardId = chatList.getAttribute('aria-activedescendant');
        expect(chatKeyboardId).not.toBe(chatActiveId);
        expect(findDescendantById(chatList, chatKeyboardId || '')).not.toBeNull();
        chatList.dispatch(new FakeEvent('keydown', { key: 'Enter' }));
        const detailDialog = findDescendantById(runtime.document.body, 'viewerDetailModal');
        expect(detailDialog?.classList.contains('show')).toBe(true);
        expect(findDescendantById(detailDialog as FakeElement, 'viewerDetailText')?.textContent).toContain('Long chat message 41');
        const detailEscape = new FakeEvent('keydown', { key: 'Escape' });
        runtime.document.dispatch(detailEscape);
        expect(detailEscape.immediatePropagationStopped).toBe(true);
        expect(detailDialog?.classList.contains('show')).toBe(false);
        expect(runtime.document.activeElement).toBe(chatList);

        let clock = 0;
        runtime.context.performance = { now: () => (clock++ === 0 ? 0 : 9) };
        chatFilter.value = 'viewer';
        api.onChatViewerFilterChange();
        expect(chatList.getAttribute('aria-busy')).toBe('true');
        api.closeChatViewer();
        expect(reads[0].signal.aborted).toBe(true);
        expect(chatList.getAttribute('aria-busy')).toBeNull();
        runtime.scheduled.splice(0).forEach((callback) => callback());
        expect(chatList.children).toHaveLength(0);

        await api.openEventsViewer('events', 'Events');
        const eventsRow = eventsList.firstChild?.firstChild?.firstChild;
        expect(eventsList.getAttribute('role')).toBe('listbox');
        expect(eventsRow?.getAttribute('role')).toBe('option');
        expect(eventsRow?.getAttribute('tabindex')).toBeNull();
        eventsList.focus();
        eventsList.dispatch(new FakeEvent('keydown', { key: 'Enter' }));
        const eventsDetail = findDescendantById(runtime.document.body, 'viewerDetailModal');
        expect(eventsDetail?.classList.contains('show')).toBe(true);
        expect(findDescendantById(eventsDetail as FakeElement, 'viewerDetailText')?.textContent).toContain('Long event title');
        runtime.document.dispatch(new FakeEvent('keydown', { key: 'Escape' }));
        expect(runtime.document.activeElement).toBe(eventsList);
        const pending = api.openEventsViewer('events-pending', 'Events');
        api.closeEventsViewer();
        expect(reads.at(-1)?.signal.aborted).toBe(true);
        expect(eventsList.getAttribute('aria-busy')).toBeNull();
        deferred.resolve({ success: false, cancelled: true });
        await pending;
    });
});

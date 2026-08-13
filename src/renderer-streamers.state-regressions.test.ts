import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const streamersSource = readFileSync(join(__dirname, 'renderer-streamers.ts'), 'utf8');
const rendererSource = readFileSync(join(__dirname, 'renderer.ts'), 'utf8');

function loadVodLocale(file: string, variable: string): Record<string, string> {
    const source = readFileSync(join(__dirname, file), 'utf8');
    const context: Record<string, unknown> = {};
    const compiled = transpileModule(`${source}\nglobalThis.locale = ${variable}.vods;`, {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(compiled, context);
    return context.locale as Record<string, string>;
}

function fragment(source: string, start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`Missing production fragment: ${start}`);
    return source.slice(from, to);
}

function evaluate<T extends Record<string, unknown>>(source: string, names: string, context: T): T & { exposed: Record<string, (...args: unknown[]) => unknown> } {
    const compiled = transpileModule(`${source}\nglobalThis.exposed = { ${names} };`, {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 }
    }).outputText;
    const globals = context as Record<string, unknown>;
    globals.window ??= context;
    globals.vodBulkOperationInFlight ??= false;
    globals.closeVodContextMenu ??= () => undefined;
    globals.document ??= { getElementById: () => null };
    const vodTexts = ((globals.UI_TEXT as { vods?: Record<string, string> } | undefined)?.vods);
    if (vodTexts) {
        vodTexts.bulkAddedToQueueOne ??= vodTexts.bulkAddedToQueue;
        vodTexts.bulkAddDuplicateOne ??= vodTexts.bulkAddDuplicate;
        vodTexts.bulkAddInvalidOne ??= vodTexts.bulkAddInvalid;
        vodTexts.bulkAddFailedOne ??= vodTexts.bulkAddFailed;
        vodTexts.bulkMarkedDownloadedOne ??= vodTexts.bulkMarkedDownloaded;
        vodTexts.bulkUnmarkedDownloadedOne ??= vodTexts.bulkUnmarkedDownloaded;
    }
    globals.globalThis = context;
    runInNewContext(compiled, context);
    return context as T & { exposed: Record<string, (...args: unknown[]) => unknown> };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: unknown) => void;
    return {
        promise: new Promise<T>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        }),
        resolve: resolvePromise,
        reject: rejectPromise
    };
}

function createClassList(initial: string[] = []): { add(...tokens: string[]): void; remove(...tokens: string[]): void; contains(token: string): boolean; toggle(token: string, force?: boolean): boolean } {
    const values = new Set(initial);
    return {
        add: (...tokens) => tokens.forEach((token) => values.add(token)),
        remove: (...tokens) => tokens.forEach((token) => values.delete(token)),
        contains: (token) => values.has(token),
        toggle: (token, force) => {
            const enabled = force ?? !values.has(token);
            if (enabled) values.add(token);
            else values.delete(token);
            return enabled;
        }
    };
}

class FakeMenuElement {
    readonly children: FakeMenuElement[] = [];
    readonly style: Record<string, string> = {};
    readonly listeners = new Map<string, Array<() => void>>();
    textContent = '';
    className = '';
    type = '';
    isConnected = true;
    parentElement: FakeMenuElement | null = null;

    constructor(readonly tagName: string) { }

    appendChild(child: FakeMenuElement): FakeMenuElement {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    dispatch(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) listener();
    }

    setAttribute(): void { }

    getBoundingClientRect(): { width: number; height: number } {
        return { width: 160, height: 200 };
    }

    contains(node: FakeMenuElement): boolean {
        return node === this || this.children.some((child) => child.contains(node));
    }

    remove(): void {
        if (this.parentElement) {
            const index = this.parentElement.children.indexOf(this);
            if (index >= 0) this.parentElement.children.splice(index, 1);
        }
        this.parentElement = null;
        this.isConnected = false;
    }

    focus(): void { }
}

function createDeletionRuntime(streamers: string[], currentStreamer: string): Record<string, unknown> & { exposed: Record<string, (...args: unknown[]) => unknown> } {
    const grid = {};
    const input = { value: 'filter' };
    const state = {
        config: { streamers },
        currentStreamer,
        lastLoadedVods: [{ id: 'vod-1', url: 'https://vod/1' }],
        lastLoadedStreamer: currentStreamer,
        selectedVodUrls: new Set(['https://vod/1']),
        selectedVodUrlRevisions: new Map([['https://vod/1', 1]]),
        vodSelectionRevision: 1,
        pendingScrollRestore: { streamer: currentStreamer, y: 240 },
        vodScrollRestoreTimer: 91,
        selectStreamerRequestId: 4,
        vodRenderTaskId: 8,
        streamerListFilterQuery: '',
        UI_TEXT: {
            static: { streamerBulkRemoveFiltered: 'Remove {count}', streamerBulkRemoveAll: 'Remove {count}' },
            tabs: { vods: 'VODs' },
            vods: { noneTitle: 'Choose a streamer', noneText: 'Select a streamer to see VODs.' }
        },
        confirm: () => true,
        byId: (id: string) => id === 'vodGrid' ? grid : input,
        document: { getElementById: (id: string) => id === 'streamerListFilter' ? input : null },
        renderStreamers: vi.fn(),
        setVodGridEmptyState: vi.fn(),
        updateVodFilterCount: vi.fn(),
        updateVodBulkBar: vi.fn(),
        closeVodContextMenu: vi.fn(),
        hideStreamerProfileHeader: vi.fn(),
        clearVodHoverPreview: vi.fn(),
        clearTimeout: vi.fn(),
        setPageTitle: vi.fn(),
        api: {
            saveConfig: async (patch: Record<string, unknown>) => ({ ...state.config, ...patch })
        }
    };
    return evaluate(
        fragment(streamersSource, 'function onStreamerListFilterChange', 'function normalizeStreamerCacheKey'),
        'bulkRemoveStreamers, removeStreamer',
        state
    );
}

describe('renderer streamer and VOD state regressions', () => {
    it('provides grammatically singular bulk-result messages in both locales', () => {
        const english = loadVodLocale('renderer-locale-en.ts', 'UI_TEXT_EN');
        const german = loadVodLocale('renderer-locale-de.ts', 'UI_TEXT_DE');

        expect([
            english.bulkAddedToQueueOne,
            english.bulkAddDuplicateOne,
            english.bulkAddInvalidOne,
            english.bulkAddFailedOne,
            english.bulkMarkedDownloadedOne,
            english.bulkUnmarkedDownloadedOne,
            english.bulkMarkFailedOne
        ]).toEqual([
            'Added 1 VOD to the queue.',
            'This VOD is already in the queue.',
            'This VOD has invalid data and was skipped.',
            'This VOD could not be added and remains selected for retry.',
            'Marked 1 VOD as downloaded.',
            'Removed 1 VOD from the downloaded list.',
            'This VOD could not be updated and remains selected for retry.'
        ]);
        expect([
            german.bulkAddedToQueueOne,
            german.bulkAddDuplicateOne,
            german.bulkAddInvalidOne,
            german.bulkAddFailedOne,
            german.bulkMarkedDownloadedOne,
            german.bulkUnmarkedDownloadedOne,
            german.bulkMarkFailedOne
        ]).toEqual([
            '1 VOD zur Warteschlange hinzugefügt.',
            'Dieses VOD ist bereits in der Warteschlange.',
            'Dieses VOD enthält ungültige Daten und wurde übersprungen.',
            'Dieses VOD konnte nicht hinzugefügt werden und bleibt für einen erneuten Versuch ausgewählt.',
            '1 VOD als heruntergeladen markiert.',
            'Markierung von 1 VOD entfernt.',
            'Dieses VOD konnte nicht aktualisiert werden und bleibt für einen erneuten Versuch ausgewählt.'
        ]);
    });

    it('clears the prior streamer selection synchronously before connection work starts', async () => {
        const connection = deferred<void>();
        const updateVodBulkBar = vi.fn();
        const closeVodContextMenu = vi.fn();
        const grid = { textContent: '', innerHTML: '<article>alpha</article>' };
        const context: Record<string, unknown> = {
            currentStreamer: 'alpha',
            lastLoadedStreamer: 'alpha',
            lastLoadedVods: [{ id: 'old' }],
            selectedVodUrls: new Set(['https://www.twitch.tv/videos/1']),
            selectedVodUrlRevisions: new Map([['https://www.twitch.tv/videos/1', 1]]),
            vodSelectionRevision: 1,
            selectStreamerRequestId: 0,
            vodRenderTaskId: 7,
            vodScrollPositions: {},
            pendingScrollRestore: null,
            isConnected: false,
            streamerVodCache: new Map(),
            clearActiveVodHoverPreview: vi.fn(),
            rememberCurrentVodScroll: vi.fn(),
            cancelVodScrollRestore: vi.fn(),
            closeVodContextMenu,
            updateVodBulkBar,
            renderStreamers: vi.fn(),
            getStreamerDisplayName: (name: string) => name,
            byId: () => grid,
            connect: async () => {
                await connection.promise;
                context.isConnected = true;
            },
            normalizeStreamerCacheKey: (name: string) => name,
            loadStreamerVods: async () => ({ userId: '2', vods: [], updatedAt: 1 }),
            renderVODs: vi.fn(),
            updateStatus: vi.fn(),
            UI_TEXT: { status: { noLogin: 'No login' }, vods: { notFound: 'Not found' } },
            api: {}
        };
        const runtime = evaluate(
            fragment(streamersSource, 'function renderVodGridLoadingState', 'function createVodEmptyStateIcon'),
            'selectStreamer',
            context
        );

        const switching = runtime.exposed.selectStreamer('beta') as Promise<void>;

        expect(Array.from(runtime.selectedVodUrls as Set<string>)).toEqual([]);
        expect(updateVodBulkBar).toHaveBeenCalledOnce();
        expect(runtime.lastLoadedStreamer).toBeNull();
        expect(runtime.lastLoadedVods).toEqual([]);
        expect(runtime.vodRenderTaskId).toBe(8);
        expect(closeVodContextMenu).toHaveBeenCalledOnce();
        expect(grid.innerHTML).toContain('vod-card-skeleton');

        connection.resolve();
        await switching;
    });

    it('prevents a delayed old render chunk from appending after switching streamers', async () => {
        const delayedChunks: Array<() => void> = [];
        const inserted: string[] = [];
        const grid = {
            replaceChildren: vi.fn(),
            insertAdjacentHTML: (_position: string, html: string) => inserted.push(html)
        };
        const context: Record<string, unknown> = {
            currentStreamer: 'alpha',
            lastLoadedStreamer: 'alpha',
            lastLoadedVods: [{ id: 'one', url: 'https://www.twitch.tv/videos/1' }, { id: 'two', url: 'https://www.twitch.tv/videos/2' }],
            selectedVodUrls: new Set(),
            selectedVodUrlRevisions: new Map(),
            selectStreamerRequestId: 0,
            vodRenderTaskId: 0,
            vodScrollPositions: {},
            pendingScrollRestore: null,
            isConnected: false,
            streamerVodCache: new Map(),
            VOD_RENDER_CHUNK_SIZE: 1,
            vodHideDownloaded: false,
            vodFilterQuery: '',
            vodSortKey: 'date_desc',
            config: { downloaded_vod_ids: [] },
            document: { hidden: false, getElementById: () => grid },
            clearActiveVodHoverPreview: vi.fn(),
            rememberCurrentVodScroll: vi.fn(),
            cancelVodScrollRestore: vi.fn(),
            updateVodBulkBar: vi.fn(),
            renderStreamers: vi.fn(),
            getStreamerDisplayName: (name: string) => name,
            byId: () => grid,
            connect: async () => undefined,
            normalizeStreamerCacheKey: (name: string) => name,
            loadStreamerVods: async () => null,
            renderVODs: vi.fn(),
            updateStatus: vi.fn(),
            setVodGridEmptyState: vi.fn(),
            updateVodFilterCount: vi.fn(),
            sortVods: (vods: unknown[]) => vods,
            filterVodsByQuery: (vods: unknown[]) => vods,
            buildVodCardHtml: (vod: { id: string }, streamer: string) => `${streamer}:${vod.id}`,
            requestAnimationFrame: vi.fn(),
            setTimeout: (callback: () => void) => { delayedChunks.push(callback); return delayedChunks.length; },
            UI_TEXT: { status: { noLogin: 'No login' }, vods: { notFound: 'Not found', noResultsTitle: 'None', noResultsText: 'None' } },
            api: {}
        };
        const runtime = evaluate(
            `${fragment(streamersSource, 'function renderVodGridLoadingState', 'function createVodEmptyStateIcon')}\n${fragment(streamersSource, 'function renderVodGridFromCurrentState', 'async function refreshVODs')}`,
            'selectStreamer, renderVodGridFromCurrentState',
            context
        );

        runtime.exposed.renderVodGridFromCurrentState();
        const switching = runtime.exposed.selectStreamer('beta') as Promise<void>;
        delayedChunks.forEach((callback) => callback());
        await switching;

        expect(inserted).toEqual(['alpha:one']);
        expect(runtime.lastLoadedStreamer).toBeNull();
        expect(runtime.lastLoadedVods).toEqual([]);
    });

    it('prevents a delayed old bulk completion from rendering VOD state under the new streamer', async () => {
        const request = deferred<{ queue: unknown[]; accepted: true; addedId: string }>();
        const renderVodGridFromCurrentState = vi.fn();
        const context: Record<string, unknown> = {
            currentStreamer: 'alpha',
            lastLoadedStreamer: 'alpha',
            lastLoadedVods: [{ id: 'vod-1', url: 'https://www.twitch.tv/videos/1', title: 'One', created_at: '2026-08-13', duration: '1h' }],
            selectedVodUrls: new Set(['https://www.twitch.tv/videos/1']),
            selectedVodUrlRevisions: new Map([['https://www.twitch.tv/videos/1', 1]]),
            vodSelectionRevision: 1,
            selectStreamerRequestId: 0,
            vodRenderTaskId: 0,
            vodScrollPositions: {},
            pendingScrollRestore: null,
            isConnected: false,
            streamerVodCache: new Map(),
            queue: [],
            document: { getElementById: () => ({ disabled: false, textContent: 'Add', innerHTML: '' }) },
            clearActiveVodHoverPreview: vi.fn(),
            rememberCurrentVodScroll: vi.fn(),
            cancelVodScrollRestore: vi.fn(),
            updateVodBulkBar: vi.fn(),
            renderStreamers: vi.fn(),
            getStreamerDisplayName: (name: string) => name,
            byId: () => ({ textContent: '', innerHTML: '' }),
            connect: async () => undefined,
            normalizeStreamerCacheKey: (name: string) => name,
            loadStreamerVods: async () => null,
            renderVODs: vi.fn(),
            updateStatus: vi.fn(),
            mergeQueueState: (next: unknown[]) => next,
            renderQueue: vi.fn(),
            renderVodGridFromCurrentState,
            UI_TEXT: { status: { noLogin: 'No login' }, vods: { notFound: 'Not found', bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: 'duplicate', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: 'invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: 'failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
            window: { api: { addToQueueWithResult: () => request.promise }, showAppToast: vi.fn() }
        };
        const runtime = evaluate(
            `${fragment(streamersSource, 'function renderVodGridLoadingState', 'function createVodEmptyStateIcon')}\n${fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion')}`,
            'selectStreamer, bulkAddSelectedVodsToQueue',
            context
        );

        const adding = runtime.exposed.bulkAddSelectedVodsToQueue() as Promise<void>;
        const switching = runtime.exposed.selectStreamer('beta') as Promise<void>;
        request.resolve({ queue: [{ id: 'added' }], accepted: true, addedId: 'added' });
        await Promise.all([adding, switching]);

        expect(renderVodGridFromCurrentState).not.toHaveBeenCalled();
        expect(runtime.lastLoadedStreamer).toBeNull();
    });

    it.each([
        ['single', async (runtime: ReturnType<typeof createDeletionRuntime>) => runtime.exposed.removeStreamer('alpha')],
        ['bulk', async (runtime: ReturnType<typeof createDeletionRuntime>) => runtime.exposed.bulkRemoveStreamers()]
    ])('fully clears the active streamer after %s removal', async (_mode, remove) => {
        const runtime = createDeletionRuntime(['alpha', 'beta'], 'alpha');

        await remove(runtime);

        expect(runtime.currentStreamer).toBeNull();
        expect(runtime.lastLoadedStreamer).toBeNull();
        expect(runtime.lastLoadedVods).toEqual([]);
        expect(Array.from(runtime.selectedVodUrls as Set<string>)).toEqual([]);
        expect(runtime.pendingScrollRestore).toBeNull();
        expect(runtime.vodScrollRestoreTimer).toBeNull();
        expect(runtime.clearTimeout).toHaveBeenCalledWith(91);
        expect(runtime.selectStreamerRequestId).toBe(5);
        expect(runtime.vodRenderTaskId).toBe(9);
        expect(runtime.hideStreamerProfileHeader).toHaveBeenCalledOnce();
        expect(runtime.clearVodHoverPreview).toHaveBeenCalledOnce();
        expect(runtime.closeVodContextMenu).toHaveBeenCalledOnce();
        expect(runtime.updateVodBulkBar).toHaveBeenCalledOnce();
        expect(runtime.setVodGridEmptyState).toHaveBeenCalledWith(expect.anything(), 'Choose a streamer', 'Select a streamer to see VODs.');
        expect(runtime.setPageTitle).toHaveBeenCalledWith('VODs');
    });

    it('hydrates profile display casing synchronously and preserves it when returning to the VOD tab', async () => {
        let resolveNames: ((value: Record<string, string>) => void) | undefined;
        const elements = new Map<string, { classList: ReturnType<typeof createClassList>; setAttribute(name: string, value: string): void; removeAttribute(name: string): void }>();
        const element = () => ({ classList: createClassList(), setAttribute: () => undefined, removeAttribute: () => undefined });
        elements.set('cutterTab', element());
        elements.set('vodsTab', element());
        const titles: string[] = [];
        const context: Record<string, unknown> = {
            config: { streamers: ['nightbot'], streamer_display_names: { nightbot: 'NightBot' } },
            currentStreamer: 'nightbot',
            renderStreamers: vi.fn(),
            api: { getStreamerDisplayNames: () => new Promise<Record<string, string>>((resolve) => { resolveNames = resolve; }) },
            byId: (id: string) => elements.get(id) ?? element(),
            queryAll: () => [],
            query: () => element(),
            deactivateCutterEditor: () => undefined,
            activateCutterEditor: () => undefined,
            syncTopNavActiveIndicator: () => undefined,
            syncWorkspaceChrome: () => undefined,
            scheduleSegmentedIndicatorsSync: () => undefined,
            persistActiveTab: () => undefined,
            setPageTitle: (title: string) => titles.push(title),
            UI_TEXT: { appName: 'Twitch VOD Manager', tabs: { vods: 'VODs', settings: 'Settings' } }
        };
        const displayRuntime = evaluate(
            fragment(streamersSource, 'const liveStatusByLogin', 'async function initLiveStatusSubscription'),
            'hydrateStreamerDisplayNames, rememberStreamerDisplayName, getStreamerDisplayName',
            context
        );

        const hydration = displayRuntime.exposed.hydrateStreamerDisplayNames() as Promise<void>;
        expect(displayRuntime.exposed.getStreamerDisplayName('nightbot')).toBe('NightBot');
        expect((displayRuntime.window as Record<string, unknown>).getStreamerDisplayName).toBe(displayRuntime.exposed.getStreamerDisplayName);
        expect(displayRuntime.renderStreamers).toHaveBeenCalledOnce();

        const tabRuntime = evaluate(
            fragment(rendererSource, 'function showTab', 'function parseDurationToSeconds'),
            'showTab',
            displayRuntime
        );
        tabRuntime.exposed.showTab('settings');
        tabRuntime.exposed.showTab('vods');
        expect(titles.at(-1)).toBe('NightBot');

        resolveNames?.({ nightbot: 'NightBot' });
        await hydration;
    });

    it('renders a localized empty state when hide-downloaded removes every VOD', () => {
        const emptyState = vi.fn();
        const grid = { replaceChildren: vi.fn(), insertAdjacentHTML: vi.fn() };
        const runtime = evaluate(
            fragment(streamersSource, 'function renderVodGridFromCurrentState', 'async function refreshVODs'),
            'renderVodGridFromCurrentState',
            {
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://vod/1' }],
                vodRenderTaskId: 0,
                VOD_RENDER_CHUNK_SIZE: 64,
                vodHideDownloaded: true,
                vodFilterQuery: '',
                vodSortKey: 'date_desc',
                config: { downloaded_vod_ids: ['vod-1'] },
                UI_TEXT: { vods: { hideDownloadedEmptyTitle: 'All VODs hidden', hideDownloadedEmptyText: 'Turn off the filter.' } },
                byId: () => grid,
                sortVods: (vods: unknown[]) => vods,
                filterVodsByQuery: (vods: unknown[]) => vods,
                setVodGridEmptyState: emptyState,
                updateVodFilterCount: vi.fn(),
                buildVodCardHtml: () => '',
                clearActiveVodHoverPreview: () => undefined,
                document: { hidden: false },
                setTimeout: (callback: () => void) => { callback(); return 1; },
                requestAnimationFrame: (callback: () => void) => { callback(); return 1; }
            }
        );

        runtime.exposed.renderVodGridFromCurrentState();

        expect(emptyState).toHaveBeenCalledWith(grid, 'All VODs hidden', 'Turn off the filter.');
        expect(grid.replaceChildren).not.toHaveBeenCalled();
    });

    it('stops an active hover preview before replacing cards during a state render', () => {
        const order: string[] = [];
        const grid = {
            replaceChildren: () => order.push('render'),
            insertAdjacentHTML: () => order.push('cards')
        };
        const runtime = evaluate(
            fragment(streamersSource, 'function renderVodGridFromCurrentState', 'async function refreshVODs'),
            'renderVodGridFromCurrentState',
            {
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://vod/1' }],
                vodRenderTaskId: 0,
                VOD_RENDER_CHUNK_SIZE: 64,
                vodHideDownloaded: false,
                vodFilterQuery: '',
                vodSortKey: 'date_desc',
                config: { downloaded_vod_ids: [] },
                UI_TEXT: { vods: {} },
                byId: () => grid,
                sortVods: (vods: unknown[]) => vods,
                filterVodsByQuery: (vods: unknown[]) => vods,
                setVodGridEmptyState: vi.fn(),
                updateVodFilterCount: vi.fn(),
                buildVodCardHtml: () => '<article></article>',
                clearActiveVodHoverPreview: () => order.push('hover'),
                document: { hidden: false },
                setTimeout: (callback: () => void) => { callback(); return 1; },
                requestAnimationFrame: (callback: () => void) => { callback(); return 1; }
            }
        );

        runtime.exposed.renderVodGridFromCurrentState();

        expect(order).toEqual(['hover', 'render', 'cards']);
    });

    it('marks the immutable VOD snapshot and preserves new selections while requests are in flight', async () => {
        const firstRequest = deferred<{ success: boolean }>();
        const calls: Array<[string, boolean]> = [];
        const selectedVodUrls = new Set(['https://www.twitch.tv/videos/1', 'https://www.twitch.tv/videos/2']);
        const selectedVodUrlRevisions = new Map([
            ['https://www.twitch.tv/videos/1', 1],
            ['https://www.twitch.tv/videos/2', 2]
        ]);
        const context: Record<string, unknown> = {
            selectedVodUrls,
            selectedVodUrlRevisions,
            lastLoadedStreamer: 'alpha',
            lastLoadedVods: [
                { id: 'vod-1', url: 'https://www.twitch.tv/videos/1' },
                { id: 'vod-2', url: 'https://www.twitch.tv/videos/2' }
            ],
            config: {},
            UI_TEXT: { vods: { bulkMarkedDownloaded: 'Marked {count}', bulkUnmarkedDownloaded: 'Unmarked {count}' } },
            window: {
                api: {
                    markVodDownloaded: async (id: string, mark: boolean) => {
                        calls.push([id, mark]);
                        if (calls.length === 1) return firstRequest.promise;
                        return { success: true };
                    },
                    getConfig: async () => ({ downloaded_vod_ids: ['vod-1', 'vod-2'] })
                },
                showAppToast: vi.fn()
            },
            updateVodBulkBar: vi.fn(),
            renderVodGridFromCurrentState: vi.fn()
        };
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'async function bulkAddSelectedVodsToQueue'),
            'bulkMarkSelectedDownloaded',
            context
        );

        const marking = runtime.exposed.bulkMarkSelectedDownloaded(true) as Promise<void>;
        context.lastLoadedStreamer = 'beta';
        context.lastLoadedVods = [{ id: 'changed', url: 'https://www.twitch.tv/videos/2' }];
        selectedVodUrls.add('https://www.twitch.tv/videos/3');
        selectedVodUrlRevisions.set('https://www.twitch.tv/videos/3', 3);
        firstRequest.resolve({ success: true });
        await marking;

        expect(calls).toEqual([['vod-1', true], ['vod-2', true]]);
        expect(Array.from(selectedVodUrls)).toEqual(['https://www.twitch.tv/videos/3']);
    });

    it('keeps failed downloaded-mark selections available for retry', async () => {
        const selectedVodUrls = new Set(['https://www.twitch.tv/videos/1', 'https://www.twitch.tv/videos/2']);
        const toasts: Array<[string, string]> = [];
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'async function bulkAddSelectedVodsToQueue'),
            'bulkMarkSelectedDownloaded',
            {
                selectedVodUrls,
                selectedVodUrlRevisions: new Map([
                    ['https://www.twitch.tv/videos/1', 1],
                    ['https://www.twitch.tv/videos/2', 2]
                ]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [
                    { id: 'vod-1', url: 'https://www.twitch.tv/videos/1' },
                    { id: 'vod-2', url: 'https://www.twitch.tv/videos/2' }
                ],
                config: {},
                UI_TEXT: { vods: { bulkMarkedDownloaded: 'Marked {count}', bulkUnmarkedDownloaded: 'Unmarked {count}', bulkMarkFailed: '{count} failed', bulkMarkFailedOne: 'one failed', bulkMarkResult: '{updated}/{failed}' } },
                window: {
                    api: {
                        markVodDownloaded: async (id: string) => {
                            if (id === 'vod-2') throw new Error('persist failed');
                            return { success: true };
                        },
                        getConfig: async () => ({ downloaded_vod_ids: ['vod-1'] })
                    },
                    showAppToast: (message: string, kind: string) => toasts.push([message, kind])
                },
                updateVodBulkBar: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        await runtime.exposed.bulkMarkSelectedDownloaded(true);

        expect(Array.from(selectedVodUrls)).toEqual(['https://www.twitch.tv/videos/2']);
        expect(toasts).toEqual([['1/1', 'warn']]);
    });

    it('reports false and missing-VOD mark results as failures without clearing their selections', async () => {
        const selectedVodUrls = new Set([
            'https://www.twitch.tv/videos/1',
            'https://www.twitch.tv/videos/missing'
        ]);
        const toasts: Array<[string, string]> = [];
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'async function bulkAddSelectedVodsToQueue'),
            'bulkMarkSelectedDownloaded',
            {
                selectedVodUrls,
                selectedVodUrlRevisions: new Map([
                    ['https://www.twitch.tv/videos/1', 1],
                    ['https://www.twitch.tv/videos/missing', 2]
                ]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://www.twitch.tv/videos/1' }],
                config: {},
                UI_TEXT: { vods: { bulkMarkedDownloaded: 'Marked {count}', bulkUnmarkedDownloaded: 'Unmarked {count}', bulkMarkFailed: '{count} failed', bulkMarkFailedOne: 'one failed', bulkMarkResult: '{updated}/{failed}' } },
                window: {
                    api: {
                        markVodDownloaded: async () => ({ success: false }),
                        getConfig: vi.fn()
                    },
                    showAppToast: (message: string, kind: string) => toasts.push([message, kind])
                },
                updateVodBulkBar: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        await runtime.exposed.bulkMarkSelectedDownloaded(true);

        expect(Array.from(selectedVodUrls)).toEqual([
            'https://www.twitch.tv/videos/1',
            'https://www.twitch.tv/videos/missing'
        ]);
        expect(toasts).toEqual([['2 failed', 'warn']]);
    });

    it('allows only one VOD bulk operation at a time and locks every bulk action button synchronously', async () => {
        const request = deferred<{ success: boolean }>();
        const buttons = new Map([
            ['vodBulkAddBtn', { disabled: false }],
            ['vodBulkMarkBtn', { disabled: false }],
            ['vodBulkUnmarkBtn', { disabled: false }]
        ]);
        const markVodDownloaded = vi.fn(() => request.promise);
        const selectedVodUrls = new Set(['https://www.twitch.tv/videos/1']);
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'async function bulkAddSelectedVodsToQueue'),
            'bulkMarkSelectedDownloaded',
            {
                selectedVodUrls,
                selectedVodUrlRevisions: new Map([['https://www.twitch.tv/videos/1', 1]]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://www.twitch.tv/videos/1' }],
                vodBulkOperationInFlight: false,
                config: {},
                document: { getElementById: (id: string) => buttons.get(id) ?? null },
                UI_TEXT: { vods: { bulkMarkedDownloaded: 'Marked {count}', bulkMarkedDownloadedOne: 'Marked one', bulkUnmarkedDownloaded: 'Unmarked {count}', bulkUnmarkedDownloadedOne: 'Unmarked one', bulkMarkFailed: '{count} failed', bulkMarkFailedOne: 'one failed', bulkMarkResult: '{updated}/{failed}' } },
                window: {
                    api: { markVodDownloaded, getConfig: async () => ({}) },
                    showAppToast: vi.fn()
                },
                updateVodBulkBar: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        const marking = runtime.exposed.bulkMarkSelectedDownloaded(true) as Promise<void>;
        const unmarking = runtime.exposed.bulkMarkSelectedDownloaded(false) as Promise<void>;

        expect(markVodDownloaded).toHaveBeenCalledOnce();
        expect(Array.from(buttons.values()).map((button) => button.disabled)).toEqual([true, true, true]);

        request.resolve({ success: true });
        await Promise.all([marking, unmarking]);

        expect(Array.from(buttons.values()).map((button) => button.disabled)).toEqual([false, false, false]);
    });

    it('does not count a backend-rejected duplicate as a bulk queue success', async () => {
        const toasts: Array<[string, string]> = [];
        const button = { disabled: false, textContent: 'Add' };
        const existingQueue = [{ id: 'existing', url: 'https://www.twitch.tv/videos/1', streamer: 'alpha', date: '2026-08-13' }];
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            {
                selectedVodUrls: new Set(['https://www.twitch.tv/videos/1']),
                selectedVodUrlRevisions: new Map([['https://www.twitch.tv/videos/1', 1]]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://www.twitch.tv/videos/1', title: 'One', created_at: '2026-08-13', duration: '1h' }],
                queue: existingQueue,
                document: { getElementById: () => button },
                UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: '1 duplicates', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: '1 invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: '1 failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
                window: {
                    api: { addToQueueWithResult: async () => ({ queue: existingQueue, accepted: false, reason: 'duplicate' }) },
                    showAppToast: (message: string, kind: string) => toasts.push([message, kind])
                },
                mergeQueueState: (next: unknown[]) => next,
                updateVodBulkBar: vi.fn(),
                renderQueue: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        await runtime.exposed.bulkAddSelectedVodsToQueue();

        expect(toasts).toEqual([['1 duplicates', 'warn']]);
        expect(Array.from(runtime.selectedVodUrls as Set<string>)).toEqual([]);
    });

    it('counts only a new matching queue identity and reports mixed bulk results', async () => {
        const toasts: Array<[string, string]> = [];
        const button = { disabled: false, textContent: 'Add' };
        const initial = [{ id: 'existing', url: 'https://old', streamer: 'alpha', date: '2026-08-10' }];
        const afterFirst = [...initial, { id: 'unrelated', url: 'https://other', streamer: 'beta', date: '2026-08-13' }];
        const afterSecond = [...afterFirst, { id: 'accepted', url: 'https://www.twitch.tv/videos/2', streamer: 'alpha', date: '2026-08-12' }];
        const responses = [
            { queue: afterFirst, accepted: false, reason: 'duplicate' },
            { queue: afterSecond, accepted: true, addedId: 'accepted' }
        ];
        let activeCalls = 0;
        let maximumActiveCalls = 0;
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            {
                selectedVodUrls: new Set(['https://www.twitch.tv/videos/1', 'https://www.twitch.tv/videos/2']),
                selectedVodUrlRevisions: new Map([
                    ['https://www.twitch.tv/videos/1', 1],
                    ['https://www.twitch.tv/videos/2', 2]
                ]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [
                    { id: 'vod-1', url: 'https://www.twitch.tv/videos/1', title: 'One', created_at: '2026-08-13', duration: '1h' },
                    { id: 'vod-2', url: 'https://www.twitch.tv/videos/2', title: 'Two', created_at: '2026-08-12', duration: '2h' }
                ],
                queue: initial,
                document: { getElementById: () => button },
                UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: '1 duplicates', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: '1 invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: '1 failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
                window: {
                    api: {
                        addToQueueWithResult: async () => {
                            activeCalls += 1;
                            maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
                            await new Promise<void>((resolve) => setImmediate(resolve));
                            activeCalls -= 1;
                            return responses.shift();
                        }
                    },
                    showAppToast: (message: string, kind: string) => toasts.push([message, kind])
                },
                mergeQueueState: (next: unknown[]) => next,
                updateVodBulkBar: vi.fn(),
                renderQueue: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        await runtime.exposed.bulkAddSelectedVodsToQueue();

        expect(toasts).toEqual([['1/1/0/0', 'warn']]);
        expect(maximumActiveCalls).toBe(1);
        expect(Array.from(runtime.selectedVodUrls as Set<string>)).toEqual([]);
    });

    it('uses immutable VOD and streamer snapshots across sequential bulk requests', async () => {
        const firstRequest = deferred<{ queue: unknown[]; accepted: boolean; addedId?: string }>();
        const calls: Array<Record<string, unknown>> = [];
        const selectedVodUrls = new Set(['https://www.twitch.tv/videos/1', 'https://www.twitch.tv/videos/2']);
        const context: Record<string, unknown> = {
            selectedVodUrls,
            selectedVodUrlRevisions: new Map([
                ['https://www.twitch.tv/videos/1', 1],
                ['https://www.twitch.tv/videos/2', 2]
            ]),
            lastLoadedStreamer: 'alpha',
            lastLoadedVods: [
                { id: 'vod-1', url: 'https://www.twitch.tv/videos/1', title: 'Original one', created_at: '2026-08-13', duration: '1h' },
                { id: 'vod-2', url: 'https://www.twitch.tv/videos/2', title: 'Original two', created_at: '2026-08-12', duration: '2h' }
            ],
            queue: [],
            document: { getElementById: () => ({ disabled: false, textContent: 'Add' }) },
            UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: '1 duplicates', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: '1 invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: '1 failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
            window: {
                api: {
                    addToQueueWithResult: async (payload: Record<string, unknown>) => {
                        calls.push(payload);
                        if (calls.length === 1) return firstRequest.promise;
                        return { queue: [{ id: 'one' }, { id: 'two' }], accepted: true, addedId: 'two' };
                    }
                },
                showAppToast: vi.fn()
            },
            mergeQueueState: (next: unknown[]) => next,
            updateVodBulkBar: vi.fn(),
            renderQueue: vi.fn(),
            renderVodGridFromCurrentState: vi.fn()
        };
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            context
        );

        const adding = runtime.exposed.bulkAddSelectedVodsToQueue() as Promise<void>;
        context.lastLoadedStreamer = 'beta';
        context.lastLoadedVods = [
            { id: 'vod-2', url: 'https://www.twitch.tv/videos/2', title: 'Mutated two', created_at: '2026-08-11', duration: '9h' }
        ];
        firstRequest.resolve({ queue: [{ id: 'one' }], accepted: true, addedId: 'one' });
        await adding;

        expect(calls).toEqual([
            { url: 'https://www.twitch.tv/videos/1', title: 'Original one', date: '2026-08-13', streamer: 'alpha', duration_str: '1h' },
            { url: 'https://www.twitch.tv/videos/2', title: 'Original two', date: '2026-08-12', streamer: 'alpha', duration_str: '2h' }
        ]);
    });

    it('preserves selections made while a bulk request is in flight', async () => {
        const request = deferred<{ queue: unknown[]; accepted: boolean; addedId?: string }>();
        const selectedVodUrls = new Set(['https://www.twitch.tv/videos/1']);
        const selectedVodUrlRevisions = new Map([['https://www.twitch.tv/videos/1', 1]]);
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            {
                selectedVodUrls,
                selectedVodUrlRevisions,
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://www.twitch.tv/videos/1', title: 'One', created_at: '2026-08-13', duration: '1h' }],
                queue: [],
                document: { getElementById: () => ({ disabled: false, textContent: 'Add' }) },
                UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: '1 duplicates', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: '1 invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: '1 failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
                window: { api: { addToQueueWithResult: () => request.promise }, showAppToast: vi.fn() },
                mergeQueueState: (next: unknown[]) => next,
                updateVodBulkBar: vi.fn(),
                renderQueue: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        const adding = runtime.exposed.bulkAddSelectedVodsToQueue() as Promise<void>;
        selectedVodUrls.delete('https://www.twitch.tv/videos/1');
        selectedVodUrlRevisions.delete('https://www.twitch.tv/videos/1');
        selectedVodUrls.add('https://www.twitch.tv/videos/1');
        selectedVodUrlRevisions.set('https://www.twitch.tv/videos/1', 2);
        selectedVodUrls.add('https://www.twitch.tv/videos/2');
        selectedVodUrlRevisions.set('https://www.twitch.tv/videos/2', 3);
        request.resolve({ queue: [{ id: 'one' }], accepted: true, addedId: 'one' });
        await adding;

        expect(Array.from(selectedVodUrls)).toEqual([
            'https://www.twitch.tv/videos/1',
            'https://www.twitch.tv/videos/2'
        ]);
    });

    it('does not let a delayed bulk response replace newer queue-event membership or terminal state', async () => {
        const request = deferred<{ queue: unknown[]; accepted: true; addedId: string }>();
        const before = [{ id: 'active', url: 'https://old', streamer: 'alpha', date: '2026-08-10', status: 'downloading', progress: 70 }];
        const newer = [
            { id: 'active', url: 'https://old', streamer: 'alpha', date: '2026-08-10', status: 'completed', progress: 100 },
            { id: 'event-only', url: 'https://event', streamer: 'beta', date: '2026-08-13', status: 'pending', progress: 0 }
        ];
        const stale = [
            { id: 'active', url: 'https://old', streamer: 'alpha', date: '2026-08-10', status: 'downloading', progress: 70 },
            { id: 'added', url: 'https://www.twitch.tv/videos/1', streamer: 'alpha', date: '2026-08-13', status: 'pending', progress: 0 }
        ];
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            {
                selectedVodUrls: new Set(['https://www.twitch.tv/videos/1']),
                selectedVodUrlRevisions: new Map([['https://www.twitch.tv/videos/1', 1]]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://www.twitch.tv/videos/1', title: 'One', created_at: '2026-08-13', duration: '1h' }],
                queue: before,
                document: { getElementById: () => ({ disabled: false, textContent: 'Add' }) },
                UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: '1 duplicates', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: '1 invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: '1 failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
                window: { api: { addToQueueWithResult: () => request.promise }, showAppToast: vi.fn() },
                mergeQueueState: vi.fn((next: unknown[]) => next),
                updateVodBulkBar: vi.fn(),
                renderQueue: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        const adding = runtime.exposed.bulkAddSelectedVodsToQueue() as Promise<void>;
        runtime.queue = newer;
        request.resolve({ queue: stale, accepted: true, addedId: 'added' });
        await adding;

        expect(runtime.queue).toBe(newer);
        expect(runtime.mergeQueueState).not.toHaveBeenCalled();
    });

    it('keeps failed selections for retry and reports failures separately from duplicates', async () => {
        const toasts: Array<[string, string]> = [];
        const selectedVodUrls = new Set(['https://www.twitch.tv/videos/1']);
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            {
                selectedVodUrls,
                selectedVodUrlRevisions: new Map([['https://www.twitch.tv/videos/1', 1]]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://www.twitch.tv/videos/1', title: 'One', created_at: '2026-08-13', duration: '1h' }],
                queue: [],
                document: { getElementById: () => ({ disabled: false, textContent: 'Add' }) },
                UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: '1 duplicates', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: '1 invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: '1 failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
                window: {
                    api: { addToQueueWithResult: async () => { throw new Error('persist failed'); } },
                    showAppToast: (message: string, kind: string) => toasts.push([message, kind])
                },
                mergeQueueState: (next: unknown[]) => next,
                updateVodBulkBar: vi.fn(),
                renderQueue: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        await runtime.exposed.bulkAddSelectedVodsToQueue();

        expect(Array.from(selectedVodUrls)).toEqual(['https://www.twitch.tv/videos/1']);
        expect(toasts).toEqual([['1 failed', 'warn']]);
    });

    it('keeps persistence-rejected selections for retry and reports them as failures', async () => {
        const toasts: Array<[string, string]> = [];
        const selectedVodUrls = new Set(['https://www.twitch.tv/videos/1']);
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            {
                selectedVodUrls,
                selectedVodUrlRevisions: new Map([['https://www.twitch.tv/videos/1', 1]]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://www.twitch.tv/videos/1', title: 'One', created_at: '2026-08-13', duration: '1h' }],
                queue: [],
                document: { getElementById: () => ({ disabled: false, textContent: 'Add' }) },
                UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: '1 duplicates', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: '1 invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: '1 failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
                window: {
                    api: { addToQueueWithResult: async () => ({ queue: [], accepted: false, reason: 'persistence-failed' }) },
                    showAppToast: (message: string, kind: string) => toasts.push([message, kind])
                },
                mergeQueueState: (next: unknown[]) => next,
                updateVodBulkBar: vi.fn(),
                renderQueue: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        await runtime.exposed.bulkAddSelectedVodsToQueue();

        expect(Array.from(selectedVodUrls)).toEqual(['https://www.twitch.tv/videos/1']);
        expect(toasts).toEqual([['1 failed', 'warn']]);
    });

    it.each(['shutting-down', 'access-denied'] as const)('stops the batch after %s without replacing the visible queue and keeps unattempted selections for retry', async (reason) => {
        const calls: string[] = [];
        const toasts: Array<[string, string]> = [];
        const selectedVodUrls = new Set(['https://www.twitch.tv/videos/1', 'https://www.twitch.tv/videos/2']);
        const visibleQueue = [{ id: 'existing', url: 'https://existing', status: 'downloading', progress: 42 }];
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            {
                selectedVodUrls,
                selectedVodUrlRevisions: new Map([
                    ['https://www.twitch.tv/videos/1', 1],
                    ['https://www.twitch.tv/videos/2', 2]
                ]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [
                    { id: 'vod-1', url: 'https://www.twitch.tv/videos/1', title: 'One', created_at: '2026-08-13', duration: '1h' },
                    { id: 'vod-2', url: 'https://www.twitch.tv/videos/2', title: 'Two', created_at: '2026-08-12', duration: '2h' }
                ],
                queue: visibleQueue,
                document: { getElementById: () => ({ disabled: false, textContent: 'Add' }) },
                UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: 'duplicate', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: 'invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: 'failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
                window: {
                    api: {
                        addToQueueWithResult: async (vod: { url: string }) => {
                            calls.push(vod.url);
                            return { queue: [], accepted: false, reason };
                        }
                    },
                    showAppToast: (message: string, kind: string) => toasts.push([message, kind])
                },
                mergeQueueState: (next: unknown[]) => next,
                updateVodBulkBar: vi.fn(),
                renderQueue: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        await runtime.exposed.bulkAddSelectedVodsToQueue();

        expect(calls).toEqual(['https://www.twitch.tv/videos/1']);
        expect(Array.from(selectedVodUrls)).toEqual([
            'https://www.twitch.tv/videos/1',
            'https://www.twitch.tv/videos/2'
        ]);
        expect(runtime.queue).toBe(visibleQueue);
        expect(toasts).toEqual([['2 failed', 'warn']]);
    });

    it('removes stale selections without VOD data and reports them as invalid', async () => {
        const toasts: Array<[string, string]> = [];
        const selectedVodUrls = new Set(['https://www.twitch.tv/videos/1']);
        const addToQueueWithResult = vi.fn();
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            {
                selectedVodUrls,
                selectedVodUrlRevisions: new Map([['https://www.twitch.tv/videos/1', 1]]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [],
                queue: [],
                document: { getElementById: () => ({ disabled: false, textContent: 'Add' }) },
                UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: '1 duplicates', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: '1 invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: '1 failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
                window: { api: { addToQueueWithResult }, showAppToast: (message: string, kind: string) => toasts.push([message, kind]) },
                mergeQueueState: (next: unknown[]) => next,
                updateVodBulkBar: vi.fn(),
                renderQueue: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        await runtime.exposed.bulkAddSelectedVodsToQueue();

        expect(addToQueueWithResult).not.toHaveBeenCalled();
        expect(Array.from(selectedVodUrls)).toEqual([]);
        expect(toasts).toEqual([['1 invalid', 'warn']]);
    });

    it('reports backend-rejected invalid VOD snapshots separately', async () => {
        const toasts: Array<[string, string]> = [];
        const addToQueueWithResult = vi.fn(async () => ({ queue: [], accepted: false, reason: 'invalid' }));
        const selectedVodUrls = new Set(['https://invalid.example/vod']);
        const runtime = evaluate(
            fragment(streamersSource, 'function removeVodSelectionIfUnchanged', 'interface VodGridMotion'),
            'bulkAddSelectedVodsToQueue',
            {
                selectedVodUrls,
                selectedVodUrlRevisions: new Map([['https://invalid.example/vod', 1]]),
                lastLoadedStreamer: 'alpha',
                lastLoadedVods: [{ id: 'vod-1', url: 'https://invalid.example/vod', title: 'One', created_at: '2026-08-13', duration: '1h' }],
                queue: [],
                document: { getElementById: () => ({ disabled: false, textContent: 'Add' }) },
                UI_TEXT: { vods: { bulkAdding: 'Adding', bulkAddedToQueue: 'Added {count}', bulkAddDuplicate: '{count} duplicates', bulkAddDuplicateOne: '1 duplicates', bulkAddInvalid: '{count} invalid', bulkAddInvalidOne: '1 invalid', bulkAddFailed: '{count} failed', bulkAddFailedOne: '1 failed', bulkAddResult: '{added}/{duplicates}/{invalid}/{failed}' } },
                window: { api: { addToQueueWithResult }, showAppToast: (message: string, kind: string) => toasts.push([message, kind]) },
                mergeQueueState: (next: unknown[]) => next,
                updateVodBulkBar: vi.fn(),
                renderQueue: vi.fn(),
                renderVodGridFromCurrentState: vi.fn()
            }
        );

        await runtime.exposed.bulkAddSelectedVodsToQueue();

        expect(addToQueueWithResult).toHaveBeenCalledOnce();
        expect(Array.from(selectedVodUrls)).toEqual([]);
        expect(toasts).toEqual([['1 invalid', 'warn']]);
    });

    it('reports VOD clipboard success only after fulfillment and rejection as a warning', async () => {
        let resolveWrite: (() => void) | undefined;
        const toasts: Array<[string, string]> = [];
        const body = new FakeMenuElement('body');
        const clipboard = {
            writeText: vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }))
        };
        const context: Record<string, unknown> = {
            config: { downloaded_vod_ids: [] },
            document: {
                body,
                createElement: (tagName: string) => new FakeMenuElement(tagName),
                addEventListener: () => undefined,
                removeEventListener: () => undefined
            },
            Node: FakeMenuElement,
            HTMLElement: FakeMenuElement,
            navigator: { clipboard },
            innerWidth: 1280,
            innerHeight: 720,
            api: { openExternal: () => Promise.resolve() },
            UI_TEXT: {
                vods: {
                    ctxOpenOnTwitch: 'Open',
                    ctxCopyUrl: 'Copy',
                    ctxCopiedUrl: 'Copied',
                    ctxCopyFailed: 'Copy failed',
                    trimButton: 'Trim',
                    addQueue: 'Queue',
                    ctxUnmarkDownloaded: 'Unmark',
                    ctxMarkDownloaded: 'Mark'
                }
            },
            RendererAccessibility: { installMenuKeyboardNavigation: () => undefined, focusFirstMenuItem: () => undefined },
            openClipDialog: () => undefined,
            addToQueue: () => Promise.resolve(),
            toggleVodDownloadedMark: () => Promise.resolve(),
            showAppToast: (message: string, kind: string) => toasts.push([message, kind])
        };
        const runtime = evaluate(
            fragment(streamersSource, 'let activeVodContextMenu', 'async function toggleVodDownloadedMark'),
            'showVodContextMenu',
            context
        );
        const vod = { id: 'vod-1', url: 'https://vod/1', title: 'One', date: '2026-08-13', streamer: 'alpha', duration: '1h' };

        runtime.exposed.showVodContextMenu(10, 10, vod, null);
        body.children[0].children[1].dispatch('click');
        expect(toasts).toEqual([]);
        resolveWrite?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(toasts).toEqual([['Copied', 'info']]);

        clipboard.writeText = vi.fn(async () => { throw new Error('denied'); });
        runtime.exposed.showVodContextMenu(10, 10, vod, null);
        body.children[0].children[1].dispatch('click');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(toasts.at(-1)).toEqual(['Copy failed', 'warn']);
    });

    it('removes VOD context-menu document listeners when closed outside their local callback', () => {
        const added: Array<[string, (...args: unknown[]) => void, boolean]> = [];
        const removed: Array<[string, (...args: unknown[]) => void, boolean]> = [];
        const body = new FakeMenuElement('body');
        const context: Record<string, unknown> = {
            config: { downloaded_vod_ids: [] },
            document: {
                body,
                createElement: (tagName: string) => new FakeMenuElement(tagName),
                addEventListener: (type: string, listener: (...args: unknown[]) => void, capture: boolean) => added.push([type, listener, capture]),
                removeEventListener: (type: string, listener: (...args: unknown[]) => void, capture: boolean) => removed.push([type, listener, capture])
            },
            Node: FakeMenuElement,
            HTMLElement: FakeMenuElement,
            navigator: { clipboard: { writeText: () => Promise.resolve() } },
            innerWidth: 1280,
            innerHeight: 720,
            api: { openExternal: () => Promise.resolve() },
            UI_TEXT: {
                vods: {
                    ctxOpenOnTwitch: 'Open', ctxCopyUrl: 'Copy', ctxCopiedUrl: 'Copied', ctxCopyFailed: 'Failed',
                    trimButton: 'Trim', addQueue: 'Queue', ctxUnmarkDownloaded: 'Unmark', ctxMarkDownloaded: 'Mark'
                }
            },
            RendererAccessibility: { installMenuKeyboardNavigation: () => undefined, focusFirstMenuItem: () => undefined },
            openClipDialog: () => undefined,
            addToQueue: () => Promise.resolve(),
            toggleVodDownloadedMark: () => Promise.resolve()
        };
        const runtime = evaluate(
            fragment(streamersSource, 'let activeVodContextMenu', 'async function toggleVodDownloadedMark'),
            'showVodContextMenu, closeVodContextMenu',
            context
        );

        runtime.exposed.showVodContextMenu(10, 10, { id: 'vod-1', url: 'https://vod/1', title: 'One', date: '2026-08-13', streamer: 'alpha', duration: '1h' }, null);
        runtime.exposed.closeVodContextMenu();

        expect(added.map(([type, _listener, capture]) => [type, capture])).toEqual([['mousedown', true], ['scroll', true]]);
        expect(removed.map(([type, _listener, capture]) => [type, capture])).toEqual([['mousedown', true], ['scroll', true]]);
        expect(removed[0][1]).toBe(added[0][1]);
        expect(removed[1][1]).toBe(added[1][1]);
    });
});

let selectStreamerRequestId = 0;
let vodRenderTaskId = 0;
const VOD_RENDER_CHUNK_SIZE = 64;

// Live status snapshot — updated by the main process via the
// 'live-status-batch-update' IPC event. Keys are lowercase logins so
// the lookup is case-insensitive regardless of how the streamer's
// name was added (display-cased vs login-cased).
const liveStatusByLogin = new Map<string, boolean>();

async function initLiveStatusSubscription(): Promise<void> {
    try {
        const initial = await window.api.getLiveStatusSnapshot();
        for (const [k, v] of Object.entries(initial)) {
            liveStatusByLogin.set(k.toLowerCase(), v === true);
        }
        renderStreamers();
    } catch (_) { /* poller may not have fired yet — silent */ }

    window.api.onLiveStatusBatchUpdate(({ changes }) => {
        let touched = false;
        for (const change of changes) {
            const key = change.login.toLowerCase();
            const prev = liveStatusByLogin.get(key);
            if (prev !== change.isLive) {
                liveStatusByLogin.set(key, change.isLive);
                touched = true;
            }
        }
        if (touched) renderStreamers();
    });
}
(window as unknown as { initLiveStatusSubscription: typeof initLiveStatusSubscription }).initLiveStatusSubscription = initLiveStatusSubscription;

// VOD filter state — persists across renderer reloads via localStorage so the
// user's search query survives an app restart. Cleared explicitly via Esc /
// the clear button. Shared across streamers (acts like a search bar).
let lastLoadedVods: VOD[] = [];
let lastLoadedStreamer: string | null = null;
let vodFilterQuery = '';
const VOD_FILTER_STORAGE_KEY = 'twitch-vod-manager:vod-filter';

// Bulk-select state — keyed by VOD URL since URL is unique per VOD. Cleared
// on streamer switch (selection is per-streamer mental model). NOT persisted
// because a stale selection across reloads is more confusing than helpful.
const selectedVodUrls = new Set<string>();
let vodGridDelegationInitialized = false;

// Hide-downloaded toggle: when enabled, the VOD grid skips entries whose
// vod.id is in config.downloaded_vod_ids. Persisted to localStorage so a
// power user who keeps it enabled doesn't have to re-flip it every launch.
const VOD_HIDE_DOWNLOADED_STORAGE_KEY = 'twitch-vod-manager:vod-hide-downloaded';
let vodHideDownloaded = false;

function loadPersistedHideDownloaded(): boolean {
    return safeLocalStorageGet(VOD_HIDE_DOWNLOADED_STORAGE_KEY) === '1';
}

function persistHideDownloaded(value: boolean): void {
    safeLocalStorageSet(VOD_HIDE_DOWNLOADED_STORAGE_KEY, value ? '1' : '0');
}

function onVodHideDownloadedChange(): void {
    const cb = byId<HTMLInputElement>('vodHideDownloadedToggle');
    vodHideDownloaded = cb.checked;
    persistHideDownloaded(vodHideDownloaded);
    if (lastLoadedStreamer) renderVodGridFromCurrentState();
}

function syncVodHideDownloadedToggle(): void {
    const cb = document.getElementById('vodHideDownloadedToggle') as HTMLInputElement | null;
    if (cb) cb.checked = vodHideDownloaded;
}

type VodSortKey = 'date_desc' | 'date_asc' | 'views_desc' | 'duration_desc' | 'duration_asc';
const VALID_VOD_SORTS: ReadonlyArray<VodSortKey> = ['date_desc', 'date_asc', 'views_desc', 'duration_desc', 'duration_asc'];
const VOD_SORT_STORAGE_KEY = 'twitch-vod-manager:vod-sort';
let vodSortKey: VodSortKey = 'date_desc';

function loadPersistedVodSort(): VodSortKey {
    const stored = safeLocalStorageGet(VOD_SORT_STORAGE_KEY);
    if (stored && (VALID_VOD_SORTS as readonly string[]).includes(stored)) {
        return stored as VodSortKey;
    }
    return 'date_desc';
}

function persistVodSort(key: VodSortKey): void {
    safeLocalStorageSet(VOD_SORT_STORAGE_KEY, key);
}

function vodDurationToSeconds(durationStr: string): number {
    let total = 0;
    const h = durationStr.match(/(\d+)h/);
    const m = durationStr.match(/(\d+)m/);
    const s = durationStr.match(/(\d+)s/);
    if (h) total += parseInt(h[1], 10) * 3600;
    if (m) total += parseInt(m[1], 10) * 60;
    if (s) total += parseInt(s[1], 10);
    return total;
}

function sortVods(vods: VOD[], key: VodSortKey): VOD[] {
    const sorted = [...vods];
    const ts = (s: string): number => {
        const n = new Date(s).getTime();
        return Number.isFinite(n) ? n : 0;
    };
    switch (key) {
        case 'date_desc':
            sorted.sort((a, b) => ts(b.created_at) - ts(a.created_at));
            break;
        case 'date_asc':
            sorted.sort((a, b) => ts(a.created_at) - ts(b.created_at));
            break;
        case 'views_desc':
            sorted.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
            break;
        case 'duration_desc':
            sorted.sort((a, b) => vodDurationToSeconds(b.duration) - vodDurationToSeconds(a.duration));
            break;
        case 'duration_asc':
            sorted.sort((a, b) => vodDurationToSeconds(a.duration) - vodDurationToSeconds(b.duration));
            break;
    }
    return sorted;
}

function onVodSortChange(): void {
    const select = byId<HTMLSelectElement>('vodSortSelect');
    const value = select.value;
    if ((VALID_VOD_SORTS as readonly string[]).includes(value)) {
        vodSortKey = value as VodSortKey;
        persistVodSort(vodSortKey);
        if (lastLoadedStreamer) {
            renderVodGridFromCurrentState();
        }
    }
}

function syncVodSortSelect(): void {
    const select = document.getElementById('vodSortSelect') as HTMLSelectElement | null;
    if (select) select.value = vodSortKey;
}

function refreshVodSortSelectLabels(): void {
    const select = document.getElementById('vodSortSelect') as HTMLSelectElement | null;
    if (!select) return;
    const labels: Record<VodSortKey, string> = {
        date_desc: UI_TEXT.vods.sortDateDesc,
        date_asc: UI_TEXT.vods.sortDateAsc,
        views_desc: UI_TEXT.vods.sortViewsDesc,
        duration_desc: UI_TEXT.vods.sortDurationDesc,
        duration_asc: UI_TEXT.vods.sortDurationAsc
    };
    for (const opt of Array.from(select.options)) {
        const k = opt.value as VodSortKey;
        if (labels[k]) opt.textContent = labels[k];
    }
}

function loadPersistedVodFilter(): string {
    return safeLocalStorageGet(VOD_FILTER_STORAGE_KEY);
}

function persistVodFilter(query: string): void {
    safeLocalStorageSet(VOD_FILTER_STORAGE_KEY, query);
}

function filterVodsByQuery(vods: VOD[], query: string): VOD[] {
    const q = query.trim().toLowerCase();
    if (!q) return vods;
    return vods.filter((vod) => (vod.title || '').toLowerCase().includes(q));
}

function updateVodFilterCount(filteredCount: number, totalCount: number): void {
    const node = document.getElementById('vodFilterCount');
    if (!node) return;
    if (!totalCount || !vodFilterQuery.trim()) {
        node.textContent = '';
        return;
    }
    node.textContent = UI_TEXT.vods.filterMatchCount
        .replace('{shown}', String(filteredCount))
        .replace('{total}', String(totalCount));
}

function syncVodFilterClearButton(): void {
    const btn = document.getElementById('vodFilterClearBtn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.classList.toggle('is-hidden', !vodFilterQuery.trim());
}

function onVodFilterInput(): void {
    const input = byId<HTMLInputElement>('vodFilterInput');
    vodFilterQuery = input.value;
    persistVodFilter(vodFilterQuery);
    syncVodFilterClearButton();
    if (lastLoadedStreamer) {
        renderVodGridFromCurrentState();
    }
}

function clearVodFilter(): void {
    vodFilterQuery = '';
    const input = byId<HTMLInputElement>('vodFilterInput');
    if (input) input.value = '';
    persistVodFilter('');
    syncVodFilterClearButton();
    if (lastLoadedStreamer) {
        renderVodGridFromCurrentState();
    }
}

function focusVodFilter(): void {
    const input = document.getElementById('vodFilterInput') as HTMLInputElement | null;
    if (input) {
        input.focus();
        input.select();
    }
}

function buildVodCardHtml(vod: VOD, streamer: string, downloadedIds?: Set<string>): string {
    const thumb = vod.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180');
    const date = formatUiDate(vod.created_at);
    const safeDisplayTitle = escapeHtml(vod.title || UI_TEXT.vods.untitled);
    const safeUrlAttr = escapeHtml(vod.url);
    const safeTitleAttr = escapeHtml(vod.title || '');
    const safeStreamerAttr = escapeHtml(streamer);
    const safeDateAttr = escapeHtml(vod.created_at);
    const safeDurationAttr = escapeHtml(vod.duration);
    const safeIdAttr = escapeHtml(vod.id);
    const isChecked = selectedVodUrls.has(vod.url);
    const isAlreadyDownloaded = downloadedIds ? downloadedIds.has(vod.id) : false;
    const downloadedBadge = isAlreadyDownloaded
        ? `<div class="vod-downloaded-badge" title="${escapeHtml(UI_TEXT.vods.alreadyDownloaded)}">&#10003;</div>`
        : '';

    // All identity attributes go on data-* — a delegated listener on #vodGrid
    // reads them at click time. This removes the previous inline-onclick
    // template-injection pattern (escapedTitle dance) which was fragile for
    // titles containing backslashes / HTML entities like &apos;.
    return `
        <div class="vod-card${isChecked ? ' selected' : ''}${isAlreadyDownloaded ? ' already-downloaded' : ''}"
             role="button"
             tabindex="0"
             aria-label="${safeTitleAttr}"
             data-vod-id="${safeIdAttr}"
             data-vod-url="${safeUrlAttr}"
             data-vod-title="${safeTitleAttr}"
             data-vod-date="${safeDateAttr}"
             data-vod-streamer="${safeStreamerAttr}"
             data-vod-duration="${safeDurationAttr}">
            <input type="checkbox" class="vod-select-checkbox" data-vod-url="${safeUrlAttr}" ${isChecked ? 'checked' : ''} aria-label="${escapeHtml(UI_TEXT.vods.selectAriaLabel)}">
            ${downloadedBadge}
            <div class="vod-thumb-wrap">
                <img class="vod-thumbnail" loading="lazy" decoding="async" src="${thumb}" alt="" title="${escapeHtml(UI_TEXT.vods.openOnTwitch)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 320 180%22><rect fill=%22%23333%22 width=%22320%22 height=%22180%22/></svg>'">
                <div class="vod-duration-badge">${escapeHtml(vod.duration)}</div>
            </div>
            <div class="vod-info">
                <div class="vod-title" title="${escapeHtml(vod.title || '')}">${safeDisplayTitle}</div>
                <div class="vod-meta">
                    <span>${date}</span>
                    <span>${escapeHtml(vod.duration)}</span>
                    <span>${formatUiNumber(vod.view_count)} ${escapeHtml(UI_TEXT.vods.views)}</span>
                </div>
            </div>
            <div class="vod-actions">
                <button type="button" class="vod-btn secondary" data-vod-action="trim">${escapeHtml(UI_TEXT.vods.trimButton)}</button>
                <button type="button" class="vod-btn primary" data-vod-action="queue">${escapeHtml(UI_TEXT.vods.addQueue)}</button>
            </div>
        </div>
    `;
}

interface VodCardContext {
    id: string;
    url: string;
    title: string;
    date: string;
    streamer: string;
    duration: string;
}

function readVodCardContext(card: HTMLElement | null): VodCardContext | null {
    if (!card) return null;
    const url = card.dataset.vodUrl;
    if (!url) return null;
    return {
        id: card.dataset.vodId || '',
        url,
        title: card.dataset.vodTitle || '',
        date: card.dataset.vodDate || '',
        streamer: card.dataset.vodStreamer || '',
        duration: card.dataset.vodDuration || ''
    };
}

let streamerDragInitialized = false;
let draggedStreamerName: string | null = null;

// Streamer list filter — only kicks in once the user has more than a handful
// of streamers. The input stays display:none below the threshold to avoid
// visual clutter for normal users with 1-3 streamers.
const STREAMER_FILTER_THRESHOLD = 6;
let streamerListFilterQuery = '';

// Per-streamer VOD scroll position. When the user clicks back to a streamer
// they've already viewed, restore where they were instead of jumping to top.
// Lives in localStorage so it survives reloads.
const VOD_SCROLL_POSITIONS_KEY = 'twitch-vod-manager:vod-scroll-positions';
let vodScrollPositions: Record<string, number> = {};
let pendingScrollRestore: { streamer: string; y: number } | null = null;

function loadVodScrollPositions(): void {
    try {
        const raw = localStorage.getItem(VOD_SCROLL_POSITIONS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const cleaned: Record<string, number> = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cleaned[k] = v;
            }
            vodScrollPositions = cleaned;
        }
    } catch { /* localStorage unavailable */ }
}

function persistVodScrollPositions(): void {
    try {
        // Cap to last 32 entries to bound storage size.
        const entries = Object.entries(vodScrollPositions);
        if (entries.length > 32) {
            vodScrollPositions = Object.fromEntries(entries.slice(entries.length - 32));
        }
        localStorage.setItem(VOD_SCROLL_POSITIONS_KEY, JSON.stringify(vodScrollPositions));
    } catch { /* ignore */ }
}

function rememberCurrentVodScroll(): void {
    if (!lastLoadedStreamer) return;
    const grid = document.getElementById('vodGrid');
    if (!grid) return;
    // Find the scroll container — vodGrid sits inside a scrollable .content
    const scrollable = (grid.closest('.content') as HTMLElement | null) || grid;
    const y = scrollable.scrollTop;
    if (Number.isFinite(y) && y >= 0) {
        vodScrollPositions[lastLoadedStreamer] = y;
        persistVodScrollPositions();
    }
}

let vodScrollSaveTimer: number | null = null;

function initVodScrollTracking(): void {
    const grid = document.getElementById('vodGrid');
    if (!grid) return;
    const scrollable = (grid.closest('.content') as HTMLElement | null) || grid;
    scrollable.addEventListener('scroll', () => {
        if (vodScrollSaveTimer) window.clearTimeout(vodScrollSaveTimer);
        vodScrollSaveTimer = window.setTimeout(() => {
            vodScrollSaveTimer = null;
            rememberCurrentVodScroll();
        }, 250);
    }, { passive: true });
}

function initCutterDragDrop(): void {
    const tab = document.getElementById('cutterTab');
    if (!tab) return;

    let dragOverCount = 0;
    const setDragVisual = (active: boolean): void => {
        const preview = document.getElementById('cutterPreview');
        if (preview) preview.classList.toggle('drag-over', active);
    };

    tab.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        dragOverCount++;
        setDragVisual(true);
    });
    tab.addEventListener('dragover', (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    tab.addEventListener('dragleave', () => {
        dragOverCount = Math.max(0, dragOverCount - 1);
        if (dragOverCount === 0) setDragVisual(false);
    });
    tab.addEventListener('drop', async (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        dragOverCount = 0;
        setDragVisual(false);

        const files = Array.from(e.dataTransfer.files || []);
        if (files.length === 0) return;
        // First video-ish file wins
        const allowed = /\.(mp4|mkv|ts|mov|avi)$/i;
        const file = files.find((f) => allowed.test(f.name)) || files[0];
        // Electron extends File with .path even with contextIsolation:true
        const filePath = (file as unknown as { path?: string }).path || '';
        if (!filePath) return;

        const loader = (window as unknown as { loadCutterFromPath?: (p: string) => Promise<void> }).loadCutterFromPath;
        if (typeof loader === 'function') {
            await loader(filePath);
        }
    });
}

function renderStreamers(): void {
    const list = byId('streamerList');
    list.replaceChildren();

    const all = (config.streamers ?? []) as string[];
    const filterInput = document.getElementById('streamerListFilter') as HTMLInputElement | null;
    const sectionTitle = document.getElementById('streamerSectionTitle');
    const showFilter = all.length >= STREAMER_FILTER_THRESHOLD;
    if (filterInput) filterInput.classList.toggle('is-hidden', !showFilter);
    // Compact title margin when filter is shown — avoids double gap.
    if (sectionTitle) sectionTitle.classList.toggle('compact', showFilter);

    // Empty state — small hint inside the sidebar when no streamers have
    // been added yet. Without this the user sees a heading + blank space
    // and has to guess where to add the first streamer.
    if (all.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'streamer-list-empty';
        empty.textContent = UI_TEXT.streamers.sidebarEmpty || 'No streamers yet. Add one via the top bar.';
        list.appendChild(empty);
        const counter = document.getElementById('streamerSectionCounter');
        if (counter) counter.textContent = '';
        const bulkBtn = document.getElementById('btnStreamerBulkRemove') as HTMLButtonElement | null;
        if (bulkBtn) bulkBtn.classList.add('is-hidden');
        return;
    }

    // Section counter — "X · Y live". Updates on every re-render, so it
    // stays accurate after add/remove/live-status changes.
    const counter = document.getElementById('streamerSectionCounter');
    if (counter) {
        const liveCount = all.reduce((n, s) => n + (liveStatusByLogin.get(s.toLowerCase()) === true ? 1 : 0), 0);
        if (all.length === 0) {
            counter.textContent = '';
        } else if (liveCount > 0) {
            counter.innerHTML = `${all.length} <span class="streamer-section-counter-divider" aria-hidden="true">·</span> <span class="streamer-section-counter-live">${liveCount} live</span>`;
        } else {
            counter.textContent = String(all.length);
        }
    }

    const q = (streamerListFilterQuery || '').trim().toLowerCase();
    const visible = q ? all.filter((s) => s.toLowerCase().includes(q)) : all;

    visible.forEach((streamer: string) => {
        const item = document.createElement('div');
        item.className = 'streamer-item' + (currentStreamer === streamer ? ' active' : '');
        item.setAttribute('draggable', 'true');
        item.dataset.streamerName = streamer;
        // Keyboard a11y for the row itself — click selects the streamer.
        // Each chip inside still gets its own focus + Enter/Space wiring
        // and stops propagation, so tabbing through a row lands on row
        // first, then AUTO / VOD / REC / remove in order.
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', streamer);
        if (currentStreamer === streamer) item.setAttribute('aria-current', 'true');

        // Live-dot — red pulsing dot when this streamer is currently
        // broadcasting on Twitch. Populated from the live-status batch
        // poller's snapshot. Renders before the name so the streamer
        // identity stays primary visually.
        const isLive = liveStatusByLogin.get(streamer.toLowerCase()) === true;
        if (isLive) {
            const dot = document.createElement('span');
            dot.className = 'streamer-live-dot';
            const liveLabel = UI_TEXT.streamers.liveNowTooltip || 'Live now';
            dot.title = liveLabel;
            dot.setAttribute('role', 'img');
            dot.setAttribute('aria-label', liveLabel);
            item.appendChild(dot);
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'streamer-name' + (isLive ? ' is-live' : '');
        nameSpan.textContent = streamer;

        // Three streamer-row action chips (AUTO toggle / VOD toggle / REC
        // one-shot). All share the same accessibility wiring:
        // role="button", tabindex="0", aria-pressed for the toggles +
        // aria-label for screen readers, plus Enter/Space keydown
        // activation. wireChipButton centralises that so each chip only
        // declares its own visual class + label + handler.
        const wireChipButton = (el: HTMLElement, opts: {
            handler: () => void;
            ariaLabel: string;
            pressed?: boolean;
        }): void => {
            el.setAttribute('role', 'button');
            el.setAttribute('tabindex', '0');
            el.setAttribute('aria-label', opts.ariaLabel);
            if (opts.pressed !== undefined) el.setAttribute('aria-pressed', String(opts.pressed));
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                opts.handler();
            });
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    opts.handler();
                }
            });
        };

        // AUTO toggle — when enabled, the main-process auto-record poller
        // watches this channel for offline->live transitions and queues a
        // live recording automatically.
        const autoList = (config.auto_record_streamers as string[] | undefined) || [];
        const isAutoOn = autoList.includes(streamer);
        const autoBtn = document.createElement('span');
        autoBtn.className = 'streamer-auto' + (isAutoOn ? ' active' : '');
        autoBtn.textContent = 'AUTO';
        autoBtn.title = UI_TEXT.streamers?.autoRecordTitle || 'Auto-record when this streamer goes live';
        wireChipButton(autoBtn, {
            handler: () => { void toggleAutoRecord(streamer); },
            ariaLabel: UI_TEXT.streamers?.autoRecordTitle || 'Auto-record',
            pressed: isAutoOn
        });

        // VOD-auto-download toggle — periodic scan of this streamer's
        // VOD list, auto-queues anything new within the age window.
        const vodList = (config.auto_vod_download_streamers as string[] | undefined) || [];
        const isVodOn = vodList.includes(streamer);
        const vodBtn = document.createElement('span');
        vodBtn.className = 'streamer-vod' + (isVodOn ? ' active' : '');
        vodBtn.textContent = 'VOD';
        vodBtn.title = UI_TEXT.streamers?.autoVodTitle || 'Auto-download new VODs';
        wireChipButton(vodBtn, {
            handler: () => { void toggleAutoVodDownload(streamer); },
            ariaLabel: UI_TEXT.streamers?.autoVodTitle || 'Auto-download new VODs',
            pressed: isVodOn
        });

        // Live-record one-shot — triggers a recording immediately (server
        // verifies the streamer is online before honoring the request).
        const recBtn = document.createElement('span');
        recBtn.className = 'streamer-rec';
        recBtn.textContent = 'REC';
        recBtn.title = UI_TEXT.streamers?.recordLiveTitle || 'Record live now';
        wireChipButton(recBtn, {
            handler: () => { void triggerLiveRecording(streamer); },
            ariaLabel: UI_TEXT.streamers?.recordLiveTitle || 'Record live now'
        });
        const removeSpan = document.createElement('span');
        removeSpan.className = 'remove';
        removeSpan.textContent = 'x';
        removeSpan.setAttribute('role', 'button');
        removeSpan.setAttribute('tabindex', '0');
        removeSpan.setAttribute('aria-label', UI_TEXT.streamers.removeAria);
        removeSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            void removeStreamer(streamer);
        });
        removeSpan.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                void removeStreamer(streamer);
            }
        });
        item.append(nameSpan, autoBtn, vodBtn, recBtn, removeSpan);

        item.addEventListener('click', () => {
            // Skip click if drag was just released — drop fires after dragend
            if (draggedStreamerName === streamer) return;
            void selectStreamer(streamer);
        });
        item.addEventListener('keydown', (e) => {
            // Activate row on Enter / Space when the row itself (not a
            // chip child) is focused. The chips already preventDefault
            // + stopPropagation on their own keydowns so they won't reach
            // this handler.
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (e.target !== item) return;
            e.preventDefault();
            void selectStreamer(streamer);
        });
        list.appendChild(item);
    });

    // Reveal bulk-remove button only above the filter threshold.
    const bulkBtn = document.getElementById('btnStreamerBulkRemove') as HTMLButtonElement | null;
    if (bulkBtn) bulkBtn.classList.toggle('is-hidden', all.length < STREAMER_FILTER_THRESHOLD);

    initStreamerDragDrop();
}

function onStreamerListFilterChange(): void {
    const input = byId<HTMLInputElement>('streamerListFilter');
    streamerListFilterQuery = input.value;
    renderStreamers();
}

async function bulkRemoveStreamers(): Promise<void> {
    const all = (config.streamers ?? []) as string[];
    if (all.length === 0) return;
    const q = (streamerListFilterQuery || '').trim().toLowerCase();
    // If a filter is active, target only the matching streamers; else
    // require explicit confirmation to clear the entire list.
    const targets = q ? all.filter((s) => s.toLowerCase().includes(q)) : all;
    if (targets.length === 0) return;

    const messageTemplate = q ? UI_TEXT.static.streamerBulkRemoveFiltered : UI_TEXT.static.streamerBulkRemoveAll;
    if (!confirm(messageTemplate.replace('{count}', String(targets.length)))) return;

    const remaining = all.filter((s) => !targets.includes(s));
    config.streamers = remaining;
    config = await window.api.saveConfig({ streamers: remaining });
    if (currentStreamer && targets.includes(currentStreamer)) {
        currentStreamer = null;
        const hide = (window as unknown as { hideStreamerProfileHeader?: () => void }).hideStreamerProfileHeader;
        if (typeof hide === 'function') hide();
    }
    streamerListFilterQuery = '';
    const input = document.getElementById('streamerListFilter') as HTMLInputElement | null;
    if (input) input.value = '';
    renderStreamers();
}

function initStreamerDragDrop(): void {
    if (streamerDragInitialized) return;
    streamerDragInitialized = true;

    const list = byId('streamerList');

    list.addEventListener('dragstart', (e: DragEvent) => {
        const target = e.target as HTMLElement;
        const item = target.closest('.streamer-item') as HTMLElement | null;
        if (!item || !item.dataset.streamerName) return;
        draggedStreamerName = item.dataset.streamerName;
        item.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            // Some browsers refuse the drag without setData
            e.dataTransfer.setData('text/plain', draggedStreamerName);
        }
    });

    list.addEventListener('dragover', (e: DragEvent) => {
        if (!draggedStreamerName) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    list.addEventListener('drop', async (e: DragEvent) => {
        e.preventDefault();
        const target = (e.target as HTMLElement).closest('.streamer-item') as HTMLElement | null;
        if (!target || !draggedStreamerName) return;
        const targetName = target.dataset.streamerName;
        if (!targetName || targetName === draggedStreamerName) return;

        const streamers = [...(config.streamers ?? [])];
        const fromIdx = streamers.indexOf(draggedStreamerName);
        const toIdx = streamers.indexOf(targetName);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = streamers.splice(fromIdx, 1);
        streamers.splice(toIdx, 0, moved);

        config.streamers = streamers;
        renderStreamers();
        config = await window.api.saveConfig({ streamers });
    });

    list.addEventListener('dragend', () => {
        document.querySelectorAll('.streamer-item.dragging').forEach((el) => el.classList.remove('dragging'));
        // Defer clearing draggedStreamerName so the click handler that fires
        // after dragend can suppress the spurious select.
        const wasDragging = draggedStreamerName;
        window.setTimeout(() => {
            if (draggedStreamerName === wasDragging) draggedStreamerName = null;
        }, 50);
    });
}

async function addStreamer(): Promise<void> {
    const input = byId<HTMLInputElement>('newStreamer');
    const name = input.value.trim().toLowerCase();
    if (!name) {
        return;
    }

    // Twitch usernames: 4-25 characters, alphanumeric + underscore.
    // Catch typos / invalid input before it hits the API and silently
    // returns "streamer not found".
    if (!/^[a-zA-Z0-9_]{4,25}$/.test(name)) {
        showAppToast(UI_TEXT.static.streamerInvalid, 'warn');
        return;
    }

    if ((config.streamers ?? []).includes(name)) {
        return;
    }

    config.streamers = [...(config.streamers ?? []), name];
    config = await window.api.saveConfig({ streamers: config.streamers });
    input.value = '';
    renderStreamers();
    await selectStreamer(name);
}

async function removeStreamer(name: string): Promise<void> {
    config.streamers = (config.streamers ?? []).filter((s: string) => s !== name);
    config = await window.api.saveConfig({ streamers: config.streamers });
    renderStreamers();

    if (currentStreamer !== name) {
        return;
    }

    currentStreamer = null;
    const hide = (window as unknown as { hideStreamerProfileHeader?: () => void }).hideStreamerProfileHeader;
    if (typeof hide === 'function') hide();
    byId('vodGrid').innerHTML = `
        <div class="empty-state">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-4 5-4v8zm2-8l5 4-5 4V9z"/></svg>
            <h3>${UI_TEXT.vods.noneTitle}</h3>
            <p>${UI_TEXT.vods.noneText}</p>
        </div>
    `;
}

async function selectStreamer(name: string, forceRefresh = false): Promise<void> {
    // Save where we were on the OLD streamer before navigating away.
    rememberCurrentVodScroll();

    const requestId = ++selectStreamerRequestId;
    const isStaleRequest = () => requestId !== selectStreamerRequestId || currentStreamer !== name;

    currentStreamer = name;
    // Schedule a scroll-restore once the VOD grid renders. The actual
    // restore runs after renderVODs replaces the grid.
    const savedY = vodScrollPositions[name];
    pendingScrollRestore = (typeof savedY === 'number' && savedY > 0) ? { streamer: name, y: savedY } : null;
    renderStreamers();
    const setTitle = (window as unknown as { setPageTitle?: (text: string) => void }).setPageTitle;
    if (typeof setTitle === 'function') setTitle(name);
    else byId('pageTitle').textContent = name;

    // Kick off the profile header load in parallel with VOD fetching.
    // It's a separate request stream and not strictly needed for the VOD
    // grid, so we don't await it here — the skeleton appears immediately.
    const profileLoader = (window as unknown as { loadStreamerProfile?: (login: string) => Promise<void> }).loadStreamerProfile;
    if (typeof profileLoader === 'function') {
        void profileLoader(name);
    }

    if (!isConnected) {
        await connect();
        if (isStaleRequest()) {
            return;
        }
    }

    if (!isConnected) {
        updateStatus(UI_TEXT.status.noLogin, false);
    }

    // Skeleton loader — six placeholder cards while VODs come in. Much
    // less jarring than a "Loading..." text block in an otherwise blank
    // grid. Shimmer animation is in CSS.
    byId('vodGrid').innerHTML = Array.from({ length: 6 }, () => `
        <div class="vod-card vod-card-skeleton">
            <div class="vod-skel-thumb"></div>
            <div class="vod-info">
                <div class="vod-skel-line title"></div>
                <div class="vod-skel-line meta-1"></div>
                <div class="vod-skel-line meta-2"></div>
            </div>
        </div>
    `).join('');

    const userId = await window.api.getUserId(name);
    if (isStaleRequest()) {
        return;
    }

    if (!userId) {
        byId('vodGrid').innerHTML = `<div class="empty-state"><h3>${UI_TEXT.vods.notFound}</h3></div>`;
        return;
    }

    const vods = await window.api.getVODs(userId, forceRefresh);
    if (isStaleRequest()) {
        return;
    }

    renderVODs(vods, name);
}

function setVodGridEmptyState(grid: HTMLElement, title: string, text: string): void {
    // Build via DOM API so the (locale-only) strings can never escape into HTML.
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    const h3 = document.createElement('h3');
    h3.textContent = title;
    const p = document.createElement('p');
    p.textContent = text;
    wrap.appendChild(h3);
    wrap.appendChild(p);
    grid.replaceChildren(wrap);
}

function renderVODs(vods: VOD[] | null | undefined, streamer: string): void {
    // Clear bulk-selection on streamer switch — selection is per-streamer
    if (lastLoadedStreamer && lastLoadedStreamer !== streamer && selectedVodUrls.size > 0) {
        selectedVodUrls.clear();
        updateVodBulkBar();
    }
    lastLoadedVods = Array.isArray(vods) ? vods : [];
    lastLoadedStreamer = streamer;
    initVodGridSelectionDelegation();
    renderVodGridFromCurrentState();

    // After the first chunk lands the grid has size, so scroll-restore can
    // succeed. Use a small delay to let chunked rendering paint.
    if (pendingScrollRestore && pendingScrollRestore.streamer === streamer) {
        const target = pendingScrollRestore;
        pendingScrollRestore = null;
        window.setTimeout(() => {
            const grid = document.getElementById('vodGrid');
            if (!grid) return;
            const scrollable = (grid.closest('.content') as HTMLElement | null) || grid;
            scrollable.scrollTop = target.y;
        }, 80);
    }
}

function initVodGridSelectionDelegation(): void {
    if (vodGridDelegationInitialized) return;
    vodGridDelegationInitialized = true;

    const grid = document.getElementById('vodGrid');
    if (!grid) return;

    grid.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        // 1) Checkbox toggles (bulk-select)
        if (target instanceof HTMLInputElement && target.classList.contains('vod-select-checkbox')) {
            const url = target.dataset.vodUrl || '';
            if (!url) return;
            if (target.checked) selectedVodUrls.add(url);
            else selectedVodUrls.delete(url);
            const card = target.closest('.vod-card') as HTMLElement | null;
            if (card) card.classList.toggle('selected', target.checked);
            updateVodBulkBar();
            return;
        }

        // 2) Action buttons (trim / queue) — replaces the previous inline
        // onclick template that mangled titles with special characters
        const btn = target.closest('button[data-vod-action]') as HTMLButtonElement | null;
        if (btn) {
            const ctx = readVodCardContext(btn.closest('.vod-card') as HTMLElement | null);
            if (!ctx) return;
            if (btn.dataset.vodAction === 'trim') {
                openClipDialog(ctx.url, ctx.title, ctx.date, ctx.streamer, ctx.duration);
            } else if (btn.dataset.vodAction === 'queue') {
                void addToQueue(ctx.url, ctx.title, ctx.date, ctx.streamer, ctx.duration);
            }
            return;
        }

        // 3) Click on thumbnail / title / meta -> open VOD on Twitch in the
        // OS default browser. Convenient + non-destructive.
        const card = target.closest('.vod-card') as HTMLElement | null;
        if (!card) return;
        if (target.closest('.vod-actions') || target.classList.contains('vod-select-checkbox')) return;
        const ctx = readVodCardContext(card);
        if (!ctx) return;
        void window.api.openExternal(ctx.url);
    });

    grid.addEventListener('contextmenu', (e) => {
        const card = (e.target as HTMLElement).closest('.vod-card') as HTMLElement | null;
        if (!card) return;
        const ctx = readVodCardContext(card);
        if (!ctx) return;
        e.preventDefault();
        showVodContextMenu(e.clientX, e.clientY, ctx);
    });

    // Enter / Space on a focused VOD card opens the VOD on Twitch — same
    // outcome as a mouse click on the thumbnail. Skip when focus is on a
    // child (action button, checkbox) because those have their own
    // keyboard handlers (native button + checkbox semantics).
    grid.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const card = target.closest('.vod-card') as HTMLElement | null;
        if (!card || card !== target) return;
        const ctx = readVodCardContext(card);
        if (!ctx) return;
        e.preventDefault();
        void window.api.openExternal(ctx.url);
    });
}

let activeVodContextMenu: HTMLElement | null = null;

function closeVodContextMenu(): void {
    if (!activeVodContextMenu) return;
    activeVodContextMenu.remove();
    activeVodContextMenu = null;
}

function showVodContextMenu(x: number, y: number, ctx: VodCardContext): void {
    closeVodContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    const downloadedIds = new Set(
        Array.isArray(config.downloaded_vod_ids)
            ? (config.downloaded_vod_ids as string[]).filter((id) => typeof id === 'string')
            : []
    );
    const isMarkedDownloaded = downloadedIds.has(ctx.id);

    const makeItem = (label: string, onClick: () => void): HTMLElement => {
        const el = document.createElement('div');
        el.textContent = label;
        el.className = 'context-menu-item';
        el.setAttribute('role', 'menuitem');
        el.addEventListener('click', () => {
            try { onClick(); } finally { closeVodContextMenu(); }
        });
        return el;
    };

    menu.appendChild(makeItem(UI_TEXT.vods.ctxOpenOnTwitch, () => {
        void window.api.openExternal(ctx.url);
    }));
    menu.appendChild(makeItem(UI_TEXT.vods.ctxCopyUrl, () => {
        try {
            void navigator.clipboard.writeText(ctx.url);
            const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
            if (toast) toast(UI_TEXT.vods.ctxCopiedUrl, 'info');
        } catch { /* ignore */ }
    }));
    menu.appendChild(makeItem(UI_TEXT.vods.trimButton, () => {
        openClipDialog(ctx.url, ctx.title, ctx.date, ctx.streamer, ctx.duration);
    }));
    menu.appendChild(makeItem(UI_TEXT.vods.addQueue, () => {
        void addToQueue(ctx.url, ctx.title, ctx.date, ctx.streamer, ctx.duration);
    }));
    menu.appendChild(makeItem(
        isMarkedDownloaded ? UI_TEXT.vods.ctxUnmarkDownloaded : UI_TEXT.vods.ctxMarkDownloaded,
        () => { void toggleVodDownloadedMark(ctx.id, !isMarkedDownloaded); }
    ));

    document.body.appendChild(menu);
    activeVodContextMenu = menu;

    // Reposition if it would clip off the viewport
    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4);
    if (top + rect.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - rect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    // Close on click anywhere else / Escape / scroll
    const dismissOnClick = (ev: MouseEvent) => {
        if (!activeVodContextMenu) return;
        if (ev.target instanceof Node && activeVodContextMenu.contains(ev.target)) return;
        closeVodContextMenu();
        document.removeEventListener('mousedown', dismissOnClick, true);
        document.removeEventListener('keydown', dismissOnEscape, true);
        document.removeEventListener('scroll', dismissOnScroll, true);
    };
    const dismissOnEscape = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return;
        closeVodContextMenu();
        document.removeEventListener('mousedown', dismissOnClick, true);
        document.removeEventListener('keydown', dismissOnEscape, true);
        document.removeEventListener('scroll', dismissOnScroll, true);
    };
    const dismissOnScroll = () => {
        closeVodContextMenu();
        document.removeEventListener('mousedown', dismissOnClick, true);
        document.removeEventListener('keydown', dismissOnEscape, true);
        document.removeEventListener('scroll', dismissOnScroll, true);
    };
    document.addEventListener('mousedown', dismissOnClick, true);
    document.addEventListener('keydown', dismissOnEscape, true);
    document.addEventListener('scroll', dismissOnScroll, true);
}

async function toggleVodDownloadedMark(vodId: string, mark: boolean): Promise<void> {
    const result = await window.api.markVodDownloaded(vodId, mark);
    if (!result?.success) return;
    try {
        config = await window.api.getConfig();
    } catch { /* ignore */ }
    if (lastLoadedStreamer) renderVodGridFromCurrentState();
}

function updateVodBulkBar(): void {
    const bar = document.getElementById('vodBulkBar');
    if (!bar) return;
    const count = selectedVodUrls.size;
    bar.classList.toggle('is-hidden', count === 0);
    const countEl = document.getElementById('vodBulkCount');
    if (countEl) {
        countEl.textContent = UI_TEXT.vods.bulkSelectedCount.replace('{count}', String(count));
    }
}

function clearVodSelection(): void {
    if (selectedVodUrls.size === 0) return;
    selectedVodUrls.clear();
    updateVodBulkBar();
    if (lastLoadedStreamer) renderVodGridFromCurrentState();
}

async function toggleAutoRecord(streamer: string): Promise<void> {
    const current = ((config.auto_record_streamers as string[]) || []).slice();
    const idx = current.indexOf(streamer);
    if (idx >= 0) {
        current.splice(idx, 1);
    } else {
        current.push(streamer);
    }
    config = await window.api.saveConfig({ auto_record_streamers: current });
    renderStreamers();

    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast) {
        const wasAdded = idx < 0;
        const tmpl = wasAdded ? UI_TEXT.streamers.autoRecordEnabled : UI_TEXT.streamers.autoRecordDisabled;
        toast(tmpl.replace('{streamer}', streamer), 'info');
    }
}

async function toggleAutoVodDownload(streamer: string): Promise<void> {
    const current = ((config.auto_vod_download_streamers as string[]) || []).slice();
    const idx = current.indexOf(streamer);
    if (idx >= 0) {
        current.splice(idx, 1);
    } else {
        current.push(streamer);
    }
    config = await window.api.saveConfig({ auto_vod_download_streamers: current });
    renderStreamers();

    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast) {
        const wasAdded = idx < 0;
        const tmpl = wasAdded ? UI_TEXT.streamers.autoVodEnabled : UI_TEXT.streamers.autoVodDisabled;
        toast(tmpl.replace('{streamer}', streamer), 'info');
    }
}

async function triggerLiveRecording(streamer: string): Promise<void> {
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    const result = await window.api.startLiveRecording(streamer);
    if (!toast) return;
    if (result.success) {
        toast(UI_TEXT.streamers.liveRecordingStarted.replace('{streamer}', streamer), 'info');
        return;
    }
    if (result.error === 'OFFLINE') {
        toast(UI_TEXT.streamers.liveRecordingOffline.replace('{streamer}', streamer), 'warn');
        return;
    }
    if (result.error === 'ALREADY_RECORDING') {
        toast(UI_TEXT.streamers.liveRecordingAlreadyActive.replace('{streamer}', streamer), 'warn');
        return;
    }
    toast(UI_TEXT.streamers.liveRecordingFailed + (result.error ? `: ${result.error}` : ''), 'warn');
}

async function bulkMarkSelectedDownloaded(mark: boolean): Promise<void> {
    const urls = Array.from(selectedVodUrls);
    if (urls.length === 0) return;

    let updated = 0;
    for (const url of urls) {
        const vod = lastLoadedVods.find((v) => v.url === url);
        if (!vod || !vod.id) continue;
        try {
            const result = await window.api.markVodDownloaded(vod.id, mark);
            if (result?.success) updated++;
        } catch { /* keep going */ }
    }

    if (updated === 0) return;

    try { config = await window.api.getConfig(); } catch { /* ignore */ }
    selectedVodUrls.clear();
    updateVodBulkBar();
    if (lastLoadedStreamer) renderVodGridFromCurrentState();

    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast) {
        const template = mark ? UI_TEXT.vods.bulkMarkedDownloaded : UI_TEXT.vods.bulkUnmarkedDownloaded;
        toast(template.replace('{count}', String(updated)), 'info');
    }
}

async function bulkAddSelectedVodsToQueue(): Promise<void> {
    const urls = Array.from(selectedVodUrls);
    if (urls.length === 0 || !lastLoadedStreamer) return;
    const streamer = lastLoadedStreamer;

    const btn = document.getElementById('vodBulkAddBtn') as HTMLButtonElement | null;
    const originalText = btn?.textContent || '';
    if (btn) {
        btn.disabled = true;
        btn.textContent = UI_TEXT.vods.bulkAdding;
    }

    let added = 0;
    let skipped = 0;
    for (const url of urls) {
        const vod = lastLoadedVods.find((v) => v.url === url);
        if (!vod) { skipped++; continue; }
        try {
            queue = await window.api.addToQueue({
                url: vod.url,
                title: vod.title,
                date: vod.created_at,
                streamer,
                duration_str: vod.duration
            });
            added++;
        } catch {
            skipped++;
        }
    }

    selectedVodUrls.clear();
    if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
    }
    updateVodBulkBar();
    renderQueue();
    renderVodGridFromCurrentState();

    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast && added > 0) {
        toast(UI_TEXT.vods.bulkAddedToQueue.replace('{count}', String(added)), 'info');
    } else if (toast && skipped > 0) {
        toast(UI_TEXT.vods.bulkAddSkipped, 'warn');
    }
}

function renderVodGridFromCurrentState(): void {
    if (!lastLoadedStreamer) return;

    const grid = byId('vodGrid');
    const renderTaskId = ++vodRenderTaskId;
    const total = lastLoadedVods.length;

    if (total === 0) {
        setVodGridEmptyState(grid, UI_TEXT.vods.noResultsTitle, UI_TEXT.vods.noResultsText);
        updateVodFilterCount(0, 0);
        return;
    }

    const sorted = sortVods(lastLoadedVods, vodSortKey);
    const downloadedIdsForFilter = new Set(
        Array.isArray(config.downloaded_vod_ids)
            ? (config.downloaded_vod_ids as string[]).filter((id) => typeof id === 'string')
            : []
    );
    const sortedAndHidden = vodHideDownloaded
        ? sorted.filter((vod) => !downloadedIdsForFilter.has(vod.id))
        : sorted;
    const filtered = filterVodsByQuery(sortedAndHidden, vodFilterQuery);

    if (filtered.length === 0 && vodFilterQuery.trim()) {
        setVodGridEmptyState(grid, UI_TEXT.vods.filterNoMatchTitle, UI_TEXT.vods.filterNoMatchText);
        updateVodFilterCount(0, total);
        return;
    }

    grid.replaceChildren();
    updateVodFilterCount(filtered.length, total);

    // Build the downloaded-ids lookup once per render — Set.has is O(1) vs
    // Array.includes which would be O(n*m) across all cards.
    const downloadedIds = new Set(
        Array.isArray(config.downloaded_vod_ids)
            ? (config.downloaded_vod_ids as string[]).filter((id) => typeof id === 'string')
            : []
    );

    const scheduleNextChunk = (nextStartIndex: number): void => {
        const delayMs = document.hidden ? 16 : 0;
        window.setTimeout(() => {
            renderChunk(nextStartIndex);
        }, delayMs);
    };

    const renderChunk = (startIndex: number): void => {
        if (renderTaskId !== vodRenderTaskId) {
            return;
        }

        const chunk = filtered.slice(startIndex, startIndex + VOD_RENDER_CHUNK_SIZE);
        if (!chunk.length) {
            return;
        }

        grid.insertAdjacentHTML('beforeend', chunk.map((vod) => buildVodCardHtml(vod, lastLoadedStreamer || '', downloadedIds)).join(''));

        if (startIndex + chunk.length < filtered.length) {
            scheduleNextChunk(startIndex + chunk.length);
        }
    };

    renderChunk(0);
}

async function refreshVODs(): Promise<void> {
    if (!currentStreamer) {
        return;
    }

    await selectStreamer(currentStreamer, true);
}

let archiveStreamerSelectPopulated = false;
let archiveSearchInFlight = false;
let archiveSearchDebounceTimer: number | null = null;

function populateArchiveStreamerSelect(): void {
    if (archiveStreamerSelectPopulated) return;
    const select = document.getElementById('archiveSearchStreamer') as HTMLSelectElement | null;
    if (!select) return;

    const streamers = (config.streamers as string[] | undefined) || [];
    const sorted = [...streamers].sort((a, b) => a.localeCompare(b));
    const opts = sorted.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    applyHtml(select, `<option value="">${escapeHtml(UI_TEXT.static.archiveAllStreamers || 'Alle Streamer')}</option>${opts}`);
    archiveStreamerSelectPopulated = true;
}

function onArchiveSearchInput(): void {
    if (archiveSearchDebounceTimer !== null) {
        window.clearTimeout(archiveSearchDebounceTimer);
    }
    // 250ms debounce — feels snappy without spamming the IO walker on
    // every keystroke. The walk is fast but pointless to repeat mid-type.
    archiveSearchDebounceTimer = window.setTimeout(() => {
        archiveSearchDebounceTimer = null;
        void performArchiveSearch();
    }, 250);
}

async function performArchiveSearch(): Promise<void> {
    if (archiveSearchInFlight) return;
    populateArchiveStreamerSelect();

    const queryEl = document.getElementById('archiveSearchQuery') as HTMLInputElement | null;
    const typeEl = document.getElementById('archiveSearchType') as HTMLSelectElement | null;
    const streamerEl = document.getElementById('archiveSearchStreamer') as HTMLSelectElement | null;
    const sortEl = document.getElementById('archiveSearchSort') as HTMLSelectElement | null;
    const summaryEl = document.getElementById('archiveSearchSummary');
    const resultsEl = document.getElementById('archiveSearchResults');
    const btn = document.getElementById('btnArchiveSearch') as HTMLButtonElement | null;
    if (!resultsEl) return;

    archiveSearchInFlight = true;
    if (btn) btn.disabled = true;
    if (summaryEl) summaryEl.textContent = UI_TEXT.static.archiveSearching || 'Scanne...';

    try {
        const filter = {
            query: queryEl?.value || '',
            type: ((typeEl?.value as 'all' | 'live' | 'vod') || 'all'),
            streamer: streamerEl?.value || '',
            sinceMs: null,
            untilMs: null,
            sort: ((sortEl?.value as 'date_desc') || 'date_desc'),
            limit: 200
        };
        const result = await window.api.searchArchive(filter);
        renderArchiveSearchResults(result);
    } catch (e) {
        if (summaryEl) summaryEl.textContent = `${UI_TEXT.static.errorPrefix}: ${String(e)}`;
        applyHtml(resultsEl, '');
    } finally {
        archiveSearchInFlight = false;
        if (btn) btn.disabled = false;
    }
}

function renderArchiveSearchResults(result: ArchiveSearchResult): void {
    const summaryEl = document.getElementById('archiveSearchSummary');
    const resultsEl = document.getElementById('archiveSearchResults');
    if (!resultsEl) return;

    if (!result.rootExists) {
        if (summaryEl) summaryEl.textContent = UI_TEXT.static.archiveNoRoot;
        applyHtml(resultsEl, '');
        return;
    }

    if (summaryEl) {
        const tmpl = result.truncated
            ? UI_TEXT.static.archiveSummaryTruncated
            : UI_TEXT.static.archiveSummary;
        summaryEl.textContent = (tmpl || '')
            .replace('{matchCount}', String(result.matchCount))
            .replace('{scanned}', String(result.totalScanned))
            .replace('{shown}', String(result.hits.length));
    }

    if (result.hits.length === 0) {
        applyHtml(resultsEl, `<div class="archive-no-matches">${escapeHtml(UI_TEXT.static.archiveNoMatches || 'Keine Treffer.')}</div>`);
        return;
    }

    const rows = result.hits.map((hit) => {
        const date = formatUiDateTime(new Date(hit.mtimeMs));
        const typeBadge = `<span class="archive-type-badge ${hit.type === 'live' ? 'live' : 'vod'}">${hit.type === 'live' ? 'LIVE' : 'VOD'}</span>`;
        const safeFullAttr = hit.fullPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const chatBtn = hit.chatPath
            ? `<button type="button" class="queue-detail-btn" onclick="openEventsOrChat('${safeFullAttr.replace(/\.(mp4|mkv|ts|m4v)$/i, '.chat.jsonl')}', '${escapeHtml(hit.fileName)}', 'chat')">${escapeHtml(UI_TEXT.static.archiveViewChat || 'Chat')}</button>`
            : '';
        const eventsBtn = hit.eventsPath
            ? `<button type="button" class="queue-detail-btn" onclick="openEventsOrChat('${(hit.eventsPath || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${escapeHtml(hit.fileName)}', 'events')">${escapeHtml(UI_TEXT.static.archiveViewEvents || 'Events')}</button>`
            : '';
        return `
            <div class="archive-result-row">
                <div class="archive-result-body">
                    <div class="archive-result-meta">
                        ${typeBadge}
                        <strong class="archive-result-streamer">${escapeHtml(hit.streamer)}</strong>
                        <span class="archive-result-date">${escapeHtml(date)}</span>
                    </div>
                    <div class="archive-result-filename" title="${escapeHtml(hit.fullPath)}">${escapeHtml(hit.fileName)}</div>
                    <div class="archive-result-size">${escapeHtml(formatBytes(hit.size))}</div>
                </div>
                <div class="archive-result-actions">
                    <button type="button" class="queue-detail-btn" onclick="openFilePath('${safeFullAttr}')">${escapeHtml(UI_TEXT.static.archiveOpen || 'Oeffnen')}</button>
                    <button type="button" class="queue-detail-btn" onclick="showFileInFolder('${safeFullAttr}')">${escapeHtml(UI_TEXT.static.archiveShowInFolder || 'Ordner')}</button>
                    ${chatBtn}
                    ${eventsBtn}
                </div>
            </div>
        `;
    }).join('');

    applyHtml(resultsEl, rows);
}

function openFilePath(filePath: string): void {
    void window.api.openFile(filePath);
}

function showFileInFolder(filePath: string): void {
    void window.api.showInFolder(filePath);
}

function openEventsOrChat(filePath: string, title: string, kind: 'chat' | 'events'): void {
    if (kind === 'events') {
        const fn = (window as unknown as { openEventsViewer?: (p: string, t: string) => void }).openEventsViewer;
        if (typeof fn === 'function') fn(filePath, title);
    } else {
        const fn = (window as unknown as { openChatViewer?: (p: string, t: string) => void }).openChatViewer;
        if (typeof fn === 'function') fn(filePath, title);
    }
}

(window as unknown as {
    performArchiveSearch: typeof performArchiveSearch;
    onArchiveSearchInput: typeof onArchiveSearchInput;
    openFilePath: typeof openFilePath;
    showFileInFolder: typeof showFileInFolder;
    openEventsOrChat: typeof openEventsOrChat;
}).performArchiveSearch = performArchiveSearch;
(window as unknown as { onArchiveSearchInput: typeof onArchiveSearchInput }).onArchiveSearchInput = onArchiveSearchInput;
(window as unknown as { openFilePath: typeof openFilePath }).openFilePath = openFilePath;
(window as unknown as { showFileInFolder: typeof showFileInFolder }).showFileInFolder = showFileInFolder;
(window as unknown as { openEventsOrChat: typeof openEventsOrChat }).openEventsOrChat = openEventsOrChat;

function initArchiveSearchInput(): void {
    const queryEl = document.getElementById('archiveSearchQuery') as HTMLInputElement | null;
    if (queryEl && !queryEl.dataset.bound) {
        queryEl.addEventListener('input', onArchiveSearchInput);
        queryEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') void performArchiveSearch();
        });
        queryEl.dataset.bound = '1';
    }
    const filters = ['archiveSearchType', 'archiveSearchStreamer', 'archiveSearchSort'];
    for (const id of filters) {
        const el = document.getElementById(id) as HTMLSelectElement | null;
        if (el && !el.dataset.bound) {
            el.addEventListener('change', () => { void performArchiveSearch(); });
            el.dataset.bound = '1';
        }
    }
}
(window as unknown as { initArchiveSearchInput: typeof initArchiveSearchInput }).initArchiveSearchInput = initArchiveSearchInput;

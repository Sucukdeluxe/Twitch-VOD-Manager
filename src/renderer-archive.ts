let archivePageOffset = 0;
let archiveCriteriaKey = '';
let archiveRefreshRequested = false;
let archiveSearchInFlight = false;
let archiveSearchFailed = false;
let archiveSearchRequested = false;
let archiveSearchDebounceTimer: number | null = null;
let lastArchiveSearchResult: ArchiveSearchResult | null = null;
let lastArchiveFilterKey = '';
let archiveStreamerOptionsKey = '';
const archiveKnownStreamers = new Set<string>();

function populateArchiveStreamerSelect(): void {
    const select = document.getElementById('archiveSearchStreamer') as HTMLSelectElement | null;
    if (!select) return;
    const selected = select.value;
    const configured = (config.streamers as string[] | undefined) || [];
    const names = new Map<string, string>();
    for (const name of [...configured, ...archiveKnownStreamers, ...(selected ? [selected] : [])]) names.set(name.toLowerCase(), name);
    const sorted = [...names.values()].sort((left, right) => left.localeCompare(right, getIntlLocale()));
    const key = JSON.stringify([currentLanguage, sorted]);
    if (key === archiveStreamerOptionsKey) return;
    archiveStreamerOptionsKey = key;
    select.replaceChildren(new Option(UI_TEXT.static.archiveAllStreamers, ''), ...sorted.map(name => new Option(name, name)));
    select.value = sorted.find(name => name.toLowerCase() === selected.toLowerCase()) || '';
}

function getArchiveSearchFilter() {
    const criteria = {
        query: (document.getElementById('archiveSearchQuery') as HTMLInputElement | null)?.value.trim() || '',
        type: ((document.getElementById('archiveSearchType') as HTMLSelectElement | null)?.value || 'all') as 'all' | 'live' | 'vod' | 'clip' | 'chat' | 'events',
        streamer: (document.getElementById('archiveSearchStreamer') as HTMLSelectElement | null)?.value || '',
        sinceMs: null,
        untilMs: null,
        sort: ((document.getElementById('archiveSearchSort') as HTMLSelectElement | null)?.value || 'date_desc') as 'date_desc' | 'date_asc' | 'size_desc' | 'size_asc' | 'name_asc',
        limit: 200
    };
    const key = JSON.stringify(criteria);
    if (key !== archiveCriteriaKey) { archivePageOffset = 0; archiveCriteriaKey = key; }
    return { ...criteria, offset: archivePageOffset };
}

function changeArchivePage(direction: number): void {
    if (archiveSearchInFlight || !lastArchiveSearchResult || Math.abs(direction) !== 1) return;
    archivePageOffset = Math.max(0, Math.min(archivePageOffset + direction * 200, Math.max(0, Math.ceil(lastArchiveSearchResult.matchCount / 200) - 1) * 200));
    void performArchiveSearch();
}

function renderArchivePagination(): void {
    const result = lastArchiveSearchResult;
    const pages = Math.max(1, Math.ceil((result?.matchCount || 0) / 200));
    const page = Math.floor((result?.offset ?? 0) / 200) + 1;
    const pager = byId<HTMLElement>('archivePagination');
    if (!pager) return;
    pager.style.visibility = pages > 1 ? 'visible' : 'hidden';
    pager.setAttribute('aria-label', currentLanguage === 'de' ? 'Archiv-Seiten' : 'Archive pages');
    byId<HTMLButtonElement>('archivePrevious').disabled = archiveSearchInFlight || archiveSearchFailed || page <= 1;
    byId<HTMLButtonElement>('archiveNext').disabled = archiveSearchInFlight || archiveSearchFailed || page >= pages;
    byId('archivePrevious').textContent = currentLanguage === 'de' ? 'Zurück' : 'Previous';
    byId('archiveNext').textContent = currentLanguage === 'de' ? 'Weiter' : 'Next';
    byId('archivePageLabel').textContent = currentLanguage === 'de' ? 'Seite ' + formatUiNumber(page) + ' von ' + formatUiNumber(pages) : 'Page ' + formatUiNumber(page) + ' of ' + formatUiNumber(pages);
}

function onArchiveSearchInput(): void {
    if (archiveSearchDebounceTimer !== null) window.clearTimeout(archiveSearchDebounceTimer);
    archiveSearchDebounceTimer = window.setTimeout(() => {
        archiveSearchDebounceTimer = null;
        void performArchiveSearch();
    }, 250);
}

async function performArchiveSearch(refresh = false): Promise<void> {
    archiveRefreshRequested ||= refresh;
    if (archiveSearchDebounceTimer !== null) {
        window.clearTimeout(archiveSearchDebounceTimer);
        archiveSearchDebounceTimer = null;
    }
    archiveSearchRequested = true;
    if (archiveSearchInFlight) return;
    const results = document.getElementById('archiveSearchResults');
    const summary = document.getElementById('archiveSearchSummary');
    const button = document.getElementById('btnArchiveSearch') as HTMLButtonElement | null;
    if (!results) return;
    archiveSearchInFlight = true;
    archiveSearchFailed = false;
    renderArchivePagination();
    results.setAttribute('aria-busy', 'true');
    if (button) button.disabled = true;
    try {
        do {
            archiveSearchRequested = false;
            populateArchiveStreamerSelect();
            const filter = getArchiveSearchFilter();
            const key = JSON.stringify(filter);
            if (summary) {
                summary.textContent = UI_TEXT.static.archiveSearching;
                summary.classList.remove('is-error');
            }
            try {
                const refresh = archiveRefreshRequested;
                archiveRefreshRequested = false;
                const result = await window.api.searchArchive({ ...filter, refresh });
                if (key !== JSON.stringify(getArchiveSearchFilter())) archiveSearchRequested = true;
                if (archiveSearchRequested) continue;
                const preserveScroll = key === lastArchiveFilterKey;
                result.offset ??= filter.offset;
                archivePageOffset = result.offset;
                lastArchiveFilterKey = JSON.stringify(getArchiveSearchFilter());
                lastArchiveSearchResult = result;
                for (const streamer of result.streamers || result.hits.map(hit => hit.streamer)) archiveKnownStreamers.add(streamer);
                populateArchiveStreamerSelect();
                renderArchiveSearchResults(result, preserveScroll);
            } catch (error) {
                if (key !== JSON.stringify(getArchiveSearchFilter())) archiveSearchRequested = true;
                if (!archiveSearchRequested) archiveSearchFailed = true;
                if (!archiveSearchRequested && summary) {
                    summary.textContent = UI_TEXT.static.errorPrefix + ': ' + (error instanceof Error ? error.message : String(error));
                    summary.classList.add('is-error');
                }
            }
        } while (archiveSearchRequested);
    } finally {
        archiveSearchInFlight = false;
        results.setAttribute('aria-busy', 'false');
        if (button) button.disabled = false;
        renderArchivePagination();
    }
}

function refreshArchiveSearchTexts(): void {
    populateArchiveStreamerSelect();
    if (lastArchiveSearchResult) renderArchiveSearchResults(lastArchiveSearchResult, true);
    if (archiveSearchInFlight) setText('archiveSearchSummary', UI_TEXT.static.archiveSearching);
}

function archiveElement(tag: string, className: string, text = ''): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
}

function renderArchiveSearchResults(result: ArchiveSearchResult, preserveScroll = false): void {
    const summary = document.getElementById('archiveSearchSummary');
    const results = document.getElementById('archiveSearchResults');
    if (!results) return;
    const scrollTop = preserveScroll ? results.scrollTop : 0;
    summary?.classList.remove('is-error');
    renderArchivePagination();
    if (!result.rootExists) {
        if (summary) summary.textContent = '';
        results.replaceChildren(archiveElement('div', 'insights-empty archive-empty', UI_TEXT.static.archiveNoRoot));
        return;
    }
    if (summary) {
        summary.textContent = (result.matchCount > 200 ? UI_TEXT.static.archiveSummaryTruncated : UI_TEXT.static.archiveSummary)
            .replace('{first}', formatUiNumber((result.offset ?? 0) + 1))
            .replace('{last}', formatUiNumber((result.offset ?? 0) + result.hits.length))
            .replace('{matchCount}', formatUiNumber(result.matchCount))
            .replace('{scanned}', formatUiNumber(result.totalScanned))
            .replace('{shown}', formatUiNumber(result.hits.length));
    }
    if (result.hits.length === 0) {
        results.replaceChildren(archiveElement('div', 'insights-empty archive-empty', UI_TEXT.static.archiveNoMatches));
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const hit of result.hits) {
        const row = archiveElement('article', 'archive-result-row');
        const body = archiveElement('div', 'archive-result-body');
        const meta = archiveElement('div', 'archive-result-meta');
        const kind = hit.type === 'live' ? 'LIVE' : hit.type === 'clip' ? 'CLIP' : 'VOD';
        meta.append(archiveElement('span', 'archive-type-badge ' + hit.type, kind), archiveElement('strong', 'archive-result-streamer', hit.streamer));
        const filename = archiveElement('div', 'archive-result-filename', hit.fileName);
        filename.title = hit.fullPath;
        const details = archiveElement('div', 'archive-result-details');
        details.append(archiveElement('span', 'archive-result-date', formatUiDateTime(new Date(hit.mtimeMs))), archiveElement('span', 'archive-result-size', formatBytes(hit.size)));
        body.append(meta, filename, details);
        const actions = archiveElement('div', 'archive-result-actions');
        const action = (label: string, callback: () => void) => {
            const element = document.createElement('button');
            element.type = 'button';
            element.className = 'queue-detail-btn';
            element.textContent = label;
            element.addEventListener('click', callback);
            actions.append(element);
        };
        action(UI_TEXT.static.archiveOpen, () => openFilePath(hit.fullPath));
        action(UI_TEXT.static.archiveShowInFolder, () => showFileInFolder(hit.fullPath));
        if (hit.chatPath) action(UI_TEXT.static.archiveViewChat, () => openEventsOrChat(hit.chatPath!, hit.fileName, 'chat'));
        if (hit.eventsPath) action(UI_TEXT.static.archiveViewEvents, () => openEventsOrChat(hit.eventsPath!, hit.fileName, 'events'));
        row.append(body, actions);
        fragment.append(row);
    }
    results.replaceChildren(fragment);
    results.scrollTop = scrollTop;
}

function showArchiveActionError(): void {
    const summary = document.getElementById('archiveSearchSummary');
    if (!summary) return;
    summary.textContent = UI_TEXT.static.archiveActionFailed;
    summary.classList.add('is-error');
}

function openFilePath(filePath: string): void {
    void window.api.openFile(filePath).then(success => { if (!success) showArchiveActionError(); }).catch(showArchiveActionError);
}

function showFileInFolder(filePath: string): void {
    void window.api.showInFolder(filePath).then(success => { if (!success) showArchiveActionError(); }).catch(showArchiveActionError);
}

function openEventsOrChat(filePath: string, title: string, kind: 'chat' | 'events'): void {
    const api = window as unknown as { openEventsViewer?: (path: string, title: string) => void; openChatViewer?: (path: string, title: string) => void };
    const open = kind === 'events' ? api.openEventsViewer : api.openChatViewer;
    if (typeof open === 'function') open(filePath, title);
    else showArchiveActionError();
}

function initArchiveSearchInput(): void {
    const query = document.getElementById('archiveSearchQuery') as HTMLInputElement | null;
    if (query && !query.dataset.bound) {
        query.addEventListener('input', onArchiveSearchInput);
        query.addEventListener('keydown', event => { if (event.key === 'Enter') void performArchiveSearch(); });
        query.dataset.bound = '1';
    }
    for (const id of ['archiveSearchType', 'archiveSearchStreamer', 'archiveSearchSort']) {
        const select = document.getElementById(id) as HTMLSelectElement | null;
        if (select && !select.dataset.bound) {
            select.addEventListener('change', () => { void performArchiveSearch(); });
            select.dataset.bound = '1';
        }
    }
}

Object.assign(window, { changeArchivePage, performArchiveSearch, onArchiveSearchInput, openFilePath, showFileInFolder, openEventsOrChat, initArchiveSearchInput });

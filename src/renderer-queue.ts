function renderRecordingHealthBadge(health: 'ok' | 'stale' | 'unknown' | undefined): string {
    if (!health) return '';
    const labels = UI_TEXT.queue.recordingHealth || { ok: 'Healthy', stale: 'Stalled', unknown: 'Pending data' };
    const cls = health === 'ok' ? 'health-ok' : (health === 'stale' ? 'health-stale' : 'health-unknown');
    const title = labels[health] || '';
    return `<span class="queue-health-dot ${cls}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`;
}

function renderQueueItemFileActions(item: QueueItem): string {
    if (item.status !== 'completed' || !item.outputFiles || item.outputFiles.length === 0) {
        return '';
    }

    const first = item.outputFiles[0];
    if (typeof first !== 'string' || !first) return '';
    const safeFirst = escapeHtml(first);
    const safeFirstAttr = first.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const buttons: string[] = [];

    // "Open file" only makes sense when there's exactly one output (a clip /
    // full VOD download). For multi-part downloads "open the first part" is
    // surprising — the user almost always wants the folder.
    if (item.outputFiles.length === 1) {
        buttons.push(`<button type="button" class="queue-detail-btn" onclick="invokeOpenFile('${safeFirstAttr}')">${escapeHtml(UI_TEXT.queue.openFile)}</button>`);
    }
    buttons.push(`<button type="button" class="queue-detail-btn" onclick="invokeShowInFolder('${safeFirstAttr}')">${escapeHtml(UI_TEXT.queue.showInFolder)}</button>`);

    // Surface a "View chat" button when a sibling chat file exists in the
    // outputs list. Single click opens the in-app viewer modal.
    const chatFile = item.outputFiles.find((f) => /\.chat\.json(l)?$/i.test(f));
    if (chatFile) {
        const safeChatAttr = chatFile.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        buttons.push(`<button type="button" class="queue-detail-btn" onclick="openChatViewer('${safeChatAttr}', '${escapeHtml(item.title || item.streamer || '').replace(/'/g, "\\'")}')">${escapeHtml(UI_TEXT.queue.viewChat)}</button>`);
    }

    // Same pattern for the .events.jsonl sidecar — title/game change timeline.
    const eventsFile = item.outputFiles.find((f) => /\.events\.jsonl$/i.test(f));
    if (eventsFile) {
        const safeEventsAttr = eventsFile.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        buttons.push(`<button type="button" class="queue-detail-btn" onclick="openEventsViewer('${safeEventsAttr}', '${escapeHtml(item.title || item.streamer || '').replace(/'/g, "\\'")}')">${escapeHtml(UI_TEXT.queue.viewEvents)}</button>`);
    }

    const fileLabel = item.outputFiles.length === 1
        ? safeFirst
        : `${escapeHtml(UI_TEXT.queue.outputFilesLabel.replace('{count}', String(item.outputFiles.length)))}`;

    return `
        <div class="queue-output-row">
            ${buttons.join('')}
            <span class="queue-output-label">${fileLabel}</span>
        </div>
    `;
}

async function invokeOpenFile(filePath: string): Promise<void> {
    const ok = await window.api.openFile(filePath);
    if (!ok) {
        const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
        if (toast) toast(UI_TEXT.queue.openFileFailed, 'warn');
    }
}

async function invokeShowInFolder(filePath: string): Promise<void> {
    const ok = await window.api.showInFolder(filePath);
    if (!ok) {
        const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
        if (toast) toast(UI_TEXT.queue.openFileFailed, 'warn');
    }
}

function buildQueueFingerprint(url: string, streamer: string, date: string, customClip?: CustomClip): string {
    const clipFingerprint = customClip
        ? [
            'clip',
            customClip.startSec,
            customClip.durationSec,
            customClip.startPart,
            customClip.filenameFormat,
            (customClip.filenameTemplate || '').trim().toLowerCase()
        ].join(':')
        : 'vod';

    return [
        (url || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, ''),
        (streamer || '').trim().toLowerCase(),
        (date || '').trim(),
        clipFingerprint
    ].join('|');
}

let lastQueueRenderFingerprint = '';

function getQueueRenderFingerprint(items: QueueItem[]): string {
    const lang = typeof currentLanguage === 'string' ? currentLanguage : 'en';
    const pieces = items.map((item) => [
        item.id,
        item.status,
        Math.round((Number(item.progress) || 0) * 10),
        item.currentPart || 0,
        item.totalParts || 0,
        item.speed || '',
        item.eta || '',
        item.progressStatus || '',
        item.last_error || '',
        item.mergeGroup?.mergePhase || ''
    ].join(':'));

    return `${lang}|${selectedQueueIds.join(',')}|${[...expandedQueueIds].join(',')}|${pieces.join('|')}`;
}

function hasActiveQueueDuplicate(url: string, streamer: string, date: string, customClip?: CustomClip): boolean {
    const target = buildQueueFingerprint(url, streamer, date, customClip);
    return queue.some((item) => {
        if (item.status !== 'pending' && item.status !== 'downloading' && item.status !== 'paused') {
            return false;
        }

        return buildQueueFingerprint(item.url, item.streamer, item.date, item.customClip) === target;
    });
}

async function addToQueue(url: string, title: string, date: string, streamer: string, duration: string): Promise<void> {
    if ((config.prevent_duplicate_downloads as boolean) !== false && hasActiveQueueDuplicate(url, streamer, date)) {
        alert(UI_TEXT.queue.duplicateSkipped);
        return;
    }

    queue = await window.api.addToQueue({
        url,
        title,
        date,
        streamer,
        duration_str: duration
    });
    renderQueue();
}

async function removeFromQueue(id: string): Promise<void> {
    queue = await window.api.removeFromQueue(id);
    renderQueue();
}

async function clearCompleted(): Promise<void> {
    queue = await window.api.clearCompleted();
    renderQueue();
}

async function retryFailedDownloads(): Promise<void> {
    queue = await window.api.retryFailedDownloads();
    renderQueue();
}

async function retryQueueItem(id: string): Promise<void> {
    queue = await window.api.retryQueueItem(id);
    renderQueue();
}

let queueContextMenuInitialized = false;
let activeQueueContextMenu: HTMLElement | null = null;

function closeQueueContextMenu(): void {
    if (!activeQueueContextMenu) return;
    activeQueueContextMenu.remove();
    activeQueueContextMenu = null;
}

function initQueueContextMenu(): void {
    if (queueContextMenuInitialized) return;
    queueContextMenuInitialized = true;

    const list = byId('queueList');
    list.addEventListener('contextmenu', (e: MouseEvent) => {
        const itemEl = (e.target as HTMLElement).closest('.queue-item') as HTMLElement | null;
        if (!itemEl) return;
        const id = itemEl.dataset.id;
        if (!id) return;
        const item = queue.find((i) => i.id === id);
        if (!item) return;
        e.preventDefault();
        showQueueContextMenu(e.clientX, e.clientY, item);
    });
}

function showQueueContextMenu(x: number, y: number, item: QueueItem): void {
    closeQueueContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    const makeItem = (label: string, onClick: () => void, disabled = false): HTMLElement => {
        const el = document.createElement('div');
        el.textContent = label;
        el.className = 'context-menu-item' + (disabled ? ' disabled' : '');
        el.setAttribute('role', 'menuitem');
        if (disabled) el.setAttribute('aria-disabled', 'true');
        if (!disabled) {
            el.addEventListener('click', () => {
                try { onClick(); } finally { closeQueueContextMenu(); }
            });
        }
        return el;
    };

    const makeSeparator = (): HTMLElement => {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        sep.setAttribute('role', 'separator');
        return sep;
    };

    const isPending = item.status === 'pending' || item.status === 'paused';
    const isFailed = item.status === 'error';
    const isCompleted = item.status === 'completed';

    if (isPending) {
        menu.appendChild(makeItem(UI_TEXT.queue.ctxMoveTop, () => { void moveQueueItemTo(item.id, 'top'); }));
        menu.appendChild(makeItem(UI_TEXT.queue.ctxMoveBottom, () => { void moveQueueItemTo(item.id, 'bottom'); }));
        menu.appendChild(makeSeparator());
    }

    if (isFailed) {
        menu.appendChild(makeItem(UI_TEXT.queue.retryItem, () => { void retryQueueItem(item.id); }));
        menu.appendChild(makeSeparator());
    }

    if (isCompleted && item.outputFiles && item.outputFiles.length > 0) {
        const first = item.outputFiles[0];
        if (item.outputFiles.length === 1) {
            menu.appendChild(makeItem(UI_TEXT.queue.openFile, () => { void window.api.openFile(first); }));
        }
        menu.appendChild(makeItem(UI_TEXT.queue.showInFolder, () => { void window.api.showInFolder(first); }));
        menu.appendChild(makeSeparator());
    }

    menu.appendChild(makeItem(UI_TEXT.queue.ctxCopyUrl, () => {
        try {
            void navigator.clipboard.writeText(item.url);
            const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
            if (toast) toast(UI_TEXT.queue.ctxCopiedUrl, 'info');
        } catch { /* ignore */ }
    }));
    menu.appendChild(makeItem(UI_TEXT.queue.ctxOpenOnTwitch, () => {
        void window.api.openExternal(item.url);
    }));
    menu.appendChild(makeSeparator());
    menu.appendChild(makeItem(UI_TEXT.queue.ctxRemove, () => { void removeFromQueue(item.id); }));

    document.body.appendChild(menu);
    activeQueueContextMenu = menu;

    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4);
    if (top + rect.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - rect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const dismissOnClick = (ev: MouseEvent) => {
        if (!activeQueueContextMenu) return;
        if (ev.target instanceof Node && activeQueueContextMenu.contains(ev.target)) return;
        cleanup();
    };
    const dismissOnEscape = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cleanup();
    };
    const dismissOnScroll = () => cleanup();
    const cleanup = (): void => {
        closeQueueContextMenu();
        document.removeEventListener('mousedown', dismissOnClick, true);
        document.removeEventListener('keydown', dismissOnEscape, true);
        document.removeEventListener('scroll', dismissOnScroll, true);
    };
    document.addEventListener('mousedown', dismissOnClick, true);
    document.addEventListener('keydown', dismissOnEscape, true);
    document.addEventListener('scroll', dismissOnScroll, true);
}

async function moveQueueItemTo(id: string, where: 'top' | 'bottom'): Promise<void> {
    const idx = queue.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const reordered = [...queue];
    const [moved] = reordered.splice(idx, 1);
    if (where === 'top') reordered.unshift(moved);
    else reordered.push(moved);
    queue = reordered;
    renderQueue();
    await window.api.reorderQueue(reordered.map((i) => i.id));
}

function getQueueStatusLabel(item: QueueItem): string {
    if (item.status === 'completed') return UI_TEXT.queue.statusDone;
    if (item.status === 'error') return UI_TEXT.queue.statusFailed;
    if (item.status === 'paused') return UI_TEXT.queue.statusPaused;
    if (item.status === 'downloading') return UI_TEXT.queue.statusRunning;
    return UI_TEXT.queue.statusWaiting;
}

function getQueueProgressText(item: QueueItem): string {
    if (item.status === 'completed') return '100%';
    if (item.status === 'error') return UI_TEXT.queue.progressError;
    if (item.status === 'paused') return UI_TEXT.queue.progressReady;
    if (item.status === 'pending') return UI_TEXT.queue.progressReady;
    if (item.progress > 0) return `${Math.max(0, Math.min(100, item.progress)).toFixed(1)}%`;
    return item.progressStatus || UI_TEXT.queue.progressLoading;
}

function getQueueMetaText(item: QueueItem): string {
    if (item.status === 'error' && item.last_error) {
        return item.last_error;
    }

    const parts: string[] = [];

    if (item.currentPart && item.totalParts) {
        parts.push(`${UI_TEXT.queue.part} ${item.currentPart}/${item.totalParts}`);
    }

    if (item.speed) {
        parts.push(`${UI_TEXT.queue.speed}: ${item.speed}`);
    }

    if (item.eta) {
        parts.push(`${UI_TEXT.queue.eta}: ${item.eta}`);
    }

    if (!parts.length && item.status === 'pending') {
        parts.push(UI_TEXT.queue.readyToDownload);
    }

    if (!parts.length && item.status === 'paused') {
        parts.push(UI_TEXT.queue.statusPaused);
    }

    if (!parts.length && item.status === 'downloading') {
        parts.push(item.progressStatus || UI_TEXT.queue.started);
    }

    if (!parts.length && item.status === 'completed') {
        parts.push(UI_TEXT.queue.done);
    }

    if (!parts.length && item.status === 'error') {
        parts.push(UI_TEXT.queue.failed);
    }

    return parts.join(' | ');
}

function toggleQueueSelection(id: string): void {
    const index = selectedQueueIds.indexOf(id);
    if (index >= 0) {
        selectedQueueIds.splice(index, 1);
    } else {
        selectedQueueIds.push(id);
    }
    renderQueue();
    updateMergeGroupButton();
}

function updateMergeGroupButton(): void {
    const btn = byId<HTMLButtonElement>('btnMergeGroup');
    if (!btn) return;

    // Clean up selections: only keep IDs that are still pending in queue
    const validIds = new Set(
        queue.filter(item => item.status === 'pending' && !item.mergeGroup).map(item => item.id)
    );
    selectedQueueIds = selectedQueueIds.filter(id => validIds.has(id));

    if (selectedQueueIds.length >= 2) {
        btn.classList.remove('is-hidden');
        btn.textContent = `${UI_TEXT.mergeGroup.btn} (${selectedQueueIds.length})`;
        btn.disabled = false;
    } else {
        btn.classList.add('is-hidden');
    }
}

async function createMergeGroupFromSelection(): Promise<void> {
    if (selectedQueueIds.length < 2) return;

    const ids = [...selectedQueueIds];
    selectedQueueIds = [];
    queue = await window.api.createMergeGroup(ids);
    renderQueue();
    updateMergeGroupButton();
}

function updateQueueItemProgress(progress: DownloadProgress): void {
    // Lookup by data-id attribute, not array index — survives queue mutation between renders
    const safeId = String(progress.id ?? '').replace(/"/g, '\\"');
    if (!safeId) return;
    const el = byId('queueList').querySelector(`[data-id="${safeId}"]`) as HTMLElement | null;
    if (!el) return;

    const item = queue.find(i => i.id === progress.id);
    if (!item) return;

    const bar = el.querySelector('.queue-progress-bar') as HTMLElement | null;
    const wrap = el.querySelector('.queue-progress-wrap') as HTMLElement | null;
    const text = el.querySelector('.queue-progress-text') as HTMLElement | null;
    const meta = el.querySelector('.queue-meta') as HTMLElement | null;

    if (bar) {
        const isDeterminate = progress.progress > 0 && progress.progress <= 100;
        const pct = isDeterminate ? Math.min(100, progress.progress) : 0;
        bar.style.width = `${pct}%`;
        bar.className = `queue-progress-bar${isDeterminate ? '' : ' indeterminate'}`;
        if (wrap) wrap.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    if (text) text.textContent = getQueueProgressText(item);
    if (meta) meta.textContent = getQueueMetaText(item);
}

function toggleQueueDetails(id: string): void {
    if (expandedQueueIds.has(id)) {
        expandedQueueIds.delete(id);
    } else {
        expandedQueueIds.add(id);
    }
    renderQueue();
}

function initQueueDragDrop(): void {
    if (queueDragDropInitialized) return;
    queueDragDropInitialized = true;

    const list = byId('queueList');

    list.addEventListener('dragstart', (e: DragEvent) => {
        const el = (e.target as HTMLElement).closest('.queue-item') as HTMLElement;
        if (!el) return;
        // Prevent dragging items that are no longer pending (race window between status change and re-render)
        const itemId = el.dataset.id;
        if (itemId) {
            const item = queue.find(i => i.id === itemId);
            if (!item || item.status !== 'pending') {
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'none';
                    e.dataTransfer.clearData();
                }
                return;
            }
        }
        draggedQueueItemId = el.dataset.id || null;
        el.classList.add('dragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    list.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    list.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        const target = (e.target as HTMLElement).closest('.queue-item') as HTMLElement;
        if (!target || !draggedQueueItemId) return;
        const targetId = target.dataset.id;
        if (!targetId || targetId === draggedQueueItemId) return;

        const fromIdx = queue.findIndex(i => i.id === draggedQueueItemId);
        const toIdx = queue.findIndex(i => i.id === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = queue.splice(fromIdx, 1);
        queue.splice(toIdx, 0, moved);
        window.api.reorderQueue(queue.map(i => i.id));
        renderQueue();
    });

    list.addEventListener('dragend', () => {
        draggedQueueItemId = null;
        document.querySelectorAll('.queue-item.dragging').forEach(el => el.classList.remove('dragging'));
    });
}

function renderQueue(): void {
    if (!Array.isArray(queue)) {
        queue = [];
    }

    const list = byId('queueList');
    byId('queueCount').textContent = String(queue.length);
    const retryBtn = byId<HTMLButtonElement>('btnRetryFailed');
    const hasFailed = queue.some((item) => item.status === 'error');
    retryBtn.disabled = !hasFailed;

    const renderFingerprint = getQueueRenderFingerprint(queue);
    if (renderFingerprint === lastQueueRenderFingerprint) {
        return;
    }

    if (queue.length === 0) {
        lastQueueRenderFingerprint = renderFingerprint;
        // Build the empty state via createElement to keep the renderer
        // clean of inline-style HTML strings (which the lint hook
        // flags as a potential XSS surface). The CSS for .queue-empty
        // lives in styles.css.
        list.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'queue-empty';
        empty.textContent = UI_TEXT.queue.empty;
        list.appendChild(empty);
        return;
    }

    list.innerHTML = queue.map((item: QueueItem) => {
        const safeTitle = escapeHtml(item.title || UI_TEXT.vods.untitled);
        const safeStatusLabel = escapeHtml(getQueueStatusLabel(item));
        const safeProgressText = escapeHtml(getQueueProgressText(item));
        const safeMeta = escapeHtml(getQueueMetaText(item));
        const isClip = item.customClip ? '* ' : '';
        const hasDeterminateProgress = item.progress > 0 && item.progress <= 100;
        const progressValue = item.status === 'completed'
            ? 100
            : (hasDeterminateProgress ? Math.max(0, Math.min(100, item.progress)) : 0);
        const progressClass = item.status === 'downloading' && !hasDeterminateProgress ? ' indeterminate' : '';

        const isMergeGroup = !!item.mergeGroup;
        const showSelector = item.status === 'pending' && !isMergeGroup && !item.isLive;
        const selectionIndex = selectedQueueIds.indexOf(item.id);
        const isSelected = selectionIndex >= 0;
        const mergeIcon = isMergeGroup
            ? '<svg class="merge-group-icon" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg> '
            : '';
        const liveBadge = item.isLive
            ? `<span class="queue-live-badge" title="${escapeHtml(UI_TEXT.queue.liveRecordingTitle)}">REC</span> `
            : '';
        const healthBadge = (item.isLive && item.status === 'downloading')
            ? renderRecordingHealthBadge(item.recordingHealth)
            : '';
        const mergeMetaExtra = isMergeGroup
            ? ` (${UI_TEXT.mergeGroup.metaLabel.replace('{count}', String(item.mergeGroup!.items.length))})`
            : '';

        return `
            <div class="queue-item${isMergeGroup ? ' merge-group' : ''}" draggable="${item.status === 'pending' ? 'true' : 'false'}" data-id="${item.id}">
                ${showSelector
                    ? `<div class="queue-selector${isSelected ? ' selected' : ''}" role="checkbox" tabindex="0" aria-checked="${isSelected ? 'true' : 'false'}" onclick="toggleQueueSelection('${item.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleQueueSelection('${item.id}');}">${isSelected ? selectionIndex + 1 : ''}</div>`
                    : ''
                }
                <div class="status ${item.status}"></div>
                <div class="queue-main">
                    <div class="queue-title-row">
                        <div class="title" title="${safeTitle}" role="button" tabindex="0" aria-expanded="${expandedQueueIds.has(item.id) ? 'true' : 'false'}" aria-controls="details-${item.id}" onclick="toggleQueueDetails('${item.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleQueueDetails('${item.id}');}">${liveBadge}${healthBadge}${mergeIcon}${isClip}${safeTitle}</div>
                        <div class="queue-status-label">${safeStatusLabel}</div>
                    </div>
                    <div class="queue-meta">${safeMeta}${mergeMetaExtra}</div>
                    <div class="queue-progress-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progressValue)}" aria-label="${escapeHtml(safeStatusLabel)}">
                        <div class="queue-progress-bar${progressClass}" style="width: ${progressValue}%;"></div>
                    </div>
                    <div class="queue-progress-text">${safeProgressText}</div>
                    <div class="queue-details${expandedQueueIds.has(item.id) ? ' expanded' : ''}" id="details-${item.id}">
                        <div><span class="queue-detail-label">URL:</span> ${escapeHtml(item.url)}</div>
                        <div><span class="queue-detail-label">${escapeHtml(UI_TEXT.queue.detailStreamer)}</span> ${escapeHtml(item.streamer)}</div>
                        <div><span class="queue-detail-label">${escapeHtml(UI_TEXT.queue.detailDuration)}</span> ${escapeHtml(item.duration_str)}</div>
                        <div><span class="queue-detail-label">${escapeHtml(UI_TEXT.queue.detailDate)}</span> ${escapeHtml(new Date(item.date).toLocaleString())}</div>
                        ${renderQueueItemFileActions(item)}
                    </div>
                </div>
                ${item.status === 'error' ? `<button class="queue-retry-btn" type="button" title="${escapeHtml(UI_TEXT.queue.retryItem)}" aria-label="${escapeHtml(UI_TEXT.queue.retryItem)}" onclick="retryQueueItem('${item.id}')">&#x21bb;</button>` : ''}
                <span class="remove" role="button" tabindex="0" aria-label="${escapeHtml(UI_TEXT.streamers.removeAria)}" onclick="removeFromQueue('${item.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();removeFromQueue('${item.id}');}">x</span>
            </div>
        `;
    }).join('');

    updateMergeGroupButton();
    initQueueContextMenu();
    lastQueueRenderFingerprint = renderFingerprint;
}

async function toggleDownload(): Promise<void> {
    if (downloading) {
        await window.api.pauseDownload();
        return;
    }

    const started = await window.api.startDownload();
    if (!started) {
        renderQueue();
        alert(UI_TEXT.queue.emptyAlert);
    }
}

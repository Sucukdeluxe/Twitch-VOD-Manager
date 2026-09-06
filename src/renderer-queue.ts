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
    const buttons: string[] = [];

    // "Open file" only makes sense when there's exactly one output (a clip /
    // full VOD download). For multi-part downloads "open the first part" is
    // surprising — the user almost always wants the folder.
    if (item.outputFiles.length === 1) {
        buttons.push(`<button type="button" class="queue-detail-btn" data-queue-file-action="open" data-queue-file-path="${escapeHtml(first)}">${escapeHtml(UI_TEXT.queue.openFile)}</button>`);
    }
    buttons.push(`<button type="button" class="queue-detail-btn" data-queue-file-action="folder" data-queue-file-path="${escapeHtml(first)}">${escapeHtml(UI_TEXT.queue.showInFolder)}</button>`);

    // Surface a "View chat" button when a sibling chat file exists in the
    // outputs list. Single click opens the in-app viewer modal.
    const chatFile = item.outputFiles.find((f) => /\.chat\.json(l)?$/i.test(f));
    if (chatFile) {
        buttons.push(`<button type="button" class="queue-detail-btn" data-queue-file-action="chat" data-queue-file-path="${escapeHtml(chatFile)}" data-queue-file-title="${escapeHtml(item.title || item.streamer || '')}">${escapeHtml(UI_TEXT.queue.viewChat)}</button>`);
    }

    // Same pattern for the .events.jsonl sidecar — title/game change timeline.
    const eventsFile = item.outputFiles.find((f) => /\.events\.jsonl$/i.test(f));
    if (eventsFile) {
        buttons.push(`<button type="button" class="queue-detail-btn" data-queue-file-action="events" data-queue-file-path="${escapeHtml(eventsFile)}" data-queue-file-title="${escapeHtml(item.title || item.streamer || '')}">${escapeHtml(UI_TEXT.queue.viewEvents)}</button>`);
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
    let ok: boolean;
    try {
        ok = await window.api.openFile(filePath);
    } catch {
        ok = false;
    }
    if (ok) return;
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast) toast(UI_TEXT.queue.openFileFailed, 'warn');
}

async function invokeShowInFolder(filePath: string): Promise<void> {
    let ok: boolean;
    try {
        ok = await window.api.showInFolder(filePath);
    } catch {
        ok = false;
    }
    if (ok) return;
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (toast) toast(UI_TEXT.queue.openFileFailed, 'warn');
}

async function invokeQueueFileAction(action: string, filePath: string, title = ''): Promise<void> {
    if (action === 'open') {
        await invokeOpenFile(filePath);
    } else if (action === 'folder') {
        await invokeShowInFolder(filePath);
    } else if (action === 'chat') {
        await openChatViewer(filePath, title);
    } else if (action === 'events') {
        await openEventsViewer(filePath, title);
    }
}

let queueActionsInitialized = false;

async function invokeQueueItemAction(action: string, id: string): Promise<void> {
    if (action === 'details') {
        toggleQueueDetails(id);
    } else if (action === 'remove') {
        await removeFromQueue(id);
    } else if (action === 'retry') {
        await retryQueueItem(id);
    }
}

async function invokeQueueActionSafely(action: () => void | Promise<void>): Promise<void> {
    try {
        await action();
    } catch {
        const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
        if (toast) toast(UI_TEXT.queue.failed, 'warn');
    }
}

async function activateQueueControl(control: HTMLElement): Promise<void> {
    await invokeQueueActionSafely(async () => {
        const fileAction = control.dataset.queueFileAction;
        const filePath = control.dataset.queueFilePath;
        if (fileAction && filePath) {
            await invokeQueueFileAction(fileAction, filePath, control.dataset.queueFileTitle || '');
            return;
        }

        const action = control.dataset.queueAction;
        const item = control.closest<HTMLElement>('.queue-item');
        const id = item?.dataset.id;
        if (!action || !id) return;
        await invokeQueueItemAction(action, id);
    });
}

function resolveQueueControl(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>('[data-queue-action], [data-queue-file-action]');
}

function initQueueActions(): void {
    if (queueActionsInitialized) return;
    queueActionsInitialized = true;
    const list = byId('queueList');
    list.addEventListener('click', (event: MouseEvent) => {
        const control = resolveQueueControl(event.target);
        if (!control || !list.contains(control)) return;
        void activateQueueControl(control);
    });
    list.addEventListener('dblclick', (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest('button, a, input, select, textarea, [role="button"], [data-queue-action], [data-queue-file-action]')) return;
        const item = event.target.closest<HTMLElement>('.queue-item');
        if (!item?.dataset.id || !list.contains(item)) return;
        event.preventDefault();
        toggleQueueDetails(item.dataset.id);
    });
    list.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const control = resolveQueueControl(event.target);
        if (!control || !list.contains(control)) return;
        event.preventDefault();
        control.click();
    });
}

async function copyQueueUrl(url: string): Promise<void> {
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    try {
        await navigator.clipboard.writeText(url);
        if (toast) toast(UI_TEXT.queue.ctxCopiedUrl, 'info');
    } catch {
        if (toast) toast(UI_TEXT.queue.ctxCopyFailed, 'warn');
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
        item.recordingHealth || '',
        item.last_error || '',
        item.mergeRecoveryBlocked ? 'blocked' : '',
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
let activeQueueContextMenuInvoker: HTMLElement | null = null;
let activeQueueContextMenuCleanup: ((restoreFocus?: boolean) => void) | null = null;

function closeQueueContextMenu(restoreFocus = false): void {
    const cleanup = activeQueueContextMenuCleanup;
    if (cleanup) {
        activeQueueContextMenuCleanup = null;
        cleanup(restoreFocus);
        return;
    }
    if (!activeQueueContextMenu) return;
    activeQueueContextMenu.remove();
    activeQueueContextMenu = null;
    const invoker = activeQueueContextMenuInvoker;
    activeQueueContextMenuInvoker = null;
    if (restoreFocus && invoker?.isConnected) invoker.focus();
}

function installQueueContextMenuDismissal(menu: HTMLElement, cleanupMenu: (restoreFocus: boolean) => void): (restoreFocus?: boolean) => void {
    let cleaned = false;
    let cleanup: (restoreFocus?: boolean) => void;
    const dismissOnClick = (event: MouseEvent) => {
        if (event.target instanceof Node && menu.contains(event.target)) return;
        cleanup();
    };
    const dismissOnScroll = () => cleanup();
    cleanup = (restoreFocus = false): void => {
        if (cleaned) return;
        cleaned = true;
        document.removeEventListener('mousedown', dismissOnClick, true);
        document.removeEventListener('scroll', dismissOnScroll, true);
        cleanupMenu(restoreFocus);
    };
    document.addEventListener('mousedown', dismissOnClick, true);
    document.addEventListener('scroll', dismissOnScroll, true);
    return cleanup;
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
        showQueueContextMenu(e.clientX, e.clientY, item, e.target as HTMLElement);
    });
    list.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
        const target = e.target as HTMLElement;
        const itemEl = target.closest('.queue-item') as HTMLElement | null;
        const id = itemEl?.dataset.id;
        const item = id ? queue.find((candidate) => candidate.id === id) : null;
        if (!item || !itemEl) return;
        e.preventDefault();
        const rect = itemEl.getBoundingClientRect();
        showQueueContextMenu(rect.left + 12, rect.top + 12, item, target);
    });
}

function showQueueContextMenu(x: number, y: number, item: QueueItem, invoker: HTMLElement | null): void {
    closeQueueContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    const makeItem = (label: string, onClick: () => void | Promise<void>, disabled = false): HTMLElement => {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = label;
        el.className = 'context-menu-item' + (disabled ? ' disabled' : '');
        el.setAttribute('role', 'menuitem');
        if (disabled) {
            el.setAttribute('aria-disabled', 'true');
            el.disabled = true;
        }
        if (!disabled) {
            el.addEventListener('click', () => {
                closeQueueContextMenu();
                void invokeQueueActionSafely(onClick);
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
    const isFailed = item.status === 'error' && !item.mergeRecoveryBlocked;
    const isCompleted = item.status === 'completed';
    const canSelectForMerge = item.status === 'pending' && !item.mergeGroup && !item.isLive;

    if (canSelectForMerge) {
        const isSelectedForMerge = selectedQueueIds.includes(item.id);
        const mergeSelectionItem = makeItem(
            isSelectedForMerge ? UI_TEXT.queue.ctxRemoveFromMerge : UI_TEXT.queue.ctxSelectForMerge,
            () => toggleQueueSelection(item.id)
        );
        mergeSelectionItem.dataset.queueAction = 'merge-select';
        menu.appendChild(mergeSelectionItem);
        menu.appendChild(makeSeparator());
    }

    if (isPending) {
        menu.appendChild(makeItem(UI_TEXT.queue.ctxMoveTop, () => moveQueueItemTo(item.id, 'top')));
        menu.appendChild(makeItem(UI_TEXT.queue.ctxMoveBottom, () => moveQueueItemTo(item.id, 'bottom')));
        menu.appendChild(makeSeparator());
    }

    if (isFailed) {
        menu.appendChild(makeItem(UI_TEXT.queue.retryItem, () => retryQueueItem(item.id)));
        menu.appendChild(makeSeparator());
    }

    if (isCompleted && item.outputFiles && item.outputFiles.length > 0) {
        const first = item.outputFiles[0];
        if (item.outputFiles.length === 1) {
            menu.appendChild(makeItem(UI_TEXT.queue.openFile, () => invokeOpenFile(first)));
        }
        menu.appendChild(makeItem(UI_TEXT.queue.showInFolder, () => invokeShowInFolder(first)));
        menu.appendChild(makeSeparator());
    }

    menu.appendChild(makeItem(UI_TEXT.queue.ctxCopyUrl, () => copyQueueUrl(item.url)));
    menu.appendChild(makeItem(UI_TEXT.queue.ctxOpenOnTwitch, () => window.api.openExternal(item.url)));
    menu.appendChild(makeSeparator());
    menu.appendChild(makeItem(UI_TEXT.queue.ctxRemove, () => removeFromQueue(item.id)));

    document.body.appendChild(menu);
    activeQueueContextMenu = menu;
    activeQueueContextMenuInvoker = invoker;

    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4);
    if (top + rect.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - rect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    let cleanup: (restoreFocus?: boolean) => void;
    cleanup = installQueueContextMenuDismissal(menu, (restoreFocus) => {
        if (activeQueueContextMenuCleanup === cleanup) activeQueueContextMenuCleanup = null;
        if (activeQueueContextMenu === menu) {
            activeQueueContextMenu = null;
            const currentInvoker = activeQueueContextMenuInvoker;
            activeQueueContextMenuInvoker = null;
            menu.remove();
            if (restoreFocus && currentInvoker?.isConnected) currentInvoker.focus();
            return;
        }
        menu.remove();
    });
    activeQueueContextMenuCleanup = cleanup;
    RendererAccessibility.installMenuKeyboardNavigation(menu, () => closeQueueContextMenu(true));
    RendererAccessibility.focusFirstMenuItem(menu);
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

function getQueueProgressStatusText(item: QueueItem): string {
    if (item.status === 'error' && item.last_error) {
        return item.last_error;
    }

    if (item.status === 'pending') return UI_TEXT.queue.readyToDownload;
    if (item.status === 'paused') return UI_TEXT.queue.statusPaused;
    if (item.status === 'completed') return UI_TEXT.queue.done;
    if (item.status === 'error') return UI_TEXT.queue.failed;
    if (item.status === 'downloading' && item.progressStatus) return item.progressStatus;
    if (item.currentPart && item.totalParts) {
        return `${UI_TEXT.queue.part} ${item.currentPart}/${item.totalParts}`;
    }
    if (item.status === 'downloading') return UI_TEXT.queue.started;
    return UI_TEXT.queue.failed;
}

function getQueueProgressMetricsText(item: QueueItem): string {
    const parts: string[] = [];
    if (item.status === 'completed') parts.push('100%');
    if ((item.status === 'downloading' || item.status === 'paused') && item.progress > 0) {
        parts.push(`${Math.max(0, Math.min(100, item.progress)).toFixed(1)}%`);
    }
    if (item.status === 'downloading' && item.speed) parts.push(item.speed);
    if (item.status === 'downloading' && item.eta) parts.push(item.eta);
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

function syncQueueRecordingHealth(el: HTMLElement, item: QueueItem): void {
    const current = el.querySelector<HTMLElement>('.queue-health-dot');
    const health = item.isLive && item.status === 'downloading' ? item.recordingHealth : undefined;
    if (!health) {
        current?.remove();
        return;
    }

    const labels = UI_TEXT.queue.recordingHealth || { ok: 'Healthy', stale: 'Stalled', unknown: 'Pending data' };
    const className = health === 'ok' ? 'health-ok' : (health === 'stale' ? 'health-stale' : 'health-unknown');
    const label = labels[health] || '';
    let badge = current;
    if (!badge) {
        const title = el.querySelector<HTMLElement>('.title');
        if (!title) return;
        badge = document.createElement('span');
        const liveBadge = title.querySelector<HTMLElement>('.queue-live-badge');
        if (liveBadge) liveBadge.insertAdjacentElement('afterend', badge);
        else title.prepend(badge);
    }
    badge.className = `queue-health-dot ${className}`;
    badge.title = label;
    badge.setAttribute('aria-label', label);
}

function updateQueueItemProgress(progress: DownloadProgress): void {
    const progressId = String(progress.id ?? '');
    if (!progressId) return;
    const list = byId<HTMLElement>('queueList');
    const el = Array.from(list.querySelectorAll<HTMLElement>('.queue-item'))
        .find((candidate) => candidate.dataset.id === progressId) || null;
    if (!el) return;

    const item = queue.find(i => String(i.id) === progressId);
    if (!item) return;

    const bar = el.querySelector('.queue-progress-bar') as HTMLElement | null;
    const wrap = el.querySelector('.queue-progress-wrap') as HTMLElement | null;
    const status = el.querySelector('.queue-progress-status') as HTMLElement | null;
    const metrics = el.querySelector('.queue-progress-metrics') as HTMLElement | null;

    if (bar) {
        const isDeterminate = item.progress > 0 && item.progress <= 100;
        const pct = isDeterminate ? Math.min(100, item.progress) : 0;
        bar.style.width = `${pct}%`;
        bar.className = 'queue-progress-bar';
        if (wrap) wrap.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    if (status) status.textContent = getQueueProgressStatusText(item);
    if (metrics) metrics.textContent = getQueueProgressMetricsText(item);
    syncQueueRecordingHealth(el, item);
}

function toggleQueueDetails(id: string): void {
    if (expandedQueueIds.has(id)) {
        expandedQueueIds.delete(id);
    } else {
        expandedQueueIds.add(id);
    }
    const item = Array.from(byId<HTMLElement>('queueList').querySelectorAll<HTMLElement>('.queue-item'))
        .find((candidate) => candidate.dataset.id === id);
    const details = item?.querySelector<HTMLElement>('.queue-details');
    if (details) {
        details.classList.toggle('expanded', expandedQueueIds.has(id));
        details.inert = !expandedQueueIds.has(id);
    }
    item?.querySelector('[data-queue-action="details"]')?.setAttribute('aria-expanded', String(expandedQueueIds.has(id)));
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
    initQueueActions();
    byId('queueCount').textContent = formatUiNumber(queue.length);
    const retryBtn = byId<HTMLButtonElement>('btnRetryFailed');
    const clearBtn = byId<HTMLButtonElement>('btnClear');
    const hasFailed = queue.some((item) => item.status === 'error' && !item.mergeRecoveryBlocked);
    const hasCompleted = queue.some((item) => item.status === 'completed');
    retryBtn.disabled = !hasFailed;
    clearBtn.disabled = !hasCompleted;
    updateDownloadButtonState();

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

    list.innerHTML = queue.map((item: QueueItem, itemIndex: number) => {
        const safeTitle = escapeHtml(item.title || UI_TEXT.vods.untitled);
        const safeStatusLabel = escapeHtml(getQueueStatusLabel(item));
        const safeProgressStatus = escapeHtml(getQueueProgressStatusText(item));
        const safeProgressMetrics = escapeHtml(getQueueProgressMetricsText(item));
        const safeDate = escapeHtml(formatUiDate(item.date));
        const progressStatusClass = item.status === 'downloading' && item.progress <= 0 ? ' is-starting' : '';
        const isClip = item.customClip ? '* ' : '';
        const hasDeterminateProgress = item.progress > 0 && item.progress <= 100;
        const progressValue = item.status === 'completed'
            ? 100
            : (hasDeterminateProgress ? Math.max(0, Math.min(100, item.progress)) : 0);

        const isMergeGroup = !!item.mergeGroup;
        const selectionIndex = selectedQueueIds.indexOf(item.id);
        const isSelected = selectionIndex >= 0;
        const selectionPosition = selectionIndex + 1;
        const selectionTitle = escapeHtml(UI_TEXT.queue.mergeSelectionPosition.replace('{position}', String(selectionPosition)));
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
            ? escapeHtml(UI_TEXT.mergeGroup.metaLabel.replace('{count}', formatUiNumber(item.mergeGroup!.items.length)))
            : '';
        const detailsId = `queue-details-${itemIndex}`;

        return `
            <div class="queue-item${isMergeGroup ? ' merge-group' : ''}${isSelected ? ' merge-selected' : ''}" draggable="${item.status === 'pending' ? 'true' : 'false'}" data-id="${escapeHtml(item.id)}">
                ${isSelected ? `<span class="queue-selection-order" title="${selectionTitle}" aria-label="${selectionTitle}">${selectionPosition}</span>` : ''}
                <div class="queue-main">
                    <div class="queue-title-row">
                        <div class="title" title="${safeTitle}">${liveBadge}${healthBadge}${mergeIcon}${isClip}${safeTitle}</div>
                        ${item.status === 'error' && !item.mergeRecoveryBlocked ? `<button class="queue-retry-btn" type="button" title="${escapeHtml(UI_TEXT.queue.retryItem)}" aria-label="${escapeHtml(UI_TEXT.queue.retryItem)}" data-queue-action="retry">&#x21bb;</button>` : ''}
                        <button class="remove" type="button" title="${escapeHtml(UI_TEXT.queue.removeItem)}" aria-label="${escapeHtml(UI_TEXT.queue.removeItem)}" data-queue-action="remove"><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg></button>
                    </div>
                    ${mergeMetaExtra ? `<div class="queue-meta">${mergeMetaExtra}</div>` : ''}
                    <div class="queue-progress-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progressValue)}" aria-label="${escapeHtml(safeStatusLabel)}">
                        <div class="queue-progress-bar" style="width: ${progressValue}%;"></div>
                    </div>
                    <div class="queue-footer">
                        <div class="queue-summary">
                            <button class="queue-details-toggle" type="button" aria-label="${escapeHtml(UI_TEXT.queue.toggleDetails)}" title="${escapeHtml(UI_TEXT.queue.toggleDetails)}" aria-expanded="${expandedQueueIds.has(item.id) ? 'true' : 'false'}" aria-controls="${detailsId}" data-queue-action="details"><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg></button>
                            <span class="queue-status-badge" title="${safeProgressStatus}"><span class="status ${item.status}" aria-hidden="true"></span><span class="queue-status-label">${safeStatusLabel}</span></span>
                        </div>
                        <span class="queue-date">${safeDate}</span>
                    </div>
                    <div class="queue-progress-info${item.status === 'pending' || item.status === 'completed' ? ' is-hidden' : ''}">
                        <span class="queue-progress-status${progressStatusClass}${item.status === 'paused' ? ' is-hidden' : ''}">${safeProgressStatus}</span>
                        <span class="queue-progress-metrics">${safeProgressMetrics}</span>
                    </div>
                    <div class="queue-details${expandedQueueIds.has(item.id) ? ' expanded' : ''}" id="${detailsId}"${expandedQueueIds.has(item.id) ? '' : ' inert'}>
                        <div class="queue-details-clip"><div class="queue-details-content">
                        <div><span class="queue-detail-label">URL:</span> ${escapeHtml(item.url)}</div>
                        <div><span class="queue-detail-label">${escapeHtml(UI_TEXT.queue.detailStreamer)}</span> ${escapeHtml(item.streamer)}</div>
                        <div><span class="queue-detail-label">${escapeHtml(UI_TEXT.queue.detailDuration)}</span> ${escapeHtml(item.duration_str)}</div>
                        <div><span class="queue-detail-label">${escapeHtml(UI_TEXT.queue.detailDate)}</span> ${escapeHtml(formatUiDateTime(item.date))}</div>
                        ${renderQueueItemFileActions(item)}
                        </div></div>
                    </div>
                </div>
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

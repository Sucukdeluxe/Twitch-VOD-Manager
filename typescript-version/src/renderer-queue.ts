async function addToQueue(url: string, title: string, date: string, streamer: string, duration: string): Promise<void> {
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

function renderQueue(): void {
    if (!Array.isArray(queue)) {
        queue = [];
    }

    const list = byId('queueList');
    byId('queueCount').textContent = String(queue.length);
    const retryBtn = byId<HTMLButtonElement>('btnRetryFailed');
    const hasFailed = queue.some((item) => item.status === 'error');
    retryBtn.disabled = !hasFailed;

    if (queue.length === 0) {
        list.innerHTML = `<div style="color: var(--text-secondary); font-size: 12px; text-align: center; padding: 15px;">${UI_TEXT.queue.empty}</div>`;
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

        return `
            <div class="queue-item">
                <div class="status ${item.status}"></div>
                <div class="queue-main">
                    <div class="queue-title-row">
                        <div class="title" title="${safeTitle}">${isClip}${safeTitle}</div>
                        <div class="queue-status-label">${safeStatusLabel}</div>
                    </div>
                    <div class="queue-meta">${safeMeta}</div>
                    <div class="queue-progress-wrap">
                        <div class="queue-progress-bar${progressClass}" style="width: ${progressValue}%;"></div>
                    </div>
                    <div class="queue-progress-text">${safeProgressText}</div>
                </div>
                <span class="remove" onclick="removeFromQueue('${item.id}')">x</span>
            </div>
        `;
    }).join('');
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

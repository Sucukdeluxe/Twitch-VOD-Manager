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

function getQueueStatusLabel(item: QueueItem): string {
    if (item.status === 'completed') return 'Abgeschlossen';
    if (item.status === 'error') return 'Fehlgeschlagen';
    if (item.status === 'downloading') return 'Lauft';
    return 'Wartet';
}

function getQueueProgressText(item: QueueItem): string {
    if (item.status === 'completed') return '100%';
    if (item.status === 'error') return 'Fehler';
    if (item.status === 'pending') return 'Bereit';
    if (item.progress > 0) return `${Math.max(0, Math.min(100, item.progress)).toFixed(1)}%`;
    return item.progressStatus || 'Lade...';
}

function getQueueMetaText(item: QueueItem): string {
    if (item.status === 'error' && item.last_error) {
        return item.last_error;
    }

    const parts: string[] = [];

    if (item.currentPart && item.totalParts) {
        parts.push(`Teil ${item.currentPart}/${item.totalParts}`);
    }

    if (item.speed) {
        parts.push(`Geschwindigkeit: ${item.speed}`);
    }

    if (item.eta) {
        parts.push(`Restzeit: ${item.eta}`);
    }

    if (!parts.length && item.status === 'pending') {
        parts.push('Bereit zum Download');
    }

    if (!parts.length && item.status === 'downloading') {
        parts.push(item.progressStatus || 'Download gestartet');
    }

    if (!parts.length && item.status === 'completed') {
        parts.push('Fertig');
    }

    if (!parts.length && item.status === 'error') {
        parts.push('Download fehlgeschlagen');
    }

    return parts.join(' | ');
}

function renderQueue(): void {
    if (!Array.isArray(queue)) {
        queue = [];
    }

    const list = byId('queueList');
    byId('queueCount').textContent = String(queue.length);

    if (queue.length === 0) {
        list.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px; text-align: center; padding: 15px;">Keine Downloads in der Warteschlange</div>';
        return;
    }

    list.innerHTML = queue.map((item: QueueItem) => {
        const safeTitle = escapeHtml(item.title || 'Untitled');
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
        await window.api.cancelDownload();
        return;
    }

    const started = await window.api.startDownload();
    if (!started) {
        renderQueue();
        alert('Die Warteschlange ist leer. Fuge zuerst ein VOD oder einen Clip hinzu.');
    }
}

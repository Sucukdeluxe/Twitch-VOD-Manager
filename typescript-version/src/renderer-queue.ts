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

function renderQueue(): void {
    const list = byId('queueList');
    byId('queueCount').textContent = queue.length;

    if (queue.length === 0) {
        list.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px; text-align: center; padding: 15px;">Keine Downloads in der Warteschlange</div>';
        return;
    }

    list.innerHTML = queue.map((item: QueueItem) => {
        const isClip = item.customClip ? '* ' : '';
        return `
            <div class="queue-item">
                <div class="status ${item.status}"></div>
                <div class="title" title="${item.title}">${isClip}${item.title}</div>
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

    await window.api.startDownload();
}

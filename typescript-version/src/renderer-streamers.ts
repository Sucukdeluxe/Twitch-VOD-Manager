function renderStreamers(): void {
    const list = byId('streamerList');
    list.innerHTML = '';

    (config.streamers ?? []).forEach((streamer: string) => {
        const item = document.createElement('div');
        item.className = 'streamer-item' + (currentStreamer === streamer ? ' active' : '');
        item.innerHTML = `
            <span>${streamer}</span>
            <span class="remove" onclick="event.stopPropagation(); removeStreamer('${streamer}')">x</span>
        `;
        item.onclick = () => {
            void selectStreamer(streamer);
        };
        list.appendChild(item);
    });
}

async function addStreamer(): Promise<void> {
    const input = byId<HTMLInputElement>('newStreamer');
    const name = input.value.trim().toLowerCase();
    if (!name || (config.streamers ?? []).includes(name)) {
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
    byId('vodGrid').innerHTML = `
        <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-4 5-4v8zm2-8l5 4-5 4V9z"/></svg>
            <h3>Keine VODs</h3>
            <p>Wahle einen Streamer aus der Liste.</p>
        </div>
    `;
}

async function selectStreamer(name: string): Promise<void> {
    currentStreamer = name;
    renderStreamers();
    byId('pageTitle').textContent = name;

    if (!isConnected) {
        await connect();
    }

    if (!isConnected) {
        updateStatus('Ohne Login (Public Modus)', false);
    }

    byId('vodGrid').innerHTML = '<div class="empty-state"><p>Lade VODs...</p></div>';

    const userId = await window.api.getUserId(name);
    if (!userId) {
        byId('vodGrid').innerHTML = '<div class="empty-state"><h3>Streamer nicht gefunden</h3></div>';
        return;
    }

    const vods = await window.api.getVODs(userId);
    renderVODs(vods, name);
}

function renderVODs(vods: VOD[] | null | undefined, streamer: string): void {
    const grid = byId('vodGrid');

    if (!vods || vods.length === 0) {
        grid.innerHTML = '<div class="empty-state"><h3>Keine VODs gefunden</h3><p>Dieser Streamer hat keine VODs.</p></div>';
        return;
    }

    grid.innerHTML = vods.map((vod: VOD) => {
        const thumb = vod.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180');
        const date = new Date(vod.created_at).toLocaleDateString('de-DE');
        const escapedTitle = vod.title.replace(/'/g, "\\'").replace(/\"/g, '&quot;');
        const safeDisplayTitle = escapeHtml(vod.title || 'Unbenanntes VOD');

        return `
            <div class="vod-card">
                <img class="vod-thumbnail" src="${thumb}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 320 180%22><rect fill=%22%23333%22 width=%22320%22 height=%22180%22/></svg>'">
                <div class="vod-info">
                    <div class="vod-title">${safeDisplayTitle}</div>
                    <div class="vod-meta">
                        <span>${date}</span>
                        <span>${vod.duration}</span>
                        <span>${vod.view_count.toLocaleString()} Aufrufe</span>
                    </div>
                </div>
                <div class="vod-actions">
                    <button class="vod-btn secondary" onclick="openClipDialog('${vod.url}', '${escapedTitle}', '${vod.created_at}', '${streamer}', '${vod.duration}')">Clip</button>
                    <button class="vod-btn primary" onclick="addToQueue('${vod.url}', '${escapedTitle}', '${vod.created_at}', '${streamer}', '${vod.duration}')">+ Warteschlange</button>
                </div>
            </div>
        `;
    }).join('');
}

async function refreshVODs(): Promise<void> {
    if (!currentStreamer) {
        return;
    }

    await selectStreamer(currentStreamer);
}

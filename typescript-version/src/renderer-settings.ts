async function connect(): Promise<void> {
    const hasCredentials = Boolean((config.client_id ?? '').toString().trim() && (config.client_secret ?? '').toString().trim());
    if (!hasCredentials) {
        isConnected = false;
        updateStatus(UI_TEXT.status.noLogin, false);
        return;
    }

    updateStatus(UI_TEXT.status.connecting, false);
    const success = await window.api.login();
    isConnected = success;
    updateStatus(success ? UI_TEXT.status.connected : UI_TEXT.status.connectFailedPublic, success);
}

function updateStatus(text: string, connected: boolean): void {
    byId('statusText').textContent = text;
    const dot = byId('statusDot');
    dot.classList.remove('connected', 'error');
    dot.classList.add(connected ? 'connected' : 'error');
}

function changeLanguage(lang: string): void {
    const normalized = setLanguage(lang);
    byId<HTMLSelectElement>('languageSelect').value = normalized;
    config.language = normalized;
    void window.api.saveConfig({ language: normalized });

    const currentStatus = byId('statusText').textContent?.trim() || '';
    updateStatus(localizeCurrentStatusText(currentStatus), isConnected);

    renderQueue();
    renderStreamers();

    const activeTabId = document.querySelector('.tab-content.active')?.id || 'vodsTab';
    const activeTab = activeTabId.replace('Tab', '');
    if (activeTab === 'vods' && currentStreamer) {
        byId('pageTitle').textContent = currentStreamer;
    } else {
        byId('pageTitle').textContent = (UI_TEXT.tabs as Record<string, string>)[activeTab] || UI_TEXT.appName;
    }
}

function renderPreflightResult(result: PreflightResult): void {
    const entries = [
        ['Internet', result.checks.internet],
        ['Streamlink', result.checks.streamlink],
        ['FFmpeg', result.checks.ffmpeg],
        ['FFprobe', result.checks.ffprobe],
        ['Download-Pfad', result.checks.downloadPathWritable]
    ];

    const lines = entries.map(([name, ok]) => `${ok ? 'OK' : 'FAIL'} ${name}`).join('\n');
    const extra = result.messages.length ? `\n\n${result.messages.join('\n')}` : '\n\nAlles bereit.';

    byId('preflightResult').textContent = `${lines}${extra}`;
}

async function runPreflight(autoFix = false): Promise<void> {
    const btn = byId<HTMLButtonElement>(autoFix ? 'btnPreflightFix' : 'btnPreflightRun');
    const old = btn.textContent || '';
    btn.disabled = true;
    btn.textContent = autoFix ? 'Fixe...' : 'Prufe...';

    try {
        const result = await window.api.runPreflight(autoFix);
        renderPreflightResult(result);
    } finally {
        btn.disabled = false;
        btn.textContent = old;
    }
}

async function refreshDebugLog(): Promise<void> {
    const text = await window.api.getDebugLog(250);
    const panel = byId('debugLogOutput');
    panel.textContent = text;
    panel.scrollTop = panel.scrollHeight;
}

function toggleDebugAutoRefresh(enabled: boolean): void {
    if (debugLogAutoRefreshTimer) {
        clearInterval(debugLogAutoRefreshTimer);
        debugLogAutoRefreshTimer = null;
    }

    if (enabled) {
        debugLogAutoRefreshTimer = window.setInterval(() => {
            void refreshDebugLog();
        }, 1500);
    }
}

async function saveSettings(): Promise<void> {
    const clientId = byId<HTMLInputElement>('clientId').value.trim();
    const clientSecret = byId<HTMLInputElement>('clientSecret').value.trim();
    const downloadPath = byId<HTMLInputElement>('downloadPath').value;
    const downloadMode = byId<HTMLSelectElement>('downloadMode').value as 'parts' | 'full';
    const partMinutes = parseInt(byId<HTMLInputElement>('partMinutes').value, 10) || 120;

    config = await window.api.saveConfig({
        client_id: clientId,
        client_secret: clientSecret,
        download_path: downloadPath,
        download_mode: downloadMode,
        part_minutes: partMinutes
    });

    await connect();
}

async function selectFolder(): Promise<void> {
    const folder = await window.api.selectFolder();
    if (!folder) {
        return;
    }

    byId<HTMLInputElement>('downloadPath').value = folder;
    config = await window.api.saveConfig({ download_path: folder });
}

function openFolder(): void {
    const folder = config.download_path;
    if (!folder || typeof folder !== 'string') {
        return;
    }

    void window.api.openFolder(folder);
}

function changeTheme(theme: string): void {
    document.body.className = `theme-${theme}`;
    void window.api.saveConfig({ theme });
}

async function connect(): Promise<void> {
    const hasCredentials = Boolean((config.client_id ?? '').toString().trim() && (config.client_secret ?? '').toString().trim());
    if (!hasCredentials) {
        isConnected = false;
        updateStatus('Ohne Login (Public Modus)', false);
        return;
    }

    updateStatus('Verbinde...', false);
    const success = await window.api.login();
    isConnected = success;
    updateStatus(success ? 'Verbunden' : 'Verbindung fehlgeschlagen - Public Modus aktiv', success);
}

function updateStatus(text: string, connected: boolean): void {
    byId('statusText').textContent = text;
    const dot = byId('statusDot');
    dot.classList.remove('connected', 'error');
    dot.classList.add(connected ? 'connected' : 'error');
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

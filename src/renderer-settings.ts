let lastRuntimeMetricsOutput = '';
let lastDebugLogOutput = '';
let settingsAutoSaveBound = false;
let settingsAutoSaveInFlight = false;
let pendingSettingsAutoSave = false;
let settingsAutoSaveTimer: number | null = null;
let pendingCredentialsReconnect = false;
let lastPersistedSettingsFingerprint = '';
let settingsInputGeneration = 0;
let lastPreflightResult: PreflightResult | null = null;
let preflightGeneration = 0;
const SECRET_INPUT_MASK = '••••••••';
let secretStatus: SecretStatus = {
    encryptionAvailable: false,
    clientSecretConfigured: false,
    discordWebhookConfigured: false
};
type SecretInputId = 'clientSecret' | 'discordWebhookUrl';
const secretInputGenerations: Record<SecretInputId, number> = {
    clientSecret: 0,
    discordWebhookUrl: 0
};

function canRunSettingsAutoRefresh(): boolean {
    if (document.hidden) {
        return false;
    }

    return document.querySelector('.tab-content.active')?.id === 'settingsTab';
}

function markSettingsInputChanged(): void {
    settingsInputGeneration += 1;
}

async function connect(): Promise<void> {
    const hasCredentials = Boolean((config.client_id ?? '').toString().trim() && secretStatus.clientSecretConfigured);
    if (!hasCredentials) {
        isConnected = false;
        updateStatus(UI_TEXT.status.noLogin, false, 'public');
        return;
    }

    updateStatus(UI_TEXT.status.connecting, false, 'pending');
    const success = await window.api.login();
    isConnected = success;
    updateStatus(success ? UI_TEXT.status.connected : UI_TEXT.status.connectFailedPublic, success, success ? 'connected' : 'public');
}

function formatBytesForMetrics(bytes: number): string {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value.toFixed(0)} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function validateFilenameTemplates(showAlert = false): boolean {
    const templates = [
        byId<HTMLInputElement>('vodFilenameTemplate').value.trim(),
        byId<HTMLInputElement>('partsFilenameTemplate').value.trim(),
        byId<HTMLInputElement>('defaultClipFilenameTemplate').value.trim()
    ];

    const unknown = templates.flatMap((template) => collectUnknownTemplatePlaceholders(template));
    const uniqueUnknown = Array.from(new Set(unknown));
    const lintNode = byId('filenameTemplateLint');

    if (!uniqueUnknown.length) {
        lintNode.className = 'template-lint ok';
        lintNode.textContent = UI_TEXT.static.templateLintOk;
        return true;
    }

    lintNode.className = 'template-lint warn';
    lintNode.textContent = `${UI_TEXT.static.templateLintWarn}: ${uniqueUnknown.join(' ')}`;

    if (showAlert) {
        alert(`${UI_TEXT.static.templateLintWarn}: ${uniqueUnknown.join(' ')}`);
    }

    return false;
}

function applyTemplatePreset(preset: string): void {
    const presets: Record<string, { vod: string; parts: string; clip: string }> = {
        default: {
            vod: '{title}.mp4',
            parts: '{date}_Part{part_padded}.mp4',
            clip: '{date}_{part}.mp4'
        },
        archive: {
            vod: '{channel}_{date_custom="yyyy-MM-dd"}_{title}.mp4',
            parts: '{channel}_{date_custom="yyyy-MM-dd"}_Part{part_padded}.mp4',
            clip: '{channel}_{date_custom="yyyy-MM-dd"}_{trim_start}_{part}.mp4'
        },
        clipper: {
            vod: '{date_custom="yyyy-MM-dd"}_{title}.mp4',
            parts: '{date_custom="yyyy-MM-dd"}_{part_padded}_{trim_start}.mp4',
            clip: '{title}_{trim_start_custom="HH-mm-ss"}_{part}.mp4'
        }
    };

    const selected = presets[preset] || presets.default;
    byId<HTMLInputElement>('vodFilenameTemplate').value = selected.vod;
    byId<HTMLInputElement>('partsFilenameTemplate').value = selected.parts;
    byId<HTMLInputElement>('defaultClipFilenameTemplate').value = selected.clip;
    validateFilenameTemplates();
    markSettingsInputChanged();
    // Programmatic .value = ... does not trigger the 'input' event the
    // template inputs listen on for debounced save, so the preset click
    // would otherwise look applied but never persist until the user
    // types into one of the inputs. Schedule the save explicitly.
    scheduleSettingsAutoSave();
}

async function refreshRuntimeMetrics(showLoading = true): Promise<void> {
    const output = byId('runtimeMetricsOutput');
    if (showLoading) {
        output.textContent = UI_TEXT.static.runtimeMetricsLoading;
    }

    try {
        const metrics = await window.api.getRuntimeMetrics();
        const lines = [
            `${UI_TEXT.static.runtimeMetricQueue}: ${metrics.queue.total} total (${metrics.queue.pending} pending, ${metrics.queue.downloading} downloading, ${metrics.queue.error} failed)`,
            `${UI_TEXT.static.runtimeMetricMode}: ${metrics.config.performanceMode} | smartScheduler=${metrics.config.smartScheduler} | dedupe=${metrics.config.duplicatePrevention}`,
            `${UI_TEXT.static.runtimeMetricRetries}: ${metrics.retriesScheduled} scheduled, ${metrics.retriesExhausted} exhausted`,
            `${UI_TEXT.static.runtimeMetricIntegrity}: ${metrics.integrityFailures}`,
            `${UI_TEXT.static.runtimeMetricCache}: hits=${metrics.cacheHits}, misses=${metrics.cacheMisses}, vod=${metrics.caches.vodList}, users=${metrics.caches.loginToUserId}, clips=${metrics.caches.clipInfo}`,
            `${UI_TEXT.static.runtimeMetricBandwidth}: current=${formatBytesForMetrics(metrics.lastSpeedBytesPerSec)}/s, avg=${formatBytesForMetrics(metrics.avgSpeedBytesPerSec)}/s`,
            `${UI_TEXT.static.runtimeMetricDownloads}: started=${metrics.downloadsStarted}, done=${metrics.downloadsCompleted}, failed=${metrics.downloadsFailed}, bytes=${formatBytesForMetrics(metrics.downloadedBytesTotal)}`,
            `${UI_TEXT.static.runtimeMetricActive}: ${metrics.activeItemTitle || '-'} (${metrics.activeItemId || '-'})`,
            `${UI_TEXT.static.runtimeMetricLastError}: ${metrics.lastErrorClass || '-'}, retryDelay=${metrics.lastRetryDelaySeconds}s`,
            `${UI_TEXT.static.runtimeMetricUpdated}: ${new Date(metrics.timestamp).toLocaleString(currentLanguage === 'en' ? 'en-US' : 'de-DE')}`
        ];

        const nextOutput = lines.join('\n');
        if (nextOutput !== lastRuntimeMetricsOutput) {
            output.textContent = nextOutput;
            lastRuntimeMetricsOutput = nextOutput;
        }
    } catch {
        if (lastRuntimeMetricsOutput !== UI_TEXT.static.runtimeMetricsError) {
            output.textContent = UI_TEXT.static.runtimeMetricsError;
            lastRuntimeMetricsOutput = UI_TEXT.static.runtimeMetricsError;
        }
    }
}

async function exportRuntimeMetrics(): Promise<void> {
    const result = await window.api.exportRuntimeMetrics();

    const toast = (window as unknown as { showAppToast?: (message: string, type?: 'info' | 'warn') => void }).showAppToast;
    const notify = (message: string, type: 'info' | 'warn' = 'info') => {
        if (typeof toast === 'function') {
            toast(message, type);
        } else if (type === 'warn') {
            alert(message);
        }
    };

    if (result.success) {
        notify(UI_TEXT.static.runtimeMetricsExportDone, 'info');
        return;
    }

    if (result.cancelled) {
        notify(UI_TEXT.static.runtimeMetricsExportCancelled, 'info');
        return;
    }

    notify(`${UI_TEXT.static.runtimeMetricsExportFailed}${result.error ? `\n${result.error}` : ''}`, 'warn');
}

function toggleRuntimeMetricsAutoRefresh(enabled: boolean): void {
    if (runtimeMetricsAutoRefreshTimer) {
        clearInterval(runtimeMetricsAutoRefreshTimer);
        runtimeMetricsAutoRefreshTimer = null;
    }

    if (enabled) {
        runtimeMetricsAutoRefreshTimer = window.setInterval(() => {
            if (!canRunSettingsAutoRefresh()) {
                return;
            }

            void refreshRuntimeMetrics(false);
            void refreshAutomationStatusLine();
        }, 2000);
    }
}

type ConnectionStatusTone = 'connected' | 'public' | 'pending';

function updateStatus(text: string, connected: boolean, tone: ConnectionStatusTone = connected ? 'connected' : 'public'): void {
    const statusText = byId('statusText');
    statusText.textContent = text;
    statusText.title = tone === 'connected'
        ? UI_TEXT.status.connectedHint
        : tone === 'public'
            ? UI_TEXT.status.publicHint
            : '';
    const dot = byId('statusDot');
    dot.classList.remove('connected', 'error', 'public');
    if (tone === 'connected') dot.classList.add('connected');
    if (tone === 'public') dot.classList.add('public');
}

function filterSettings(query: string): void {
    const normalizedQuery = query.trim().toLocaleLowerCase(getIntlLocale());
    if (!normalizedQuery) return;
    const match = Array.from(document.querySelectorAll<HTMLElement>('#settingsTab .settings-card[data-settings-pane]')).find((card) => {
        const searchableText = (card.textContent || '').toLocaleLowerCase(getIntlLocale());
        return searchableText.includes(normalizedQuery);
    });
    const pane = match?.dataset.settingsPane;
    if (pane) setSettingsPane(pane);
}

function setSettingsPane(pane: string, source?: HTMLElement): void {
    const tab = byId<HTMLElement>('settingsTab');
    const cards = Array.from(tab.querySelectorAll<HTMLElement>('.settings-card[data-settings-pane]'));
    const targetCard = cards.find((card) => card.dataset.settingsPane === pane);
    if (!targetCard) return;

    tab.dataset.settingsPane = pane;
    cards.forEach((card) => {
        card.hidden = card !== targetCard;
    });

    const panel = document.querySelector<HTMLElement>('[data-context-for="settings"]');
    const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>('.context-link[data-settings-pane]') || []);
    const targetButton = source || buttons.find((button) => button.dataset.settingsPane === pane);
    buttons.forEach((button) => {
        const active = button === targetButton;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });

    if (source) byId<HTMLInputElement>('settingsSearchInput').value = '';
    tab.scrollTop = 0;
    const list = panel?.querySelector<HTMLElement>('.context-list');
    if (list) scheduleSegmentedIndicatorSync(list);
}

function changeLanguage(lang: string): void {
    const normalized = setLanguage(lang);
    byId<HTMLSelectElement>('languageSelect').value = normalized;
    updateLanguagePicker(normalized);
    config.language = normalized;
    void window.api.saveConfig({ language: normalized });

    const currentStatus = byId('statusText').textContent?.trim() || '';
    const statusTone: ConnectionStatusTone = isConnected
        ? 'connected'
        : byId('statusDot').classList.contains('public')
            ? 'public'
            : 'pending';
    updateStatus(localizeCurrentStatusText(currentStatus), isConnected, statusTone);

    renderQueue();
    renderStreamers();
    // Re-render the VOD grid so the dynamically built button labels
    // (trim / queue) and the filter empty-state pick up the new locale.
    renderVodGridFromCurrentState();
    refreshVodSortSelectLabels();

    const activeTabId = document.querySelector('.tab-content.active')?.id || 'vodsTab';
    const activeTab = activeTabId.replace('Tab', '');
    const titleText = (activeTab === 'vods' && currentStreamer)
        ? currentStreamer
        : ((UI_TEXT.tabs as Record<string, string>)[activeTab] || UI_TEXT.appName);
    const setTitle = (window as unknown as { setPageTitle?: (text: string) => void }).setPageTitle;
    if (typeof setTitle === 'function') setTitle(titleText);
    else byId('pageTitle').textContent = titleText;

    void refreshRuntimeMetrics();
    void refreshAutomationStatusLine();
    refreshLocalizedPreflightUi();
    validateFilenameTemplates();
    filterSettings(byId<HTMLInputElement>('settingsSearchInput').value);
}

function updateLanguagePicker(lang: string): void {
    const de = byId<HTMLButtonElement>('langOptionDe');
    const en = byId<HTMLButtonElement>('langOptionEn');

    const isDe = lang === 'de';
    de.classList.toggle('active', isDe);
    en.classList.toggle('active', !isDe);
    de.setAttribute('aria-pressed', String(isDe));
    en.setAttribute('aria-pressed', String(!isDe));
    scheduleSegmentedIndicatorSync(byId<HTMLElement>('languagePicker'));
}

function selectLanguageOption(lang: string): void {
    changeLanguage(lang);
}

function renderPreflightButtonLabels(): void {
    const runButton = byId<HTMLButtonElement>('btnPreflightRun');
    const fixButton = byId<HTMLButtonElement>('btnPreflightFix');
    runButton.textContent = runButton.disabled ? UI_TEXT.static.preflightChecking : UI_TEXT.static.preflightRun;
    fixButton.textContent = fixButton.disabled ? UI_TEXT.static.preflightFixing : UI_TEXT.static.preflightFix;
}

function refreshLocalizedPreflightUi(): void {
    renderPreflightButtonLabels();
    if (lastPreflightResult) renderPreflightResult(lastPreflightResult);
}

function invalidatePreflightResult(): void {
    preflightGeneration += 1;
    lastPreflightResult = null;
    byId('preflightResult').textContent = UI_TEXT.static.preflightEmpty;
    const badge = byId('healthBadge');
    badge.classList.remove('good', 'warn', 'bad', 'unknown');
    badge.classList.add('unknown');
    badge.textContent = UI_TEXT.static.healthUnknown;
}

function renderPreflightResult(result: PreflightResult): void {
    lastPreflightResult = result;
    const entries: Array<[string, boolean, string]> = [
        [UI_TEXT.static.preflightInternet, result.checks.internet, UI_TEXT.static.preflightNoInternet],
        [UI_TEXT.static.preflightStreamlink, result.checks.streamlink, UI_TEXT.static.preflightStreamlinkMissing],
        [UI_TEXT.static.preflightFfmpeg, result.checks.ffmpeg, UI_TEXT.static.preflightFfmpegMissing],
        [UI_TEXT.static.preflightFfprobe, result.checks.ffprobe, UI_TEXT.static.preflightFfprobeMissing],
        [UI_TEXT.static.preflightPath, result.checks.downloadPathWritable, UI_TEXT.static.preflightDownloadPathNotWritable]
    ];
    const localizedIssues = entries.filter(([, ok]) => !ok).map(([, , message]) => message);
    const lines = entries.map(([name, ok]) => `${ok ? 'OK' : 'FAIL'} ${name}`).join('\n');
    const extra = localizedIssues.length ? `\n\n${localizedIssues.join('\n')}` : `\n\n${UI_TEXT.static.preflightReady}`;

    byId('preflightResult').textContent = `${lines}${extra}`;

    const badge = byId('healthBadge');
    badge.classList.remove('good', 'warn', 'bad', 'unknown');

    const failCount = localizedIssues.length;
    if (failCount === 0) {
        badge.classList.add('good');
        badge.textContent = UI_TEXT.static.healthGood;
        return;
    }

    if (failCount <= 2) {
        badge.classList.add('warn');
        badge.textContent = UI_TEXT.static.healthWarn;
    } else {
        badge.classList.add('bad');
        badge.textContent = UI_TEXT.static.healthBad;
    }
}

async function runPreflight(autoFix = false): Promise<void> {
    const btn = byId<HTMLButtonElement>(autoFix ? 'btnPreflightFix' : 'btnPreflightRun');
    const generation = ++preflightGeneration;
    btn.disabled = true;
    renderPreflightButtonLabels();

    try {
        const result = await window.api.runPreflight(autoFix);
        if (generation === preflightGeneration) renderPreflightResult(result);
    } finally {
        btn.disabled = false;
        renderPreflightButtonLabels();
    }
}

function getManagedToolStateLabel(state: ManagedToolStatus['state']): string {
    const labels: Record<ManagedToolStatus['state'], string> = {
        missing: UI_TEXT.static.managedToolsMissing,
        installing: UI_TEXT.static.managedToolsInstalling,
        verified: UI_TEXT.static.managedToolsVerified,
        unverified: UI_TEXT.static.managedToolsUnverified,
        corrupt: UI_TEXT.static.managedToolsCorrupt
    };
    return labels[state];
}

function renderManagedToolStatus(statuses: ManagedToolStatuses): void {
    const lines = [statuses.streamlink, statuses.ffmpeg].map((status) => {
        const verification = status.verified ? UI_TEXT.static.managedToolsVerified : UI_TEXT.static.managedToolsUnverified;
        return `${status.id} ${status.version}: ${getManagedToolStateLabel(status.state)} · ${verification}`;
    });
    byId('managedToolStatus').textContent = lines.join('\n');
}

async function refreshManagedToolStatus(): Promise<void> {
    const statuses = await window.api.getManagedToolStatus();
    if (statuses) renderManagedToolStatus(statuses);
}

async function repairManagedTools(): Promise<void> {
    const buttons = [
        byId<HTMLButtonElement>('btnRefreshManagedTools'),
        byId<HTMLButtonElement>('btnRepairManagedTools'),
        byId<HTMLButtonElement>('btnResetManagedTools')
    ];
    for (const button of buttons) button.disabled = true;
    byId('managedToolStatus').textContent = UI_TEXT.static.managedToolsRepairing;
    try {
        const result = await window.api.repairManagedTools();
        if (result) {
            renderManagedToolStatus(result.statuses);
            invalidatePreflightResult();
        }
    } finally {
        for (const button of buttons) button.disabled = false;
    }
}

async function resetManagedTools(): Promise<void> {
    if (!confirm(UI_TEXT.static.managedToolsResetConfirm)) return;
    const result = await window.api.resetManagedTools();
    if (result) {
        renderManagedToolStatus(result.statuses);
        invalidatePreflightResult();
    }
}

async function runCleanupDryRun(): Promise<void> {
    await runCleanupOnce(true);
}

async function runCleanupNow(): Promise<void> {
    await runCleanupOnce(false);
}

async function runCleanupOnce(dryRun: boolean): Promise<void> {
    const reportEl = byId('cleanupReport');
    const dryBtn = byId<HTMLButtonElement>('btnCleanupDryRun');
    const runBtn = byId<HTMLButtonElement>('btnCleanupRunNow');
    dryBtn.disabled = true;
    runBtn.disabled = true;
    reportEl.textContent = UI_TEXT.static.storageScanning;

    try {
        const report = await window.api.runStorageCleanup({ dryRun });
        if (report.candidates === 0) {
            reportEl.textContent = UI_TEXT.static.cleanupReportEmpty.replace('{days}', String(report.cutoffDays));
        } else if (dryRun) {
            reportEl.textContent = UI_TEXT.static.cleanupReportPreview
                .replace('{count}', String(report.candidates))
                .replace('{size}', formatBytesForMetrics(report.bytesFreed));
        } else {
            const failedSuffix = report.failed > 0
                ? UI_TEXT.static.cleanupReportFailedSuffix.replace('{failed}', String(report.failed))
                : '';
            reportEl.textContent = UI_TEXT.static.cleanupReportDone
                .replace('{count}', String(report.processed))
                .replace('{size}', formatBytesForMetrics(report.bytesFreed))
                .replace('{failed}', failedSuffix);
            // Refresh the storage list since files moved/disappeared.
            void refreshStorageStats();
        }
    } catch (e) {
        reportEl.textContent = String(e);
    } finally {
        dryBtn.disabled = false;
        runBtn.disabled = false;
    }
}

async function refreshStorageStats(): Promise<void> {
    const summary = byId('storageSummary');
    const list = byId('storageList');
    const btn = byId<HTMLButtonElement>('btnRefreshStorage');
    const old = btn.textContent || '';
    btn.disabled = true;
    btn.textContent = UI_TEXT.static.storageScanning;
    summary.textContent = UI_TEXT.static.storageScanning;
    list.replaceChildren();

    try {
        const stats = await window.api.getStorageStats();
        renderStorageStats(stats);
    } catch {
        summary.textContent = UI_TEXT.static.storageEmpty;
    } finally {
        btn.disabled = false;
        btn.textContent = old || UI_TEXT.static.storageRefresh;
    }
}

function renderStorageStats(stats: StorageStatsResult): void {
    const summary = byId('storageSummary');
    const list = byId('storageList');

    if (!stats.rootExists) {
        summary.textContent = UI_TEXT.static.storageEmpty;
        list.replaceChildren();
        return;
    }

    summary.textContent = UI_TEXT.static.storageSummary
        .replace('{files}', String(stats.totalFiles))
        .replace('{size}', formatBytesForMetrics(stats.totalBytes))
        .replace('{free}', stats.freeBytes !== null ? formatBytesForMetrics(stats.freeBytes) : '-');

    list.replaceChildren();
    if (stats.streamers.length === 0 && stats.extras.length === 0) return;

    const buildTable = (rows: StreamerStorageEntry[]): HTMLTableElement => {
        const table = document.createElement('table');
        table.className = 'storage-stats-table';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const headers = [
            UI_TEXT.static.storageColumnFolder,
            UI_TEXT.static.storageColumnFiles,
            UI_TEXT.static.storageColumnTotal,
            UI_TEXT.static.storageColumnLive,
            UI_TEXT.static.storageColumnChat,
            ''
        ];
        for (const h of headers) {
            const th = document.createElement('th');
            th.scope = 'col';
            if (h) {
                th.textContent = h;
            } else {
                th.setAttribute('aria-label', UI_TEXT.static.storageColumnActionsAria);
            }
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of rows) {
            const tr = document.createElement('tr');
            const cells: Array<string | HTMLElement> = [
                row.name,
                String(row.fileCount),
                formatBytesForMetrics(row.totalBytes),
                row.liveBytes > 0 ? formatBytesForMetrics(row.liveBytes) : '-',
                row.chatBytes > 0 ? formatBytesForMetrics(row.chatBytes) : '-'
            ];
            for (const c of cells) {
                const td = document.createElement('td');
                if (typeof c === 'string') td.textContent = c;
                else td.appendChild(c);
                tr.appendChild(td);
            }
            const openCell = document.createElement('td');
            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.textContent = UI_TEXT.static.storageOpen;
            openBtn.className = 'btn-pill';
            openBtn.addEventListener('click', () => {
                void window.api.openFolder(row.folderPath);
            });
            openCell.appendChild(openBtn);
            tr.appendChild(openCell);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        return table;
    };

    if (stats.streamers.length > 0) {
        list.appendChild(buildTable(stats.streamers));
    }
    if (stats.extras.length > 0) {
        const heading = document.createElement('div');
        heading.textContent = UI_TEXT.static.storageOtherFolders;
        heading.className = 'storage-stats-section';
        list.appendChild(heading);
        list.appendChild(buildTable(stats.extras));
    }
}

async function exportConfigToFile(): Promise<void> {
    const result = await window.api.exportConfig();
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (result.success) {
        if (toast) toast(UI_TEXT.static.configExported, 'info');
    } else if (result.cancelled) {
        // User cancelled the dialog — no toast needed.
    } else if (toast) {
        toast(UI_TEXT.static.configExportFailed + (result.error ? `\n${result.error}` : ''), 'warn');
    }
}

async function importConfigFromFile(): Promise<void> {
    const result = await window.api.importConfig();
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (result.success) {
        // Reload local config copy + refresh forms / streamer list / VOD grid
        try {
            config = await window.api.getConfig();
            if (typeof setLanguage === 'function' && typeof config.language === 'string') {
                setLanguage(config.language);
                invalidatePreflightResult();
            }
            if (typeof renderStreamers === 'function') renderStreamers();
            if (typeof syncSettingsFormFromConfig === 'function') syncSettingsFormFromConfig();
            if (typeof renderVodGridFromCurrentState === 'function' && lastLoadedStreamer) {
                renderVodGridFromCurrentState();
            }
        } catch { /* ignore — next refresh will catch up */ }
        if (toast) toast(UI_TEXT.static.configImported, 'info');
    } else if (result.cancelled) {
        // User cancelled the dialog — no toast needed.
    } else if (toast) {
        toast(UI_TEXT.static.configImportFailed + (result.error ? `\n${result.error}` : ''), 'warn');
    }
}

async function resetDownloadedIds(): Promise<void> {
    if (!confirm(UI_TEXT.static.resetDownloadedConfirm)) return;
    const result = await window.api.resetDownloadedVodIds();
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (result.success) {
        // Refresh local config so the badges disappear immediately
        try {
            config = await window.api.getConfig();
            if (typeof renderVodGridFromCurrentState === 'function' && lastLoadedStreamer) {
                renderVodGridFromCurrentState();
            }
        } catch { /* ignore */ }
        if (toast) {
            toast(UI_TEXT.static.resetDownloadedDone.replace('{count}', String(result.removedCount)), 'info');
        }
    }
}

async function openDebugLogFile(): Promise<void> {
    const ok = await window.api.openDebugLogFile();
    if (!ok) {
        const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
        if (toast) toast('Debug log file not yet present.', 'warn');
    }
}

async function refreshDebugLog(): Promise<void> {
    const text = await window.api.getDebugLog(250);
    const panel = byId('debugLogOutput');
    const keepAtBottom = (panel.scrollHeight - panel.scrollTop - panel.clientHeight) < 20;

    if (text !== lastDebugLogOutput) {
        panel.textContent = text;
        lastDebugLogOutput = text;
    }

    if (keepAtBottom) {
        panel.scrollTop = panel.scrollHeight;
    }
}

function toggleDebugAutoRefresh(enabled: boolean): void {
    if (debugLogAutoRefreshTimer) {
        clearInterval(debugLogAutoRefreshTimer);
        debugLogAutoRefreshTimer = null;
    }

    if (enabled) {
        debugLogAutoRefreshTimer = window.setInterval(() => {
            if (!canRunSettingsAutoRefresh()) {
                return;
            }

            void refreshDebugLog();
        }, 2000);
    }
}

function collectCredentialsPayload(): Partial<AppConfig> {
    return {
        client_id: byId<HTMLInputElement>('clientId').value.trim()
    };
}

function secretConfigured(inputId: SecretInputId): boolean {
    return inputId === 'clientSecret' ? secretStatus.clientSecretConfigured : secretStatus.discordWebhookConfigured;
}

function syncSecretField(inputId: SecretInputId): void {
    byId<HTMLInputElement>(inputId).value = secretConfigured(inputId) ? SECRET_INPUT_MASK : '';
}

function syncSecretFields(): void {
    syncSecretField('clientSecret');
    syncSecretField('discordWebhookUrl');
}

async function persistSecretInput(inputId: SecretInputId): Promise<void> {
    const requestGeneration = secretInputGenerations[inputId];
    const value = byId<HTMLInputElement>(inputId).value;
    if (value === SECRET_INPUT_MASK) return;

    const configured = secretConfigured(inputId);
    let nextStatus = secretStatus;
    if (value.trim()) {
        nextStatus = inputId === 'clientSecret'
            ? await window.api.setClientSecret(value.trim())
            : await window.api.setDiscordWebhook(value.trim());
    } else if (configured) {
        nextStatus = inputId === 'clientSecret'
            ? await window.api.clearClientSecret()
            : await window.api.clearDiscordWebhook();
    }

    if (secretInputGenerations[inputId] !== requestGeneration) return;
    secretStatus = nextStatus;
    syncSecretField(inputId);
}

async function persistSecretInputs(): Promise<void> {
    await persistSecretInput('clientSecret');
    await persistSecretInput('discordWebhookUrl');
}

function syncPartMinutesFieldState(): void {
    const downloadMode = byId<HTMLSelectElement>('downloadMode').value;
    const partMinutes = byId<HTMLInputElement>('partMinutes');
    const label = byId<HTMLElement>('partMinutesLabel');
    const isSplitMode = downloadMode === 'parts';

    partMinutes.disabled = !isSplitMode;
    partMinutes.setAttribute('aria-disabled', String(!isSplitMode));
    label.classList.toggle('input-disabled', !isSplitMode);
}

function parseDownloadPolicyFormValue(rateValue: string, windowsValue: string): { value: DownloadPolicy | null; error: string | null } {
    const rate = rateValue.trim();
    let throttle: DownloadPolicy['throttle'] = null;
    if (rate) {
        const numberParts = rate.replace(',', '.').split('.');
        if (numberParts.length > 2 || numberParts.some((part) => !part || [...part].some((character) => character < '0' || character > '9'))) {
            return { value: null, error: 'rate' };
        }
        const maxBytesPerSecond = Math.round(Number(numberParts.join('.')) * 1024 * 1024);
        if (!Number.isSafeInteger(maxBytesPerSecond) || maxBytesPerSecond <= 0) return { value: null, error: 'rate' };
        throttle = { maxBytesPerSecond };
    }
    const windows: DownloadPolicy['windows'] = [];
    const seen = new Set<string>();
    for (const value of windowsValue.split(/[;,\n]+/).map((entry) => entry.trim()).filter(Boolean)) {
        const match = /^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/.exec(value);
        if (!match) return { value: null, error: 'window' };
        const [startHour, startMinute] = match[1].split(':').map(Number);
        const [endHour, endMinute] = match[2].split(':').map(Number);
        if (startHour > 23 || startMinute > 59 || endHour > 23 || endMinute > 59 || match[1] === match[2]) {
            return { value: null, error: 'window' };
        }
        const key = `${match[1]}-${match[2]}`;
        if (!seen.has(key)) {
            seen.add(key);
            windows.push({ start: match[1], end: match[2] });
        }
    }
    return { value: { throttle, windows }, error: null };
}

function updateDownloadPolicyValidation(error: string | null): void {
    const status = byId<HTMLElement>('downloadPolicyValidation');
    status.textContent = error === 'rate'
        ? UI_TEXT.static.downloadThrottleInvalid
        : error === 'window'
            ? UI_TEXT.static.downloadWindowsInvalid
            : '';
}

function formatDownloadThrottle(maxBytesPerSecond: number | null | undefined): string {
    if (!maxBytesPerSecond) return '';
    return (maxBytesPerSecond / (1024 * 1024)).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function renderDownloadPolicyStatus(status: DownloadPolicyStatus): void {
    const node = byId<HTMLElement>('downloadPolicyStatus');
    if (status.waiting && status.nextStart) {
        node.textContent = UI_TEXT.static.downloadPolicyWaiting.replace('{time}', formatUiDateTime(status.nextStart));
        return;
    }
    node.textContent = UI_TEXT.static.downloadPolicyReady;
}

async function refreshDownloadPolicyStatus(): Promise<void> {
    renderDownloadPolicyStatus(await window.api.getDownloadPolicyStatus());
}

async function startDownloadPolicyOverride(): Promise<void> {
    await window.api.startDownload(true);
    await refreshDownloadPolicyStatus();
}

function collectDownloadSettingsPayload(): Partial<AppConfig> {
    const parsedPolicy = parseDownloadPolicyFormValue(
        byId<HTMLInputElement>('downloadThrottleMiBps').value,
        byId<HTMLTextAreaElement>('downloadWindows').value,
    );
    updateDownloadPolicyValidation(parsedPolicy.error);
    return {
        sidebar_split_view: byId<HTMLInputElement>('sidebarSplitViewToggle').checked,
        download_mode: byId<HTMLSelectElement>('downloadMode').value as 'parts' | 'full',
        part_minutes: parseInt(byId<HTMLInputElement>('partMinutes').value, 10) || 120,
        parallel_downloads: parseInt(byId<HTMLSelectElement>('parallelDownloads').value, 10) || 1,
        performance_mode: byId<HTMLSelectElement>('performanceMode').value as 'stability' | 'balanced' | 'speed',
        smart_queue_scheduler: byId<HTMLInputElement>('smartSchedulerToggle').checked,
        prevent_duplicate_downloads: byId<HTMLInputElement>('duplicatePreventionToggle').checked,
        persist_queue_on_restart: byId<HTMLInputElement>('persistQueueToggle').checked,
        auto_resume_queue_on_startup: byId<HTMLInputElement>('autoResumeQueueToggle').checked,
        notify_on_each_completion: byId<HTMLInputElement>('notifyEachCompletionToggle').checked,
        streamlink_disable_ads: byId<HTMLInputElement>('streamlinkDisableAdsToggle').checked,
        download_chat_replay: byId<HTMLInputElement>('downloadChatReplayToggle').checked,
        capture_live_chat: byId<HTMLInputElement>('captureLiveChatToggle').checked,
        log_stream_events: byId<HTMLInputElement>('logStreamEventsToggle').checked,
        auto_resume_live_recording: byId<HTMLInputElement>('autoResumeLiveRecordingToggle').checked,
        auto_merge_resumed_parts: byId<HTMLInputElement>('autoMergeResumedPartsToggle').checked,
        delete_parts_after_merge: byId<HTMLInputElement>('deletePartsAfterMergeToggle').checked,
        discord_notify_live_start: byId<HTMLInputElement>('discordNotifyLiveStartToggle').checked,
        discord_notify_live_end: byId<HTMLInputElement>('discordNotifyLiveEndToggle').checked,
        discord_notify_vod_complete: byId<HTMLInputElement>('discordNotifyVodCompleteToggle').checked,
        discord_notify_vod_auto_queued: byId<HTMLInputElement>('discordNotifyVodAutoQueuedToggle').checked,
        auto_vod_download_poll_minutes: parseInt(byId<HTMLInputElement>('autoVodPollMinutes').value, 10) || 15,
        auto_vod_max_age_hours: parseInt(byId<HTMLInputElement>('autoVodMaxAgeHours').value, 10) || 24,
        auto_cleanup_enabled: byId<HTMLInputElement>('autoCleanupEnabledToggle').checked,
        auto_cleanup_days: parseInt(byId<HTMLInputElement>('autoCleanupDays').value, 10) || 30,
        auto_cleanup_target: byId<HTMLSelectElement>('autoCleanupTarget').value === 'all' ? 'all' : 'live_only',
        auto_cleanup_action: byId<HTMLSelectElement>('autoCleanupAction').value === 'delete' ? 'delete' : 'archive',
        streamlink_quality: byId<HTMLSelectElement>('streamlinkQuality').value,
        metadata_cache_minutes: parseInt(byId<HTMLInputElement>('metadataCacheMinutes').value, 10) || 10,
        download_policy: parsedPolicy.value ?? config.download_policy ?? { throttle: null, windows: [] }
    };
}

function collectFilenameTemplatePayload(showAlert = false): Partial<AppConfig> | null {
    if (!validateFilenameTemplates(showAlert)) {
        return null;
    }

    return {
        filename_template_vod: byId<HTMLInputElement>('vodFilenameTemplate').value.trim() || '{title}.mp4',
        filename_template_parts: byId<HTMLInputElement>('partsFilenameTemplate').value.trim() || '{date}_Part{part_padded}.mp4',
        filename_template_clip: byId<HTMLInputElement>('defaultClipFilenameTemplate').value.trim() || '{date}_{part}.mp4'
    };
}

function collectAutoSavePayload(): Partial<AppConfig> {
    const payload: Partial<AppConfig> = {
        ...collectCredentialsPayload(),
        ...collectDownloadSettingsPayload(),
        sidebar_split_view: byId<HTMLInputElement>('sidebarSplitViewToggle').checked
    };

    const templatePayload = collectFilenameTemplatePayload(false);
    if (templatePayload) {
        Object.assign(payload, templatePayload);
    }

    return payload;
}

function getSettingsFingerprint(payload: Partial<AppConfig>): string {
    const effective = { ...config, ...payload };
    return JSON.stringify([
        effective.client_id ?? '',
        byId<HTMLInputElement>('clientSecret').value,
        effective.sidebar_split_view !== false,
        effective.download_mode ?? 'full',
        effective.part_minutes ?? 120,
        effective.parallel_downloads ?? 1,
        effective.performance_mode ?? 'balanced',
        effective.smart_queue_scheduler !== false,
        effective.prevent_duplicate_downloads !== false,
        effective.persist_queue_on_restart !== false,
        effective.auto_resume_queue_on_startup === true,
        effective.notify_on_each_completion === true,
        effective.streamlink_disable_ads !== false,
        effective.download_chat_replay === true,
        effective.capture_live_chat === true,
        effective.log_stream_events !== false,
        effective.auto_resume_live_recording !== false,
        effective.auto_merge_resumed_parts === true,
        effective.delete_parts_after_merge === true,
        byId<HTMLInputElement>('discordWebhookUrl').value,
        effective.discord_notify_live_start === true,
        effective.discord_notify_live_end === true,
        effective.discord_notify_vod_complete === true,
        effective.discord_notify_vod_auto_queued === true,
        effective.auto_vod_download_poll_minutes ?? 15,
        effective.auto_vod_max_age_hours ?? 24,
        effective.auto_cleanup_enabled === true,
        effective.auto_cleanup_days ?? 30,
        effective.auto_cleanup_target ?? 'live_only',
        effective.auto_cleanup_action ?? 'archive',
        effective.streamlink_quality ?? 'best',
        effective.metadata_cache_minutes ?? 10,
        effective.download_policy?.throttle?.maxBytesPerSecond ?? null,
        effective.download_policy?.windows ?? [],
        effective.filename_template_vod ?? '{title}.mp4',
        effective.filename_template_parts ?? '{date}_Part{part_padded}.mp4',
        effective.filename_template_clip ?? '{date}_{part}.mp4'
    ]);
}

function syncSettingsFormFromConfig(syncSecrets = true): void {
    byId<HTMLInputElement>('clientId').value = config.client_id ?? '';
    if (syncSecrets) syncSecretFields();
    byId<HTMLInputElement>('sidebarSplitViewToggle').checked = config.sidebar_split_view !== false;
    applySidebarLayoutPreference(config.sidebar_split_view !== false);
    byId<HTMLSelectElement>('downloadMode').value = (config.download_mode as 'parts' | 'full') ?? 'full';
    byId<HTMLInputElement>('partMinutes').value = String((config.part_minutes as number) || 120);
    byId<HTMLSelectElement>('parallelDownloads').value = String((config.parallel_downloads as number) || 1);
    byId<HTMLSelectElement>('performanceMode').value = (config.performance_mode as string) || 'balanced';
    byId<HTMLInputElement>('smartSchedulerToggle').checked = (config.smart_queue_scheduler as boolean) !== false;
    byId<HTMLInputElement>('duplicatePreventionToggle').checked = (config.prevent_duplicate_downloads as boolean) !== false;
    byId<HTMLInputElement>('persistQueueToggle').checked = (config.persist_queue_on_restart as boolean) !== false;
    byId<HTMLInputElement>('autoResumeQueueToggle').checked = (config.auto_resume_queue_on_startup as boolean) === true;
    byId<HTMLInputElement>('notifyEachCompletionToggle').checked = (config.notify_on_each_completion as boolean) === true;
    byId<HTMLInputElement>('streamlinkDisableAdsToggle').checked = (config.streamlink_disable_ads as boolean) !== false;
    byId<HTMLInputElement>('downloadThrottleMiBps').value = formatDownloadThrottle(config.download_policy?.throttle?.maxBytesPerSecond);
    byId<HTMLTextAreaElement>('downloadWindows').value = (config.download_policy?.windows ?? []).map((window) => `${window.start}-${window.end}`).join('\n');
    updateDownloadPolicyValidation(null);
    byId<HTMLInputElement>('downloadChatReplayToggle').checked = (config.download_chat_replay as boolean) === true;
    byId<HTMLInputElement>('captureLiveChatToggle').checked = (config.capture_live_chat as boolean) === true;
    byId<HTMLInputElement>('logStreamEventsToggle').checked = (config.log_stream_events as boolean) !== false;
    byId<HTMLInputElement>('autoResumeLiveRecordingToggle').checked = (config.auto_resume_live_recording as boolean) !== false;
    byId<HTMLInputElement>('autoMergeResumedPartsToggle').checked = (config.auto_merge_resumed_parts as boolean) === true;
    byId<HTMLInputElement>('deletePartsAfterMergeToggle').checked = (config.delete_parts_after_merge as boolean) === true;
    byId<HTMLInputElement>('discordNotifyLiveStartToggle').checked = (config.discord_notify_live_start as boolean) === true;
    byId<HTMLInputElement>('discordNotifyLiveEndToggle').checked = (config.discord_notify_live_end as boolean) === true;
    byId<HTMLInputElement>('discordNotifyVodCompleteToggle').checked = (config.discord_notify_vod_complete as boolean) === true;
    byId<HTMLInputElement>('discordNotifyVodAutoQueuedToggle').checked = (config.discord_notify_vod_auto_queued as boolean) === true;
    byId<HTMLInputElement>('autoVodPollMinutes').value = String((config.auto_vod_download_poll_minutes as number) || 15);
    byId<HTMLInputElement>('autoVodMaxAgeHours').value = String((config.auto_vod_max_age_hours as number) || 24);
    byId<HTMLInputElement>('autoCleanupEnabledToggle').checked = (config.auto_cleanup_enabled as boolean) === true;
    byId<HTMLInputElement>('autoCleanupDays').value = String((config.auto_cleanup_days as number) || 30);
    byId<HTMLSelectElement>('autoCleanupTarget').value = (config.auto_cleanup_target as string) === 'all' ? 'all' : 'live_only';
    byId<HTMLSelectElement>('autoCleanupAction').value = (config.auto_cleanup_action as string) === 'delete' ? 'delete' : 'archive';
    byId<HTMLSelectElement>('streamlinkQuality').value = (config.streamlink_quality as string) || 'best';
    byId<HTMLInputElement>('metadataCacheMinutes').value = String((config.metadata_cache_minutes as number) || 10);
    byId<HTMLInputElement>('vodFilenameTemplate').value = (config.filename_template_vod as string) || '{title}.mp4';
    byId<HTMLInputElement>('partsFilenameTemplate').value = (config.filename_template_parts as string) || '{date}_Part{part_padded}.mp4';
    byId<HTMLInputElement>('defaultClipFilenameTemplate').value = (config.filename_template_clip as string) || '{date}_{part}.mp4';
    syncPartMinutesFieldState();
    void refreshDownloadPolicyStatus();
    validateFilenameTemplates();
    lastPersistedSettingsFingerprint = getSettingsFingerprint({});
}

async function persistSettings(options: {
    includeCredentials?: boolean;
    includeTemplates?: boolean;
    reconnectAfterSave?: boolean;
    showTemplateAlert?: boolean;
} = {}): Promise<boolean> {
    const payload: Partial<AppConfig> = {
        ...collectDownloadSettingsPayload()
    };

    if (options.includeCredentials) {
        Object.assign(payload, collectCredentialsPayload());
    }

    if (options.includeTemplates !== false) {
        const templatePayload = collectFilenameTemplatePayload(options.showTemplateAlert);
        if (!templatePayload) {
            return false;
        }
        Object.assign(payload, templatePayload);
    }

    await persistSecretInputs();
    config = await window.api.saveConfig(payload);
    syncSettingsFormFromConfig(false);
    pendingCredentialsReconnect = false;

    if (options.reconnectAfterSave) {
        await connect();
    }

    if (canRunSettingsAutoRefresh()) {
        await refreshRuntimeMetrics(false);
    }

    return true;
}

async function flushSettingsAutoSave(reconnectAfterSave = false): Promise<void> {
    if (settingsAutoSaveTimer) {
        clearTimeout(settingsAutoSaveTimer);
        settingsAutoSaveTimer = null;
    }

    const payload = collectAutoSavePayload();
    const fingerprint = getSettingsFingerprint(payload);
    const inputGeneration = settingsInputGeneration;

    if (fingerprint === lastPersistedSettingsFingerprint) {
        if (reconnectAfterSave && pendingCredentialsReconnect) {
            pendingCredentialsReconnect = false;
            await connect();
        }
        return;
    }

    if (settingsAutoSaveInFlight) {
        pendingSettingsAutoSave = true;
        return;
    }

    settingsAutoSaveInFlight = true;
    try {
        await persistSecretInputs();
        config = await window.api.saveConfig(payload);
        if (settingsInputGeneration === inputGeneration) {
            lastPersistedSettingsFingerprint = getSettingsFingerprint({});
        } else {
            pendingSettingsAutoSave = true;
        }
        if (reconnectAfterSave && pendingCredentialsReconnect) {
            pendingCredentialsReconnect = false;
            await connect();
        }
    } finally {
        settingsAutoSaveInFlight = false;
        if (pendingSettingsAutoSave) {
            pendingSettingsAutoSave = false;
            void flushSettingsAutoSave(pendingCredentialsReconnect);
        }
    }
}

function scheduleSettingsAutoSave(delayMs = 450): void {
    if (settingsAutoSaveTimer) {
        clearTimeout(settingsAutoSaveTimer);
    }

    settingsAutoSaveTimer = window.setTimeout(() => {
        settingsAutoSaveTimer = null;
        void flushSettingsAutoSave(false);
    }, delayMs);
}

function initSettingsAutoSave(): void {
    if (settingsAutoSaveBound) {
        return;
    }

    settingsAutoSaveBound = true;
    syncSettingsFormFromConfig();
    window.api.onDownloadPolicyStatus(renderDownloadPolicyStatus);

    const immediateSaveIds = [
        'downloadMode',
        'sidebarSplitViewToggle',
        'parallelDownloads',
        'performanceMode',
        'smartSchedulerToggle',
        'duplicatePreventionToggle',
        'persistQueueToggle',
        'autoResumeQueueToggle',
        'notifyEachCompletionToggle',
        'streamlinkDisableAdsToggle',
        'downloadChatReplayToggle',
        'captureLiveChatToggle',
        'logStreamEventsToggle',
        'discordNotifyLiveStartToggle',
        'discordNotifyLiveEndToggle',
        'discordNotifyVodCompleteToggle',
        'autoCleanupEnabledToggle',
        'autoCleanupTarget',
        'autoCleanupAction',
        'streamlinkQuality'
    ] as const;

    const debouncedSaveIds = [
        'partMinutes',
        'metadataCacheMinutes',
        'vodFilenameTemplate',
        'partsFilenameTemplate',
        'defaultClipFilenameTemplate',
        'discordWebhookUrl',
        'autoCleanupDays',
        'downloadThrottleMiBps',
        'downloadWindows'
    ] as const;

    const credentialIds = [
        'clientId',
        'clientSecret'
    ] as const;

    const triggerImmediateSave = () => {
        void flushSettingsAutoSave(false);
    };

    byId<HTMLSelectElement>('downloadMode').addEventListener('change', syncPartMinutesFieldState);

    for (const id of immediateSaveIds) {
        const element = byId<HTMLInputElement | HTMLSelectElement>(id);
        element.addEventListener('change', () => {
            markSettingsInputChanged();
            triggerImmediateSave();
        });
        element.addEventListener('blur', triggerImmediateSave);
    }

    for (const id of debouncedSaveIds) {
        const element = byId<HTMLInputElement>(id);
        element.addEventListener('input', () => {
            markSettingsInputChanged();
            scheduleSettingsAutoSave();
        });
        element.addEventListener('blur', () => {
            void flushSettingsAutoSave(false);
        });
    }

    for (const id of credentialIds) {
        const element = byId<HTMLInputElement>(id);
        element.addEventListener('input', () => {
            markSettingsInputChanged();
            pendingCredentialsReconnect = true;
            scheduleSettingsAutoSave();
        });
        element.addEventListener('blur', () => {
            pendingCredentialsReconnect = true;
            void flushSettingsAutoSave(true);
        });
    }

    for (const id of ['clientSecret', 'discordWebhookUrl'] as const) {
        byId<HTMLInputElement>(id).addEventListener('input', () => {
            secretInputGenerations[id] += 1;
        });
    }

    for (const id of ['clientSecret', 'discordWebhookUrl'] as const) {
        byId<HTMLInputElement>(id).addEventListener('focus', (event) => {
            const input = event.currentTarget as HTMLInputElement;
            if (input.value === SECRET_INPUT_MASK) input.select();
        });
    }

    window.addEventListener('blur', () => {
        if (settingsAutoSaveTimer || pendingCredentialsReconnect) {
            void flushSettingsAutoSave(pendingCredentialsReconnect);
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && (settingsAutoSaveTimer || pendingCredentialsReconnect)) {
            void flushSettingsAutoSave(pendingCredentialsReconnect);
        }
    });
}

async function saveSettings(): Promise<void> {
    const saved = await persistSettings({
        includeCredentials: true,
        includeTemplates: true,
        reconnectAfterSave: true,
        showTemplateAlert: true
    });

    if (!saved) {
        return;
    }
}

async function selectFolder(): Promise<void> {
    const folder = await window.api.selectFolder();
    if (!folder) {
        return;
    }

    byId<HTMLInputElement>('downloadPath').value = folder.displayPath;
    config = await window.api.saveConfig({ download_path: folder.displayPath }, folder.token);
    invalidatePreflightResult();

    // Warn-only validation — the user explicitly chose this folder, so don't
    // refuse to save (they might be picking a path on a USB stick that's
    // currently disconnected). Just surface the writability problem early
    // instead of letting the next download fail with a cryptic error.
    try {
        const writable = await window.api.checkFolderWritable(folder.token);
        if (!writable) {
            const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
            if (toast) toast(UI_TEXT.static.downloadPathNotWritable, 'warn');
        }
    } catch { /* ignore — preflight will catch it later */ }
}

function openFolder(): void {
    const folder = config.download_path;
    if (!folder || typeof folder !== 'string') {
        return;
    }

    void window.api.openFolder(folder);
}

function syncWorkspaceThemePicker(theme: string): void {
    const selectedTheme = theme === 'light' || theme === 'system' ? theme : 'twitch';
    document.querySelectorAll<HTMLButtonElement>('#workspaceThemePicker [data-theme]').forEach((button) => {
        const active = button.dataset.theme === selectedTheme;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

function selectWorkspaceTheme(theme: string): void {
    byId<HTMLSelectElement>('themeSelect').value = theme;
    changeTheme(theme);
}

function changeTheme(theme: string): void {
    document.body.className = `theme-${theme}`;
    config.theme = theme;
    syncWorkspaceThemePicker(theme);
    void window.api.saveConfig({ theme });
}

function formatRelativeTime(ms: number, future: boolean): string {
    if (!Number.isFinite(ms) || ms <= 0) {
        return future ? UI_TEXT.streamers.autoVodScanEmpty || '' : '-';
    }
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

async function refreshAutomationStatusLine(): Promise<void> {
    const lineEl = document.getElementById('autoVodStatusLine');
    if (!lineEl) return;
    try {
        const status = await window.api.getAutomationStatus();
        const now = Date.now();
        const parts: string[] = [];

        if (status.autoVod.watching > 0) {
            const lastAgo = status.autoVod.lastRunAt > 0 ? formatRelativeTime(now - status.autoVod.lastRunAt, false) : '-';
            const nextIn = status.autoVod.nextRunAt > now ? formatRelativeTime(status.autoVod.nextRunAt - now, true) : '-';
            parts.push(`VOD: ${status.autoVod.watching} watched · last ${lastAgo} ago · next in ${nextIn} · last run +${status.autoVod.lastQueuedCount}`);
        }
        if (status.autoRecord.watching > 0) {
            const lastAgo = status.autoRecord.lastRunAt > 0 ? formatRelativeTime(now - status.autoRecord.lastRunAt, false) : '-';
            const nextIn = status.autoRecord.nextRunAt > now ? formatRelativeTime(status.autoRecord.nextRunAt - now, true) : '-';
            parts.push(`REC: ${status.autoRecord.watching} watched · last ${lastAgo} ago · next in ${nextIn}`);
        }
        if (parts.length === 0) parts.push('No streamers watched.');
        lineEl.textContent = parts.join(' · ');
    } catch (_) {
        lineEl.textContent = '';
    }
}

async function triggerManualAutoVodScan(): Promise<void> {
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    const btn = document.getElementById('btnAutoVodScanNow') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
        const result = await window.api.triggerAutoVodScan();
        if (toast) {
            const tmpl = result.queuedCount > 0
                ? UI_TEXT.streamers.autoVodScanQueued
                : UI_TEXT.streamers.autoVodScanEmpty;
            toast((tmpl || '').replace('{count}', String(result.queuedCount)), 'info');
        }
    } finally {
        if (btn) btn.disabled = false;
        void refreshAutomationStatusLine();
    }
}

async function triggerManualAutoRecordScan(): Promise<void> {
    const toast = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    const btn = document.getElementById('btnAutoRecordScanNow') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
        const result = await window.api.triggerAutoRecordScan();
        if (toast) {
            const tmpl = result.triggered > 0
                ? UI_TEXT.streamers.autoRecordScanTriggered
                : UI_TEXT.streamers.autoRecordScanEmpty;
            toast((tmpl || '').replace('{count}', String(result.triggered)), 'info');
        }
    } finally {
        if (btn) btn.disabled = false;
        void refreshAutomationStatusLine();
    }
}

(window as unknown as { triggerManualAutoVodScan: typeof triggerManualAutoVodScan }).triggerManualAutoVodScan = triggerManualAutoVodScan;
(window as unknown as { triggerManualAutoRecordScan: typeof triggerManualAutoRecordScan }).triggerManualAutoRecordScan = triggerManualAutoRecordScan;

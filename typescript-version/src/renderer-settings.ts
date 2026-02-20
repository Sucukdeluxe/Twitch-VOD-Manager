let lastRuntimeMetricsOutput = '';

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
        lintNode.style.color = '#8bc34a';
        lintNode.textContent = UI_TEXT.static.templateLintOk;
        return true;
    }

    lintNode.style.color = '#ff8a80';
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
            void refreshRuntimeMetrics(false);
        }, 2000);
    }
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
    updateLanguagePicker(normalized);
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

    void refreshRuntimeMetrics();
    validateFilenameTemplates();
}

function updateLanguagePicker(lang: string): void {
    const de = byId<HTMLButtonElement>('langOptionDe');
    const en = byId<HTMLButtonElement>('langOptionEn');

    const isDe = lang === 'de';
    de.classList.toggle('active', isDe);
    en.classList.toggle('active', !isDe);
    de.setAttribute('aria-pressed', String(isDe));
    en.setAttribute('aria-pressed', String(!isDe));
}

function selectLanguageOption(lang: string): void {
    changeLanguage(lang);
}

function renderPreflightResult(result: PreflightResult): void {
    const entries = [
        [UI_TEXT.static.preflightInternet, result.checks.internet],
        [UI_TEXT.static.preflightStreamlink, result.checks.streamlink],
        [UI_TEXT.static.preflightFfmpeg, result.checks.ffmpeg],
        [UI_TEXT.static.preflightFfprobe, result.checks.ffprobe],
        [UI_TEXT.static.preflightPath, result.checks.downloadPathWritable]
    ];

    const lines = entries.map(([name, ok]) => `${ok ? 'OK' : 'FAIL'} ${name}`).join('\n');
    const extra = result.messages.length ? `\n\n${result.messages.join('\n')}` : `\n\n${UI_TEXT.static.preflightReady}`;

    byId('preflightResult').textContent = `${lines}${extra}`;

    const badge = byId('healthBadge');
    badge.classList.remove('good', 'warn', 'bad', 'unknown');

    if (result.ok) {
        badge.classList.add('good');
        badge.textContent = UI_TEXT.static.healthGood;
        return;
    }

    const failCount = Object.values(result.checks).filter((ok) => !ok).length;
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
    const old = btn.textContent || '';
    btn.disabled = true;
    btn.textContent = autoFix ? UI_TEXT.static.preflightFixing : UI_TEXT.static.preflightChecking;

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
    const performanceMode = byId<HTMLSelectElement>('performanceMode').value as 'stability' | 'balanced' | 'speed';
    const smartQueueScheduler = byId<HTMLInputElement>('smartSchedulerToggle').checked;
    const duplicatePrevention = byId<HTMLInputElement>('duplicatePreventionToggle').checked;
    const metadataCacheMinutes = parseInt(byId<HTMLInputElement>('metadataCacheMinutes').value, 10) || 10;
    const vodFilenameTemplate = byId<HTMLInputElement>('vodFilenameTemplate').value.trim() || '{title}.mp4';
    const partsFilenameTemplate = byId<HTMLInputElement>('partsFilenameTemplate').value.trim() || '{date}_Part{part_padded}.mp4';
    const defaultClipFilenameTemplate = byId<HTMLInputElement>('defaultClipFilenameTemplate').value.trim() || '{date}_{part}.mp4';

    if (!validateFilenameTemplates(true)) {
        return;
    }

    config = await window.api.saveConfig({
        client_id: clientId,
        client_secret: clientSecret,
        download_path: downloadPath,
        download_mode: downloadMode,
        part_minutes: partMinutes,
        performance_mode: performanceMode,
        smart_queue_scheduler: smartQueueScheduler,
        prevent_duplicate_downloads: duplicatePrevention,
        metadata_cache_minutes: metadataCacheMinutes,
        filename_template_vod: vodFilenameTemplate,
        filename_template_parts: partsFilenameTemplate,
        filename_template_clip: defaultClipFilenameTemplate
    });

    byId<HTMLSelectElement>('performanceMode').value = (config.performance_mode as string) || 'balanced';
    byId<HTMLInputElement>('smartSchedulerToggle').checked = (config.smart_queue_scheduler as boolean) !== false;
    byId<HTMLInputElement>('duplicatePreventionToggle').checked = (config.prevent_duplicate_downloads as boolean) !== false;
    byId<HTMLInputElement>('metadataCacheMinutes').value = String((config.metadata_cache_minutes as number) || 10);
    byId<HTMLInputElement>('vodFilenameTemplate').value = (config.filename_template_vod as string) || '{title}.mp4';
    byId<HTMLInputElement>('partsFilenameTemplate').value = (config.filename_template_parts as string) || '{date}_Part{part_padded}.mp4';
    byId<HTMLInputElement>('defaultClipFilenameTemplate').value = (config.filename_template_clip as string) || '{date}_{part}.mp4';
    validateFilenameTemplates();

    await connect();
    await refreshRuntimeMetrics();
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

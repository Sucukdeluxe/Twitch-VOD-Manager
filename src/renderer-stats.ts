let archiveStatsRefreshInFlight = false;
let lastArchiveStats: ArchiveStats | null = null;

async function refreshArchiveStats(): Promise<void> {
    if (archiveStatsRefreshInFlight) return;
    archiveStatsRefreshInFlight = true;
    for (const id of ['btnStatsRefresh', 'toolbarStatsRefreshBtn']) {
        const button = document.getElementById(id) as HTMLButtonElement | null;
        if (button) button.disabled = true;
    }
    const status = document.getElementById('statsStatus');
    if (status) {
        status.textContent = UI_TEXT.static.statsScanning;
        status.classList.remove('is-error');
    }
    document.getElementById('statsTab')?.setAttribute('aria-busy', 'true');
    if (!lastArchiveStats) renderStatsSummary(null);
    try {
        lastArchiveStats = await window.api.getArchiveStats();
        renderArchiveStats(lastArchiveStats);
        if (status) status.textContent = '';
    } catch (error) {
        if (status) {
            status.textContent = UI_TEXT.static.errorPrefix + ': ' + (error instanceof Error ? error.message : String(error));
            status.classList.add('is-error');
        }
    } finally {
        archiveStatsRefreshInFlight = false;
        document.getElementById('statsTab')?.setAttribute('aria-busy', 'false');
        for (const id of ['btnStatsRefresh', 'toolbarStatsRefreshBtn']) {
            const button = document.getElementById(id) as HTMLButtonElement | null;
            if (button) button.disabled = false;
        }
    }
}

function refreshArchiveStatsTexts(): void {
    if (lastArchiveStats) renderArchiveStats(lastArchiveStats);
    if (archiveStatsRefreshInFlight) setText('statsStatus', UI_TEXT.static.statsScanning);
}

function renderArchiveStats(stats: ArchiveStats): void {
    setText('statsLastScannedLabel', UI_TEXT.static.statsScannedAt + ': ' + formatUiDateTime(new Date(stats.scannedAt)));
    const lifetime = stats.lifetime;
    setText('statsTrackingSince', lifetime?.available && lifetime.trackedSince
        ? UI_TEXT.static.statsTrackedSince.replace('{date}', formatUiDate(new Date(lifetime.trackedSince))) : '');
    setText('statsHistoryNote', lifetime?.available ? '' : UI_TEXT.static.statsHistoryUnavailable);
    setText('statsInventoryStatus', stats.rootExists ? '' : UI_TEXT.static.statsNoRoot);
    renderStatsSummary(stats);
    renderStatsInventory(stats);
    renderStatsTopStreamers(stats.topStreamers, stats.totalBytes);
    renderStatsActivity(lifetime?.available ? lifetime.dailyActivity : [], lifetime?.unknownDateDownloads || 0);
    renderStatsSizeBuckets(stats.sizeBuckets);
}

function renderStatsSummary(stats: ArchiveStats | null): void {
    const grid = document.getElementById('statsSummaryGrid');
    if (!grid) return;
    const lifetime = stats?.lifetime;
    const available = !!lifetime?.available;
    const number = (value: number | undefined) => available ? formatUiNumber(value || 0) : '—';
    const cards = [
        { label: UI_TEXT.static.statsVodRecordings, value: number(lifetime?.vodDownloads), kind: 'vod' },
        { label: UI_TEXT.static.statsLiveRecordings, value: number(lifetime?.liveRecordings), kind: 'live' },
        { label: UI_TEXT.static.statsClipDownloads, value: number(lifetime?.clipDownloads), kind: 'clips' },
        { label: UI_TEXT.static.statsDownloadedBytes, value: available ? formatBytes(lifetime?.totalBytes || 0) : '—', kind: 'bytes' }
    ];
    const fragments = cards.map(card => {
        const item = document.createElement('article');
        item.className = 'stats-kpi-card stats-kpi-' + card.kind;
        const label = document.createElement('div');
        label.className = 'stats-kpi-label';
        label.textContent = card.label;
        const value = document.createElement('div');
        value.className = 'stats-kpi-value';
        value.textContent = card.value;
        item.append(label, value);
        return item;
    });
    grid.replaceChildren(...fragments);
}

function renderStatsInventory(stats: ArchiveStats): void {
    const grid = document.getElementById('statsInventoryGrid');
    if (!grid) return;
    const cards = [
        { label: UI_TEXT.static.statsTotalRecordings, value: formatUiNumber(stats.liveCount + stats.vodCount + (stats.clipCount || 0)) },
        { label: UI_TEXT.static.statsArchiveSize, value: formatBytes(stats.totalBytes) },
        { label: UI_TEXT.static.statsStreamers, value: formatUiNumber(stats.streamerCount) },
        { label: UI_TEXT.static.statsChatFiles, value: formatUiNumber(stats.chatCount) },
        { label: UI_TEXT.static.statsAvgSize, value: stats.avgRecordingSizeBytes > 0 ? formatBytes(stats.avgRecordingSizeBytes) : '—' }
    ];
    applyHtml(grid, cards.map(card => '<div class="stats-inventory-item"><strong>' + escapeHtml(stats.rootExists ? card.value : '—') + '</strong><span>' + escapeHtml(card.label) + '</span></div>').join(''));
}

function renderStatsTopStreamers(top: ArchiveStatsTopStreamer[], totalBytes: number): void {
    const container = document.getElementById('statsTopStreamers');
    if (!container) return;
    if (top.length === 0) {
        applyHtml(container, '<div class="insights-empty">' + escapeHtml(UI_TEXT.static.statsEmpty) + '</div>');
        return;
    }
    const maxBytes = Math.max(1, ...top.map(item => item.bytes));
    applyHtml(container, top.map(item => {
        const percent = Math.min(100, Math.max(0, item.bytes / maxBytes * 100));
        const share = new Intl.NumberFormat(getIntlLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(totalBytes > 0 ? item.bytes / totalBytes : 0);
        return '<div class="stats-top-row"><div class="stats-top-meta"><strong>' + escapeHtml(item.streamer) + '</strong><span>' + escapeHtml(formatBytes(item.bytes)) + '</span></div><div class="stats-top-bar-track"><div class="stats-top-bar-fill" style="width:' + percent + '%"></div></div><div class="stats-top-caption"><span>' + escapeHtml(formatUiNumber(item.fileCount) + ' ' + UI_TEXT.static.statsFiles) + '</span><span>' + escapeHtml(share) + '</span></div></div>';
    }).join(''));
}

function renderStatsActivity(days: ArchiveStatsDay[], unknownDates = 0): void {
    const container = document.getElementById('statsActivity');
    if (!container) return;
    const totalCount = days.reduce((sum, day) => sum + day.count, 0);
    const totalBytes = days.reduce((sum, day) => sum + day.bytes, 0);
    const maxCount = Math.max(1, ...days.map(day => day.count));
    const bars = days.map((day, index) => {
        const date = new Date(day.date + 'T12:00:00');
        const dateLabel = new Intl.DateTimeFormat(getIntlLocale(), { day: 'numeric', month: 'short' }).format(date);
        const tooltip = dateLabel + ': ' + formatUiNumber(day.count) + ' ' + UI_TEXT.static.statsDownloads + ' · ' + formatBytes(day.bytes);
        const showLabel = index === 0 || index === days.length - 1 || (index % 7 === 0 && days.length - 1 - index >= 4);
        const height = day.count > 0 ? Math.max(3, day.count / maxCount * 100) : 0;
        return '<div class="stats-day-col" title="' + escapeHtml(tooltip) + '"><div class="stats-day-bar-track"><div class="stats-day-bar-fill" style="height:' + height + '%"></div></div><span class="stats-day-label">' + (showLabel ? escapeHtml(dateLabel) : '') + '</span></div>';
    }).join('');
    const summary = UI_TEXT.static.statsActivitySummary.replace('{count}', formatUiNumber(totalCount)).replace('{size}', formatBytes(totalBytes));
    const note = unknownDates > 0 ? '<p class="insights-note">' + escapeHtml(UI_TEXT.static.statsUnknownDates.replace('{count}', formatUiNumber(unknownDates))) + '</p>' : '';
    applyHtml(container, '<div class="stats-activity-total">' + escapeHtml(summary) + '</div><div class="stats-activity-chart"><div class="stats-activity-row">' + bars + '</div>' + (totalCount === 0 ? '<div class="stats-chart-empty">' + escapeHtml(UI_TEXT.static.statsActivityEmpty) + '</div>' : '') + '</div>' + note);
}

function renderStatsSizeBuckets(buckets: ArchiveStatsBucket[]): void {
    const container = document.getElementById('statsSizeBuckets');
    if (!container) return;
    const maxCount = Math.max(1, ...buckets.map(bucket => bucket.count));
    if (!buckets.some(bucket => bucket.count > 0)) {
        applyHtml(container, '<div class="insights-empty">' + escapeHtml(UI_TEXT.static.statsEmpty) + '</div>');
        return;
    }
    applyHtml(container, buckets.map(bucket => {
        const percent = Math.min(100, bucket.count / maxCount * 100);
        return '<div class="stats-bucket-row"><div class="stats-bucket-meta"><span>' + escapeHtml(bucket.label) + '</span><strong>' + escapeHtml(formatUiNumber(bucket.count)) + '</strong></div><div class="stats-bucket-bar-track"><div class="stats-bucket-bar-fill" style="width:' + percent + '%"></div></div></div>';
    }).join(''));
}

(window as unknown as { refreshArchiveStats: typeof refreshArchiveStats }).refreshArchiveStats = refreshArchiveStats;

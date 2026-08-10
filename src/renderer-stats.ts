let archiveStatsRefreshInFlight = false;

async function refreshArchiveStats(): Promise<void> {
    if (archiveStatsRefreshInFlight) return;

    const btn = document.getElementById('btnStatsRefresh') as HTMLButtonElement | null;
    const toolbarBtn = document.getElementById('toolbarStatsRefreshBtn') as HTMLButtonElement | null;
    archiveStatsRefreshInFlight = true;
    if (btn) btn.disabled = true;
    if (toolbarBtn) toolbarBtn.disabled = true;
    const lastLabel = document.getElementById('statsLastScannedLabel');
    if (lastLabel) lastLabel.textContent = (UI_TEXT.static.statsScanning as string) || 'Scanning...';

    try {
        const stats = await window.api.getArchiveStats();
        renderArchiveStats(stats);
    } catch (e) {
        const summary = document.getElementById('statsSummaryGrid');
        if (summary) summary.textContent = `${UI_TEXT.static.errorPrefix}: ${String(e)}`;
    } finally {
        archiveStatsRefreshInFlight = false;
        if (btn) btn.disabled = false;
        if (toolbarBtn) toolbarBtn.disabled = false;
    }
}

function renderArchiveStats(stats: ArchiveStats): void {
    const lastLabel = document.getElementById('statsLastScannedLabel');
    if (lastLabel) {
        const dt = new Date(stats.scannedAt);
        lastLabel.textContent = `${UI_TEXT.static.statsScannedAt}: ${formatUiDateTime(dt)}`;
    }

    renderStatsSummary(stats);
    renderStatsTopStreamers(stats.topStreamers, stats.totalBytes);
    renderStatsActivity(stats.dailyActivity);
    renderStatsSizeBuckets(stats.sizeBuckets);
}

function renderStatsSummary(stats: ArchiveStats): void {
    const grid = document.getElementById('statsSummaryGrid');
    if (!grid) return;

    if (!stats.rootExists) {
        applyHtml(grid, `<div class="stats-no-root">${escapeHtml(UI_TEXT.static.statsNoRoot)}</div>`);
        return;
    }

    const cards: Array<{ label: string; value: string; sub?: string }> = [
        { label: UI_TEXT.static.statsTotalRecordings, value: String(stats.liveCount + stats.vodCount), sub: formatBytes(stats.liveBytes + stats.vodBytes) },
        { label: UI_TEXT.static.statsLiveRecordings, value: String(stats.liveCount), sub: formatBytes(stats.liveBytes) },
        { label: UI_TEXT.static.statsVodRecordings, value: String(stats.vodCount), sub: formatBytes(stats.vodBytes) },
        { label: UI_TEXT.static.statsStreamers, value: String(stats.streamerCount) },
        { label: UI_TEXT.static.statsAvgSize, value: stats.avgRecordingSizeBytes > 0 ? formatBytes(stats.avgRecordingSizeBytes) : '-' },
        { label: UI_TEXT.static.statsChatFiles, value: String(stats.chatCount), sub: formatBytes(stats.chatBytes) }
    ];

    applyHtml(grid, cards.map((c) => `
        <div class="stats-kpi-card">
            <div class="stats-kpi-label">${escapeHtml(c.label)}</div>
            <div class="stats-kpi-value">${escapeHtml(c.value)}</div>
            ${c.sub ? `<div class="stats-kpi-sub">${escapeHtml(c.sub)}</div>` : ''}
        </div>
    `).join(''));
}

function renderStatsTopStreamers(top: ArchiveStatsTopStreamer[], totalBytes: number): void {
    const container = document.getElementById('statsTopStreamers');
    if (!container) return;

    if (top.length === 0) {
        applyHtml(container, `<div class="form-note">${escapeHtml(UI_TEXT.static.statsEmpty)}</div>`);
        return;
    }

    const maxBytes = top[0].bytes || 1;
    applyHtml(container, top.map((s) => {
        const pct = Math.max(2, Math.round((s.bytes / maxBytes) * 100));
        const sharePct = totalBytes > 0 ? ((s.bytes / totalBytes) * 100).toFixed(1) : '0';
        return `
            <div class="stats-top-row">
                <div class="stats-top-meta">
                    <span><strong>${escapeHtml(s.streamer)}</strong> <span class="stats-top-meta-sub"><span aria-hidden="true">&middot;</span> ${s.fileCount} ${escapeHtml(UI_TEXT.static.statsFiles)}</span></span>
                    <span class="stats-top-meta-sub">${formatBytes(s.bytes)} <span class="stats-top-share">(${sharePct}%)</span></span>
                </div>
                <div class="stats-top-bar-track">
                    <div class="stats-top-bar-fill" style="width: ${pct}%;"></div>
                    ${(s.liveBytes > 0 || s.vodBytes > 0) ? `<div class="stats-top-bar-labels">
                        ${s.liveBytes > 0 ? `LIVE ${formatBytes(s.liveBytes)}` : ''}
                        ${s.vodBytes > 0 ? `VOD ${formatBytes(s.vodBytes)}` : ''}
                    </div>` : ''}
                </div>
            </div>
        `;
    }).join(''));
}

function renderStatsActivity(days: ArchiveStatsDay[]): void {
    const container = document.getElementById('statsActivity');
    if (!container) return;

    if (days.length === 0) {
        container.textContent = UI_TEXT.static.statsEmpty;
        return;
    }

    const maxCount = days.reduce((m, d) => Math.max(m, d.count), 0);
    if (maxCount === 0) {
        applyHtml(container, `<div class="form-note">${escapeHtml(UI_TEXT.static.statsActivityEmpty)}</div>`);
        return;
    }

    const bars = days.map((d, idx) => {
        const heightPct = Math.max(4, Math.round((d.count / maxCount) * 100));
        const tooltip = `${d.date}: ${d.count} ${UI_TEXT.static.statsFiles} - ${formatBytes(d.bytes)}`;
        const showLabel = idx === 0 || idx === days.length - 1 || idx % 7 === 0;
        const dayLabel = showLabel ? d.date.slice(5) : '';
        return `
            <div class="stats-day-col">
                <div class="stats-day-bar-track">
                    <div class="stats-day-bar-fill" style="height: ${heightPct}%;" title="${escapeHtml(tooltip)}"></div>
                </div>
                <div class="stats-day-label">${escapeHtml(dayLabel)}</div>
            </div>
        `;
    }).join('');

    const totalCount = days.reduce((s, d) => s + d.count, 0);
    const totalBytes = days.reduce((s, d) => s + d.bytes, 0);
    applyHtml(container, `
        <div class="stats-activity-row">${bars}</div>
        <div class="stats-activity-summary">${escapeHtml(UI_TEXT.static.statsActivitySummary
            .replace('{count}', String(totalCount))
            .replace('{size}', formatBytes(totalBytes)))}</div>
    `);
}

function renderStatsSizeBuckets(buckets: ArchiveStatsBucket[]): void {
    const container = document.getElementById('statsSizeBuckets');
    if (!container) return;

    const maxCount = buckets.reduce((m, b) => Math.max(m, b.count), 0);
    if (maxCount === 0) {
        applyHtml(container, `<div class="form-note">${escapeHtml(UI_TEXT.static.statsEmpty)}</div>`);
        return;
    }

    applyHtml(container, buckets.map((b) => {
        const pct = b.count > 0 ? Math.max(2, Math.round((b.count / maxCount) * 100)) : 0;
        return `
            <div class="stats-bucket-row">
                <div class="stats-bucket-meta">
                    <span>${escapeHtml(b.label)}</span>
                    <span class="stats-bucket-meta-sub">${b.count} <span aria-hidden="true">&middot;</span> ${formatBytes(b.bytes)}</span>
                </div>
                <div class="stats-bucket-bar-track">
                    <div class="stats-bucket-bar-fill" style="width: ${pct}%;"></div>
                </div>
            </div>
        `;
    }).join(''));
}



(window as unknown as { refreshArchiveStats: typeof refreshArchiveStats }).refreshArchiveStats = refreshArchiveStats;

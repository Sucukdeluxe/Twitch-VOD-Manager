async function init(): Promise<void> {
    config = await window.api.getConfig();
    const initialQueue = await window.api.getQueue();
    queue = Array.isArray(initialQueue) ? initialQueue : [];
    const version = await window.api.getVersion();

    byId('versionText').textContent = `v${version}`;
    byId('versionInfo').textContent = `Version: v${version}`;
    document.title = `Twitch VOD Manager v${version}`;

    byId<HTMLInputElement>('clientId').value = config.client_id ?? '';
    byId<HTMLInputElement>('clientSecret').value = config.client_secret ?? '';
    byId<HTMLInputElement>('downloadPath').value = config.download_path ?? '';
    byId<HTMLSelectElement>('themeSelect').value = config.theme ?? 'twitch';
    byId<HTMLSelectElement>('downloadMode').value = config.download_mode ?? 'full';
    byId<HTMLInputElement>('partMinutes').value = String(config.part_minutes ?? 120);

    changeTheme(config.theme ?? 'twitch');
    renderStreamers();
    renderQueue();
    updateDownloadButtonState();

    window.api.onQueueUpdated((q: QueueItem[]) => {
        queue = Array.isArray(q) ? q : [];
        renderQueue();
    });

    window.api.onDownloadProgress((progress: DownloadProgress) => {
        const item = queue.find((i: QueueItem) => i.id === progress.id);
        if (!item) {
            return;
        }

        item.progress = progress.progress;
        renderQueue();
    });

    window.api.onDownloadStarted(() => {
        downloading = true;
        updateDownloadButtonState();
    });

    window.api.onDownloadFinished(() => {
        downloading = false;
        updateDownloadButtonState();
    });

    window.api.onCutProgress((percent: number) => {
        byId('cutProgressBar').style.width = percent + '%';
        byId('cutProgressText').textContent = Math.round(percent) + '%';
    });

    window.api.onMergeProgress((percent: number) => {
        byId('mergeProgressBar').style.width = percent + '%';
        byId('mergeProgressText').textContent = Math.round(percent) + '%';
    });

    if (config.client_id && config.client_secret) {
        await connect();
    } else {
        updateStatus('Ohne Login (Public Modus)', false);
    }

    if (config.streamers && config.streamers.length > 0) {
        await selectStreamer(config.streamers[0]);
    }

    setTimeout(() => {
        void checkUpdateSilent();
    }, 3000);

    setInterval(() => {
        void syncQueueAndDownloadState();
    }, 2000);
}

function updateDownloadButtonState(): void {
    const btn = byId('btnStart');
    btn.textContent = downloading ? 'Stoppen' : 'Start';
    btn.classList.toggle('downloading', downloading);
}

async function syncQueueAndDownloadState(): Promise<void> {
    const latestQueue = await window.api.getQueue();
    queue = Array.isArray(latestQueue) ? latestQueue : [];
    renderQueue();

    const backendDownloading = await window.api.isDownloading();
    if (backendDownloading !== downloading) {
        downloading = backendDownloading;
        updateDownloadButtonState();
    }
}

function showTab(tab: string): void {
    queryAll('.nav-item').forEach((i) => i.classList.remove('active'));
    queryAll('.tab-content').forEach((c) => c.classList.remove('active'));

    query(`.nav-item[data-tab="${tab}"]`).classList.add('active');
    byId(tab + 'Tab').classList.add('active');

    const titles: Record<string, string> = {
        vods: 'VODs',
        clips: 'Clips',
        cutter: 'Video Cutter',
        merge: 'Videos Zusammenfugen',
        settings: 'Einstellungen'
    };

    byId('pageTitle').textContent = currentStreamer || titles[tab] || 'Twitch VOD Manager';
}

function parseDurationToSeconds(durStr: string): number {
    let seconds = 0;
    const hours = durStr.match(/(\d+)h/);
    const minutes = durStr.match(/(\d+)m/);
    const secs = durStr.match(/(\d+)s/);

    if (hours) seconds += parseInt(hours[1], 10) * 3600;
    if (minutes) seconds += parseInt(minutes[1], 10) * 60;
    if (secs) seconds += parseInt(secs[1], 10);

    return seconds;
}

function formatSecondsToTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatSecondsToTimeDashed(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}-${m.toString().padStart(2, '0')}-${s.toString().padStart(2, '0')}`;
}

function parseTimeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':').map((p: string) => parseInt(p, 10) || 0);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    return 0;
}

function openClipDialog(url: string, title: string, date: string, streamer: string, duration: string): void {
    clipDialogData = { url, title, date, streamer, duration };
    clipTotalSeconds = parseDurationToSeconds(duration);

    byId('clipDialogTitle').textContent = `Clip zuschneiden (${duration})`;
    byId<HTMLInputElement>('clipStartSlider').max = String(clipTotalSeconds);
    byId<HTMLInputElement>('clipEndSlider').max = String(clipTotalSeconds);
    byId<HTMLInputElement>('clipStartSlider').value = '0';
    byId<HTMLInputElement>('clipEndSlider').value = String(Math.min(60, clipTotalSeconds));

    byId<HTMLInputElement>('clipStartTime').value = '00:00:00';
    byId<HTMLInputElement>('clipEndTime').value = formatSecondsToTime(Math.min(60, clipTotalSeconds));
    byId<HTMLInputElement>('clipStartPart').value = '';

    updateClipDuration();
    updateFilenameExamples();
    byId('clipModal').classList.add('show');
}

function closeClipDialog(): void {
    byId('clipModal').classList.remove('show');
    clipDialogData = null;
}

function updateFromSlider(which: string): void {
    const startSlider = byId<HTMLInputElement>('clipStartSlider');
    const endSlider = byId<HTMLInputElement>('clipEndSlider');

    if (which === 'start') {
        byId<HTMLInputElement>('clipStartTime').value = formatSecondsToTime(parseInt(startSlider.value, 10));
    } else {
        byId<HTMLInputElement>('clipEndTime').value = formatSecondsToTime(parseInt(endSlider.value, 10));
    }

    updateClipDuration();
}

function updateFromInput(which: string): void {
    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);

    if (which === 'start') {
        byId<HTMLInputElement>('clipStartSlider').value = String(Math.max(0, Math.min(startSec, clipTotalSeconds)));
    } else {
        byId<HTMLInputElement>('clipEndSlider').value = String(Math.max(0, Math.min(endSec, clipTotalSeconds)));
    }

    updateClipDuration();
}

function updateClipDuration(): void {
    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const duration = endSec - startSec;
    const durationDisplay = byId('clipDurationDisplay');

    if (duration > 0) {
        durationDisplay.textContent = formatSecondsToTime(duration);
        durationDisplay.style.color = '#00c853';
    } else {
        durationDisplay.textContent = 'Ungultig!';
        durationDisplay.style.color = '#ff4444';
    }

    updateFilenameExamples();
}

function updateFilenameExamples(): void {
    if (!clipDialogData) {
        return;
    }

    const date = new Date(clipDialogData.date);
    const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;
    const partNum = byId<HTMLInputElement>('clipStartPart').value || '1';
    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const timeStr = formatSecondsToTimeDashed(startSec);

    byId('formatSimple').textContent = `${dateStr}_${partNum}.mp4 (Standard)`;
    byId('formatTimestamp').textContent = `${dateStr}_CLIP_${timeStr}_${partNum}.mp4 (mit Zeitstempel)`;
}

async function confirmClipDialog(): Promise<void> {
    if (!clipDialogData) {
        return;
    }

    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const startPartStr = byId<HTMLInputElement>('clipStartPart').value.trim();
    const startPart = startPartStr ? parseInt(startPartStr, 10) : 1;
    const filenameFormat = query<HTMLInputElement>('input[name="filenameFormat"]:checked').value as 'simple' | 'timestamp';

    if (endSec <= startSec) {
        alert('Endzeit muss grosser als Startzeit sein!');
        return;
    }

    if (startSec < 0 || endSec > clipTotalSeconds) {
        alert('Zeit ausserhalb des VOD-Bereichs!');
        return;
    }

    const durationSec = endSec - startSec;

    queue = await window.api.addToQueue({
        url: clipDialogData.url,
        title: clipDialogData.title,
        date: clipDialogData.date,
        streamer: clipDialogData.streamer,
        duration_str: clipDialogData.duration,
        customClip: {
            startSec,
            durationSec,
            startPart,
            filenameFormat
        }
    });

    renderQueue();
    closeClipDialog();
}

async function downloadClip(): Promise<void> {
    const url = byId<HTMLInputElement>('clipUrl').value.trim();
    const status = byId('clipStatus');
    const btn = byId('btnClip');

    if (!url) {
        status.textContent = 'Bitte URL eingeben';
        status.className = 'clip-status error';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Lade...';
    status.textContent = 'Download lauft...';
    status.className = 'clip-status loading';

    const result = await window.api.downloadClip(url);

    btn.disabled = false;
    btn.textContent = 'Clip herunterladen';

    if (result.success) {
        status.textContent = 'Download erfolgreich!';
        status.className = 'clip-status success';
        return;
    }

    status.textContent = 'Fehler: ' + (result.error || 'Unbekannter Fehler');
    status.className = 'clip-status error';
}

async function selectCutterVideo(): Promise<void> {
    const filePath = await window.api.selectVideoFile();
    if (!filePath) {
        return;
    }

    cutterFile = filePath;
    byId<HTMLInputElement>('cutterFilePath').value = filePath;

    const info = await window.api.getVideoInfo(filePath);
    if (!info) {
        alert('Konnte Video-Informationen nicht lesen. FFprobe installiert?');
        return;
    }

    cutterVideoInfo = info;
    cutterStartTime = 0;
    cutterEndTime = info.duration;

    byId('cutterInfo').style.display = 'flex';
    byId('timelineContainer').style.display = 'block';
    byId('btnCut').disabled = false;

    byId('infoDuration').textContent = formatTime(info.duration);
    byId('infoResolution').textContent = `${info.width}x${info.height}`;
    byId('infoFps').textContent = Math.round(info.fps);
    byId('infoSelection').textContent = formatTime(info.duration);

    byId<HTMLInputElement>('startTime').value = '00:00:00';
    byId<HTMLInputElement>('endTime').value = formatTime(info.duration);

    updateTimeline();
    await updatePreview(0);
}

function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function parseTime(timeStr: string): number {
    const parts = timeStr.split(':').map((p: string) => parseInt(p, 10) || 0);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    return 0;
}

function updateTimeline(): void {
    if (!cutterVideoInfo) {
        return;
    }

    const selection = byId('timelineSelection');
    const startPercent = (cutterStartTime / cutterVideoInfo.duration) * 100;
    const endPercent = (cutterEndTime / cutterVideoInfo.duration) * 100;

    selection.style.left = startPercent + '%';
    selection.style.width = (endPercent - startPercent) + '%';

    const duration = cutterEndTime - cutterStartTime;
    byId('infoSelection').textContent = formatTime(duration);
}

function updateTimeFromInput(): void {
    const startStr = byId<HTMLInputElement>('startTime').value;
    const endStr = byId<HTMLInputElement>('endTime').value;

    cutterStartTime = Math.max(0, parseTime(startStr));
    cutterEndTime = Math.min(cutterVideoInfo?.duration || 0, parseTime(endStr));

    if (cutterEndTime <= cutterStartTime) {
        cutterEndTime = cutterStartTime + 1;
    }

    updateTimeline();
}

async function seekTimeline(event: MouseEvent): Promise<void> {
    if (!cutterVideoInfo) {
        return;
    }

    const timeline = byId<HTMLElement>('timeline');
    const rect = timeline.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    const time = percent * cutterVideoInfo.duration;

    byId('timelineCurrent').style.left = (percent * 100) + '%';
    await updatePreview(time);
}

async function updatePreview(time: number): Promise<void> {
    if (!cutterFile) {
        return;
    }

    const preview = byId('cutterPreview');
    preview.innerHTML = '<div class="placeholder"><p>Lade Vorschau...</p></div>';

    const frame = await window.api.extractFrame(cutterFile, time);
    if (frame) {
        preview.innerHTML = `<img src="${frame}" alt="Preview">`;
        return;
    }

    preview.innerHTML = '<div class="placeholder"><p>Vorschau nicht verfugbar</p></div>';
}

async function startCutting(): Promise<void> {
    if (!cutterFile || isCutting) {
        return;
    }

    isCutting = true;
    byId('btnCut').disabled = true;
    byId('btnCut').textContent = 'Schneidet...';
    byId('cutProgress').classList.add('show');

    const result = await window.api.cutVideo(cutterFile, cutterStartTime, cutterEndTime);

    isCutting = false;
    byId('btnCut').disabled = false;
    byId('btnCut').textContent = 'Schneiden';
    byId('cutProgress').classList.remove('show');

    if (result.success) {
        alert('Video erfolgreich geschnitten!\n\n' + result.outputFile);
        return;
    }

    alert('Fehler beim Schneiden des Videos.');
}

async function addMergeFiles(): Promise<void> {
    const files = await window.api.selectMultipleVideos();
    if (!files || files.length === 0) {
        return;
    }

    mergeFiles = [...mergeFiles, ...files];
    renderMergeFiles();
}

function renderMergeFiles(): void {
    const list = byId('mergeFileList');
    byId('btnMerge').disabled = mergeFiles.length < 2;

    if (mergeFiles.length === 0) {
        list.innerHTML = `
            <div class="empty-state" style="padding: 40px 20px;">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.3"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                <p style="margin-top:10px">Keine Videos ausgewahlt</p>
            </div>
        `;
        return;
    }

    list.innerHTML = mergeFiles.map((file: string, index: number) => {
        const name = file.split(/[/\\]/).pop();
        return `
            <div class="file-item" draggable="true" data-index="${index}">
                <div class="file-order">${index + 1}</div>
                <div class="file-name" title="${file}">${name}</div>
                <div class="file-actions">
                    <button class="file-btn" onclick="moveMergeFile(${index}, -1)" ${index === 0 ? 'disabled' : ''}>&#9650;</button>
                    <button class="file-btn" onclick="moveMergeFile(${index}, 1)" ${index === mergeFiles.length - 1 ? 'disabled' : ''}>&#9660;</button>
                    <button class="file-btn remove" onclick="removeMergeFile(${index})">x</button>
                </div>
            </div>
        `;
    }).join('');
}

function moveMergeFile(index: number, direction: number): void {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= mergeFiles.length) {
        return;
    }

    const temp = mergeFiles[index];
    mergeFiles[index] = mergeFiles[newIndex];
    mergeFiles[newIndex] = temp;
    renderMergeFiles();
}

function removeMergeFile(index: number): void {
    mergeFiles.splice(index, 1);
    renderMergeFiles();
}

async function startMerging(): Promise<void> {
    if (mergeFiles.length < 2 || isMerging) {
        return;
    }

    const outputFile = await window.api.saveVideoDialog('merged_video.mp4');
    if (!outputFile) {
        return;
    }

    isMerging = true;
    byId('btnMerge').disabled = true;
    byId('btnMerge').textContent = 'Zusammenfugen...';
    byId('mergeProgress').classList.add('show');

    const result = await window.api.mergeVideos(mergeFiles, outputFile);

    isMerging = false;
    byId('btnMerge').disabled = false;
    byId('btnMerge').textContent = 'Zusammenfugen';
    byId('mergeProgress').classList.remove('show');

    if (result.success) {
        alert('Videos erfolgreich zusammengefugt!\n\n' + result.outputFile);
        mergeFiles = [];
        renderMergeFiles();
        return;
    }

    alert('Fehler beim Zusammenfugen der Videos.');
}

void init();

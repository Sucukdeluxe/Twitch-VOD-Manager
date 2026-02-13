// @ts-nocheck

// State
let config = {};
let currentStreamer = null;
let isConnected = false;
let downloading = false;
let queue = [];

// Cutter State
let cutterFile = null;
let cutterVideoInfo = null;
let cutterStartTime = 0;
let cutterEndTime = 0;
let isCutting = false;

// Merge State
let mergeFiles = [];
let isMerging = false;

// Init
async function init() {
    config = await window.api.getConfig();
    queue = await window.api.getQueue();
    const version = await window.api.getVersion();

    document.getElementById('versionText').textContent = `v${version}`;
    document.getElementById('versionInfo').textContent = `Version: v${version}`;
    document.title = `Twitch VOD Manager v${version}`;
    document.getElementById('clientId').value = config.client_id || '';
    document.getElementById('clientSecret').value = config.client_secret || '';
    document.getElementById('downloadPath').value = config.download_path || '';
    document.getElementById('themeSelect').value = config.theme || 'twitch';
    document.getElementById('downloadMode').value = config.download_mode || 'full';
    document.getElementById('partMinutes').value = config.part_minutes || 120;

    changeTheme(config.theme || 'twitch');
    renderStreamers();
    renderQueue();

    if (config.client_id && config.client_secret) {
        await connect();
        // Auto-select first streamer if available
        if (config.streamers && config.streamers.length > 0) {
            selectStreamer(config.streamers[0]);
        }
    }

    // Event listeners
    window.api.onQueueUpdated((q) => {
        queue = q;
        renderQueue();
    });

    window.api.onDownloadProgress((progress) => {
        const item = queue.find(i => i.id === progress.id);
        if (item) {
            item.progress = progress.progress;
            renderQueue();
        }
    });

    window.api.onDownloadStarted(() => {
        downloading = true;
        document.getElementById('btnStart').textContent = 'Stoppen';
        document.getElementById('btnStart').classList.add('downloading');
    });

    window.api.onDownloadFinished(() => {
        downloading = false;
        document.getElementById('btnStart').textContent = 'Start';
        document.getElementById('btnStart').classList.remove('downloading');
    });

    window.api.onCutProgress((percent) => {
        document.getElementById('cutProgressBar').style.width = percent + '%';
        document.getElementById('cutProgressText').textContent = Math.round(percent) + '%';
    });

    window.api.onMergeProgress((percent) => {
        document.getElementById('mergeProgressBar').style.width = percent + '%';
        document.getElementById('mergeProgressText').textContent = Math.round(percent) + '%';
    });

    setTimeout(checkUpdateSilent, 3000);
}

async function connect() {
    updateStatus('Verbinde...', false);
    const success = await window.api.login();
    isConnected = success;
    updateStatus(success ? 'Verbunden' : 'Verbindung fehlgeschlagen', success);
}

function updateStatus(text, connected) {
    document.getElementById('statusText').textContent = text;
    const dot = document.getElementById('statusDot');
    dot.classList.remove('connected', 'error');
    dot.classList.add(connected ? 'connected' : 'error');
}

// Navigation
function showTab(tab) {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    document.querySelector(`.nav-item[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(tab + 'Tab').classList.add('active');

    const titles = {
        vods: 'VODs',
        clips: 'Clips',
        cutter: 'Video Cutter',
        merge: 'Videos Zusammenfugen',
        settings: 'Einstellungen'
    };
    document.getElementById('pageTitle').textContent = currentStreamer || titles[tab];
}

// Streamers
function renderStreamers() {
    const list = document.getElementById('streamerList');
    list.innerHTML = '';

    (config.streamers || []).forEach(streamer => {
        const item = document.createElement('div');
        item.className = 'streamer-item' + (currentStreamer === streamer ? ' active' : '');
        item.innerHTML = `
            <span>${streamer}</span>
            <span class="remove" onclick="event.stopPropagation(); removeStreamer('${streamer}')">x</span>
        `;
        item.onclick = () => selectStreamer(streamer);
        list.appendChild(item);
    });
}

async function addStreamer() {
    const input = document.getElementById('newStreamer');
    const name = input.value.trim().toLowerCase();
    if (!name || (config.streamers || []).includes(name)) return;

    config.streamers = [...(config.streamers || []), name];
    config = await window.api.saveConfig({ streamers: config.streamers });
    input.value = '';
    renderStreamers();
    selectStreamer(name);
}

async function removeStreamer(name) {
    config.streamers = (config.streamers || []).filter(s => s !== name);
    config = await window.api.saveConfig({ streamers: config.streamers });
    renderStreamers();
    if (currentStreamer === name) {
        currentStreamer = null;
        document.getElementById('vodGrid').innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-4 5-4v8zm2-8l5 4-5 4V9z"/></svg>
                <h3>Keine VODs</h3>
                <p>Wahle einen Streamer aus der Liste.</p>
            </div>
        `;
    }
}

async function selectStreamer(name) {
    currentStreamer = name;
    renderStreamers();
    document.getElementById('pageTitle').textContent = name;

    if (!isConnected) {
        await connect();
        if (!isConnected) {
            document.getElementById('vodGrid').innerHTML = '<div class="empty-state"><h3>Nicht verbunden</h3><p>Bitte Twitch API Daten in den Einstellungen prufen.</p></div>';
            return;
        }
    }

    document.getElementById('vodGrid').innerHTML = '<div class="empty-state"><p>Lade VODs...</p></div>';

    const userId = await window.api.getUserId(name);
    if (!userId) {
        document.getElementById('vodGrid').innerHTML = '<div class="empty-state"><h3>Streamer nicht gefunden</h3></div>';
        return;
    }

    const vods = await window.api.getVODs(userId);
    renderVODs(vods, name);
}

function renderVODs(vods, streamer) {
    const grid = document.getElementById('vodGrid');

    if (!vods || vods.length === 0) {
        grid.innerHTML = '<div class="empty-state"><h3>Keine VODs gefunden</h3><p>Dieser Streamer hat keine VODs.</p></div>';
        return;
    }

    grid.innerHTML = vods.map(vod => {
        const thumb = vod.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180');
        const date = new Date(vod.created_at).toLocaleDateString('de-DE');
        const escapedTitle = vod.title.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        return `
            <div class="vod-card">
                <img class="vod-thumbnail" src="${thumb}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 320 180%22><rect fill=%22%23333%22 width=%22320%22 height=%22180%22/></svg>'">
                <div class="vod-info">
                    <div class="vod-title">${vod.title}</div>
                    <div class="vod-meta">
                        <span>${date}</span>
                        <span>${vod.duration}</span>
                        <span>${vod.view_count.toLocaleString()} Views</span>
                    </div>
                </div>
                <div class="vod-actions">
                    <button class="vod-btn secondary" onclick="openClipDialog('${vod.url}', '${escapedTitle}', '${vod.created_at}', '${streamer}', '${vod.duration}')">Clip</button>
                    <button class="vod-btn primary" onclick="addToQueue('${vod.url}', '${escapedTitle}', '${vod.created_at}', '${streamer}', '${vod.duration}')">+ Queue</button>
                </div>
            </div>
        `;
    }).join('');
}

async function refreshVODs() {
    if (currentStreamer) {
        await selectStreamer(currentStreamer);
    }
}

// Queue
async function addToQueue(url, title, date, streamer, duration) {
    queue = await window.api.addToQueue({ url, title, date, streamer, duration_str: duration });
    renderQueue();
}

async function removeFromQueue(id) {
    queue = await window.api.removeFromQueue(id);
    renderQueue();
}

async function clearCompleted() {
    queue = await window.api.clearCompleted();
    renderQueue();
}

function renderQueue() {
    const list = document.getElementById('queueList');
    document.getElementById('queueCount').textContent = queue.length;

    if (queue.length === 0) {
        list.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px; text-align: center; padding: 15px;">Keine Downloads in der Warteschlange</div>';
        return;
    }

    list.innerHTML = queue.map(item => {
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

async function toggleDownload() {
    if (downloading) {
        await window.api.cancelDownload();
    } else {
        await window.api.startDownload();
    }
}

// Clip Dialog
let clipDialogData = null;
let clipTotalSeconds = 0;

function parseDurationToSeconds(durStr) {
    let seconds = 0;
    const hours = durStr.match(/(\d+)h/);
    const minutes = durStr.match(/(\d+)m/);
    const secs = durStr.match(/(\d+)s/);
    if (hours) seconds += parseInt(hours[1]) * 3600;
    if (minutes) seconds += parseInt(minutes[1]) * 60;
    if (secs) seconds += parseInt(secs[1]);
    return seconds;
}

function formatSecondsToTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatSecondsToTimeDashed(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}-${m.toString().padStart(2, '0')}-${s.toString().padStart(2, '0')}`;
}

function parseTimeToSeconds(timeStr) {
    const parts = timeStr.split(':').map(p => parseInt(p) || 0);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

function openClipDialog(url, title, date, streamer, duration) {
    clipDialogData = { url, title, date, streamer, duration };
    clipTotalSeconds = parseDurationToSeconds(duration);

    document.getElementById('clipDialogTitle').textContent = 'Clip zuschneiden (' + duration + ')';

    // Setup sliders
    document.getElementById('clipStartSlider').max = clipTotalSeconds;
    document.getElementById('clipEndSlider').max = clipTotalSeconds;
    document.getElementById('clipStartSlider').value = 0;
    document.getElementById('clipEndSlider').value = Math.min(60, clipTotalSeconds);

    document.getElementById('clipStartTime').value = '00:00:00';
    document.getElementById('clipEndTime').value = formatSecondsToTime(Math.min(60, clipTotalSeconds));
    document.getElementById('clipStartPart').value = '';

    updateClipDuration();
    updateFilenameExamples();
    document.getElementById('clipModal').classList.add('show');
}

function closeClipDialog() {
    document.getElementById('clipModal').classList.remove('show');
    clipDialogData = null;
}

function updateFromSlider(which) {
    const startSlider = document.getElementById('clipStartSlider');
    const endSlider = document.getElementById('clipEndSlider');

    if (which === 'start') {
        document.getElementById('clipStartTime').value = formatSecondsToTime(parseInt(startSlider.value));
    } else {
        document.getElementById('clipEndTime').value = formatSecondsToTime(parseInt(endSlider.value));
    }

    updateClipDuration();
}

function updateFromInput(which) {
    const startSec = parseTimeToSeconds(document.getElementById('clipStartTime').value);
    const endSec = parseTimeToSeconds(document.getElementById('clipEndTime').value);

    if (which === 'start') {
        document.getElementById('clipStartSlider').value = Math.max(0, Math.min(startSec, clipTotalSeconds));
    } else {
        document.getElementById('clipEndSlider').value = Math.max(0, Math.min(endSec, clipTotalSeconds));
    }

    updateClipDuration();
}

function updateClipDuration() {
    const startSec = parseTimeToSeconds(document.getElementById('clipStartTime').value);
    const endSec = parseTimeToSeconds(document.getElementById('clipEndTime').value);
    const duration = endSec - startSec;
    const durationDisplay = document.getElementById('clipDurationDisplay');

    if (duration > 0) {
        durationDisplay.textContent = formatSecondsToTime(duration);
        durationDisplay.style.color = '#00c853';
    } else {
        durationDisplay.textContent = 'Ungultig!';
        durationDisplay.style.color = '#ff4444';
    }

    updateFilenameExamples();
}

function updateFilenameExamples() {
    if (!clipDialogData) return;

    const date = new Date(clipDialogData.date);
    const dateStr = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;
    const partNum = document.getElementById('clipStartPart').value || '1';
    const startSec = parseTimeToSeconds(document.getElementById('clipStartTime').value);
    const timeStr = formatSecondsToTimeDashed(startSec);

    document.getElementById('formatSimple').textContent = `${dateStr}_${partNum}.mp4 (Standard)`;
    document.getElementById('formatTimestamp').textContent = `${dateStr}_CLIP_${timeStr}_${partNum}.mp4 (mit Zeitstempel)`;
}

async function confirmClipDialog() {
    if (!clipDialogData) return;

    const startSec = parseTimeToSeconds(document.getElementById('clipStartTime').value);
    const endSec = parseTimeToSeconds(document.getElementById('clipEndTime').value);
    const startPartStr = document.getElementById('clipStartPart').value.trim();
    const startPart = startPartStr ? parseInt(startPartStr) : 1;
    const filenameFormat = document.querySelector('input[name="filenameFormat"]:checked').value;

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
            startSec: startSec,
            durationSec: durationSec,
            startPart: startPart,
            filenameFormat: filenameFormat
        }
    });

    renderQueue();
    closeClipDialog();
}

// Settings
async function saveSettings() {
    const clientId = document.getElementById('clientId').value.trim();
    const clientSecret = document.getElementById('clientSecret').value.trim();
    const downloadPath = document.getElementById('downloadPath').value;
    const downloadMode = document.getElementById('downloadMode').value;
    const partMinutes = parseInt(document.getElementById('partMinutes').value);

    config = await window.api.saveConfig({
        client_id: clientId,
        client_secret: clientSecret,
        download_path: downloadPath,
        download_mode: downloadMode,
        part_minutes: partMinutes
    });

    await connect();
}

async function selectFolder() {
    const folder = await window.api.selectFolder();
    if (folder) {
        document.getElementById('downloadPath').value = folder;
        config = await window.api.saveConfig({ download_path: folder });
    }
}

function openFolder() {
    window.api.openFolder(config.download_path);
}

function changeTheme(theme) {
    document.body.className = `theme-${theme}`;
    window.api.saveConfig({ theme });
}

// Clips
async function downloadClip() {
    const url = document.getElementById('clipUrl').value.trim();
    const status = document.getElementById('clipStatus');
    const btn = document.getElementById('btnClip');

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
    } else {
        status.textContent = 'Fehler: ' + result.error;
        status.className = 'clip-status error';
    }
}

// Video Cutter
async function selectCutterVideo() {
    const filePath = await window.api.selectVideoFile();
    if (!filePath) return;

    cutterFile = filePath;
    document.getElementById('cutterFilePath').value = filePath;

    const info = await window.api.getVideoInfo(filePath);
    if (!info) {
        alert('Konnte Video-Informationen nicht lesen. FFprobe installiert?');
        return;
    }

    cutterVideoInfo = info;
    cutterStartTime = 0;
    cutterEndTime = info.duration;

    document.getElementById('cutterInfo').style.display = 'flex';
    document.getElementById('timelineContainer').style.display = 'block';
    document.getElementById('btnCut').disabled = false;

    document.getElementById('infoDuration').textContent = formatTime(info.duration);
    document.getElementById('infoResolution').textContent = `${info.width}x${info.height}`;
    document.getElementById('infoFps').textContent = Math.round(info.fps);
    document.getElementById('infoSelection').textContent = formatTime(info.duration);

    document.getElementById('startTime').value = '00:00:00';
    document.getElementById('endTime').value = formatTime(info.duration);

    updateTimeline();
    await updatePreview(0);
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function parseTime(timeStr) {
    const parts = timeStr.split(':').map(p => parseInt(p) || 0);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

function updateTimeline() {
    if (!cutterVideoInfo) return;

    const selection = document.getElementById('timelineSelection');
    const startPercent = (cutterStartTime / cutterVideoInfo.duration) * 100;
    const endPercent = (cutterEndTime / cutterVideoInfo.duration) * 100;

    selection.style.left = startPercent + '%';
    selection.style.width = (endPercent - startPercent) + '%';

    const duration = cutterEndTime - cutterStartTime;
    document.getElementById('infoSelection').textContent = formatTime(duration);
}

function updateTimeFromInput() {
    const startStr = document.getElementById('startTime').value;
    const endStr = document.getElementById('endTime').value;

    cutterStartTime = Math.max(0, parseTime(startStr));
    cutterEndTime = Math.min(cutterVideoInfo?.duration || 0, parseTime(endStr));

    if (cutterEndTime <= cutterStartTime) {
        cutterEndTime = cutterStartTime + 1;
    }

    updateTimeline();
}

async function seekTimeline(event) {
    if (!cutterVideoInfo) return;

    const timeline = document.getElementById('timeline');
    const rect = timeline.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    const time = percent * cutterVideoInfo.duration;

    document.getElementById('timelineCurrent').style.left = (percent * 100) + '%';
    await updatePreview(time);
}

async function updatePreview(time) {
    if (!cutterFile) return;

    const preview = document.getElementById('cutterPreview');
    preview.innerHTML = '<div class="placeholder"><p>Lade Vorschau...</p></div>';

    const frame = await window.api.extractFrame(cutterFile, time);
    if (frame) {
        preview.innerHTML = `<img src="${frame}" alt="Preview">`;
    } else {
        preview.innerHTML = '<div class="placeholder"><p>Vorschau nicht verfugbar</p></div>';
    }
}

async function startCutting() {
    if (!cutterFile || isCutting) return;

    isCutting = true;
    document.getElementById('btnCut').disabled = true;
    document.getElementById('btnCut').textContent = 'Schneidet...';
    document.getElementById('cutProgress').classList.add('show');

    const result = await window.api.cutVideo(cutterFile, cutterStartTime, cutterEndTime);

    isCutting = false;
    document.getElementById('btnCut').disabled = false;
    document.getElementById('btnCut').textContent = 'Schneiden';
    document.getElementById('cutProgress').classList.remove('show');

    if (result.success) {
        alert('Video erfolgreich geschnitten!\n\n' + result.outputFile);
    } else {
        alert('Fehler beim Schneiden des Videos.');
    }
}

// Merge Videos
async function addMergeFiles() {
    const files = await window.api.selectMultipleVideos();
    if (files && files.length > 0) {
        mergeFiles = [...mergeFiles, ...files];
        renderMergeFiles();
    }
}

function renderMergeFiles() {
    const list = document.getElementById('mergeFileList');
    document.getElementById('btnMerge').disabled = mergeFiles.length < 2;

    if (mergeFiles.length === 0) {
        list.innerHTML = `
            <div class="empty-state" style="padding: 40px 20px;">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.3"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                <p style="margin-top:10px">Keine Videos ausgewahlt</p>
            </div>
        `;
        return;
    }

    list.innerHTML = mergeFiles.map((file, index) => {
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

function moveMergeFile(index, direction) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= mergeFiles.length) return;

    const temp = mergeFiles[index];
    mergeFiles[index] = mergeFiles[newIndex];
    mergeFiles[newIndex] = temp;
    renderMergeFiles();
}

function removeMergeFile(index) {
    mergeFiles.splice(index, 1);
    renderMergeFiles();
}

async function startMerging() {
    if (mergeFiles.length < 2 || isMerging) return;

    const outputFile = await window.api.saveVideoDialog('merged_video.mp4');
    if (!outputFile) return;

    isMerging = true;
    document.getElementById('btnMerge').disabled = true;
    document.getElementById('btnMerge').textContent = 'Zusammenfugen...';
    document.getElementById('mergeProgress').classList.add('show');

    const result = await window.api.mergeVideos(mergeFiles, outputFile);

    isMerging = false;
    document.getElementById('btnMerge').disabled = false;
    document.getElementById('btnMerge').textContent = 'Zusammenfugen';
    document.getElementById('mergeProgress').classList.remove('show');

    if (result.success) {
        alert('Videos erfolgreich zusammengefugt!\n\n' + result.outputFile);
        mergeFiles = [];
        renderMergeFiles();
    } else {
        alert('Fehler beim Zusammenfugen der Videos.');
    }
}

// Updates - wird jetzt automatisch vom main process via Events gesteuert
async function checkUpdateSilent() {
    // Auto-Updater läuft automatisch beim App-Start
    await window.api.checkUpdate();
}

async function checkUpdate() {
    // Manueller Check - zeigt Info wenn kein Update
    await window.api.checkUpdate();
    // Wenn kein Update, kommt kein Event - kurz warten dann Info zeigen
    setTimeout(() => {
        if (document.getElementById('updateBanner').style.display !== 'flex') {
            alert('Du hast die neueste Version!');
        }
    }, 2000);
}

let updateReady = false;

function downloadUpdate() {
    if (updateReady) {
        // Update ist heruntergeladen - installieren
        window.api.installUpdate();
    } else {
        // Update herunterladen
        document.getElementById('updateButton').textContent = 'Wird heruntergeladen...';
        document.getElementById('updateButton').disabled = true;
        document.getElementById('updateProgress').style.display = 'block';
        // Start animated progress bar
        document.getElementById('updateProgressBar').classList.add('downloading');
        window.api.downloadUpdate();
    }
}

// Auto-Update Event Listeners
window.api.onUpdateAvailable((info) => {
    document.getElementById('updateBanner').style.display = 'flex';
    document.getElementById('updateText').textContent = `Version ${info.version} verfügbar!`;
    document.getElementById('updateButton').textContent = 'Jetzt herunterladen';
});

window.api.onUpdateDownloadProgress((progress) => {
    const bar = document.getElementById('updateProgressBar');
    bar.classList.remove('downloading');
    bar.style.width = progress.percent + '%';
    const mb = (progress.transferred / 1024 / 1024).toFixed(1);
    const totalMb = (progress.total / 1024 / 1024).toFixed(1);
    document.getElementById('updateText').textContent = `Download: ${mb} / ${totalMb} MB (${progress.percent.toFixed(0)}%)`;
});

window.api.onUpdateDownloaded((info) => {
    updateReady = true;
    const bar = document.getElementById('updateProgressBar');
    bar.classList.remove('downloading');
    bar.style.width = '100%';
    document.getElementById('updateText').textContent = `Version ${info.version} bereit zur Installation!`;
    document.getElementById('updateButton').textContent = 'Jetzt installieren';
    document.getElementById('updateButton').disabled = false;
});

// Start
init();

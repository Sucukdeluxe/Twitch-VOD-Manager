async function init(): Promise<void> {
    config = await window.api.getConfig();
    const language = setLanguage((config.language as string) || 'en');
    config.language = language;
    const initialQueue = await window.api.getQueue();
    queue = Array.isArray(initialQueue) ? initialQueue : [];
    const version = await window.api.getVersion();

    byId('versionText').textContent = `v${version}`;
    byId('versionInfo').textContent = `Version: v${version}`;
    document.title = `${UI_TEXT.appName} v${version}`;

    byId<HTMLInputElement>('clientId').value = config.client_id ?? '';
    byId<HTMLInputElement>('clientSecret').value = config.client_secret ?? '';
    byId<HTMLInputElement>('downloadPath').value = config.download_path ?? '';
    byId<HTMLSelectElement>('themeSelect').value = config.theme ?? 'twitch';
    byId<HTMLSelectElement>('languageSelect').value = config.language ?? 'en';
    updateLanguagePicker(config.language ?? 'en');
    byId<HTMLSelectElement>('downloadMode').value = config.download_mode ?? 'full';
    byId<HTMLInputElement>('partMinutes').value = String(config.part_minutes ?? 120);
    byId<HTMLInputElement>('vodFilenameTemplate').value = (config.filename_template_vod as string) || DEFAULT_VOD_TEMPLATE;
    byId<HTMLInputElement>('partsFilenameTemplate').value = (config.filename_template_parts as string) || DEFAULT_PARTS_TEMPLATE;
    byId<HTMLInputElement>('defaultClipFilenameTemplate').value = (config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE;

    changeTheme(config.theme ?? 'twitch');
    renderStreamers();
    renderQueue();
    updateDownloadButtonState();

    window.api.onQueueUpdated((q: QueueItem[]) => {
        queue = mergeQueueState(Array.isArray(q) ? q : []);
        renderQueue();
    });

    window.api.onDownloadProgress((progress: DownloadProgress) => {
        const item = queue.find((i: QueueItem) => i.id === progress.id);
        if (!item) {
            return;
        }

        item.status = 'downloading';
        item.progress = progress.progress;
        item.speed = progress.speed;
        item.eta = progress.eta;
        item.currentPart = progress.currentPart;
        item.totalParts = progress.totalParts;
        item.downloadedBytes = progress.downloadedBytes;
        item.totalBytes = progress.totalBytes;
        item.progressStatus = progress.status;
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
        updateStatus(UI_TEXT.status.noLogin, false);
    }

    if (config.streamers && config.streamers.length > 0) {
        await selectStreamer(config.streamers[0]);
    }

    setTimeout(() => {
        void checkUpdateSilent();
    }, 3000);

    void runPreflight(false);
    void refreshDebugLog();

    setInterval(() => {
        void syncQueueAndDownloadState();
    }, 2000);
}

function mergeQueueState(nextQueue: QueueItem[]): QueueItem[] {
    const prevById = new Map(queue.map((item) => [item.id, item]));

    return nextQueue.map((item) => {
        const prev = prevById.get(item.id);
        if (!prev) {
            return item;
        }

        if (item.status !== 'downloading') {
            return item;
        }

        return {
            ...item,
            progress: item.progress > 0 ? item.progress : prev.progress,
            speed: item.speed || prev.speed,
            eta: item.eta || prev.eta,
            currentPart: item.currentPart || prev.currentPart,
            totalParts: item.totalParts || prev.totalParts,
            downloadedBytes: item.downloadedBytes || prev.downloadedBytes,
            totalBytes: item.totalBytes || prev.totalBytes,
            progressStatus: item.progressStatus || prev.progressStatus
        };
    });
}

function updateDownloadButtonState(): void {
    const btn = byId('btnStart');
    const hasPaused = queue.some((item) => item.status === 'paused');
    btn.textContent = downloading ? UI_TEXT.queue.stop : (hasPaused ? UI_TEXT.queue.resume : UI_TEXT.queue.start);
    btn.classList.toggle('downloading', downloading);
}

async function syncQueueAndDownloadState(): Promise<void> {
    const latestQueue = await window.api.getQueue();
    queue = mergeQueueState(Array.isArray(latestQueue) ? latestQueue : []);
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

    const titles: Record<string, string> = UI_TEXT.tabs;

    byId('pageTitle').textContent = currentStreamer || titles[tab] || UI_TEXT.appName;
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

const DEFAULT_VOD_TEMPLATE = '{title}.mp4';
const DEFAULT_PARTS_TEMPLATE = '{date}_Part{part_padded}.mp4';
const DEFAULT_CLIP_TEMPLATE = '{date}_{part}.mp4';

type TemplateGuideSource = 'vod' | 'parts' | 'clip';

let templateGuideSource: TemplateGuideSource = 'vod';

function formatDateWithPattern(date: Date, pattern: string): string {
    const tokenMap: Record<string, string> = {
        yyyy: date.getFullYear().toString(),
        yy: date.getFullYear().toString().slice(-2),
        MM: (date.getMonth() + 1).toString().padStart(2, '0'),
        M: (date.getMonth() + 1).toString(),
        dd: date.getDate().toString().padStart(2, '0'),
        d: date.getDate().toString(),
        HH: date.getHours().toString().padStart(2, '0'),
        H: date.getHours().toString(),
        hh: date.getHours().toString().padStart(2, '0'),
        h: date.getHours().toString(),
        mm: date.getMinutes().toString().padStart(2, '0'),
        m: date.getMinutes().toString(),
        ss: date.getSeconds().toString().padStart(2, '0'),
        s: date.getSeconds().toString()
    };

    return pattern
        .replace(/yyyy|yy|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s/g, (token) => tokenMap[token] ?? token)
        .replace(/\\(.)/g, '$1');
}

function formatSecondsWithPattern(totalSeconds: number, pattern: string): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;

    const tokenMap: Record<string, string> = {
        HH: hours.toString().padStart(2, '0'),
        H: hours.toString(),
        hh: hours.toString().padStart(2, '0'),
        h: hours.toString(),
        mm: minutes.toString().padStart(2, '0'),
        m: minutes.toString(),
        ss: seconds.toString().padStart(2, '0'),
        s: seconds.toString()
    };

    return pattern
        .replace(/HH|H|hh|h|mm|m|ss|s/g, (token) => tokenMap[token] ?? token)
        .replace(/\\(.)/g, '$1');
}

function getSelectedFilenameFormat(): 'simple' | 'timestamp' | 'template' {
    const selected = query<HTMLInputElement>('input[name="filenameFormat"]:checked').value;
    return selected === 'template' ? 'template' : selected === 'timestamp' ? 'timestamp' : 'simple';
}

function updateFilenameTemplateVisibility(): void {
    const selected = getSelectedFilenameFormat();
    const wrap = byId('clipFilenameTemplateWrap');
    wrap.style.display = selected === 'template' ? 'block' : 'none';
}

interface TemplatePreviewContext {
    title: string;
    date: Date;
    streamer: string;
    partNum: string;
    startSec: number;
    durationSec: number;
    totalSec: number;
}

function buildTemplatePreview(template: string, context: TemplatePreviewContext): string {
    const dateStr = `${context.date.getDate().toString().padStart(2, '0')}.${(context.date.getMonth() + 1).toString().padStart(2, '0')}.${context.date.getFullYear()}`;
    const normalizedPart = context.partNum || '1';
    let output = template
        .replace(/\{title\}/g, context.title || 'Untitled')
        .replace(/\{id\}/g, '123456789')
        .replace(/\{channel\}/g, context.streamer || 'streamer')
        .replace(/\{channel_id\}/g, '0')
        .replace(/\{date\}/g, dateStr)
        .replace(/\{part\}/g, normalizedPart)
        .replace(/\{part_padded\}/g, normalizedPart.padStart(2, '0'))
        .replace(/\{trim_start\}/g, formatSecondsToTimeDashed(context.startSec))
        .replace(/\{trim_end\}/g, formatSecondsToTimeDashed(context.startSec + context.durationSec))
        .replace(/\{trim_length\}/g, formatSecondsToTimeDashed(context.durationSec))
        .replace(/\{length\}/g, formatSecondsToTimeDashed(context.totalSec))
        .replace(/\{ext\}/g, 'mp4')
        .replace(/\{random_string\}/g, 'abcd1234');

    output = output.replace(/\{date_custom="(.*?)"\}/g, (_, pattern: string) => formatDateWithPattern(context.date, pattern));
    output = output.replace(/\{trim_start_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.startSec, pattern));
    output = output.replace(/\{trim_end_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.startSec + context.durationSec, pattern));
    output = output.replace(/\{trim_length_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.durationSec, pattern));
    output = output.replace(/\{length_custom="(.*?)"\}/g, (_, pattern: string) => formatSecondsWithPattern(context.totalSec, pattern));

    return output;
}

function getTemplateForSource(source: TemplateGuideSource): string {
    if (source === 'vod') {
        return ((config.filename_template_vod as string) || DEFAULT_VOD_TEMPLATE).trim() || DEFAULT_VOD_TEMPLATE;
    }

    if (source === 'parts') {
        return ((config.filename_template_parts as string) || DEFAULT_PARTS_TEMPLATE).trim() || DEFAULT_PARTS_TEMPLATE;
    }

    const clipField = document.getElementById('clipFilenameTemplate') as HTMLInputElement | null;
    const clipFromDialog = clipField?.value.trim() || '';
    if (clipFromDialog) {
        return clipFromDialog;
    }

    return ((config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE).trim() || DEFAULT_CLIP_TEMPLATE;
}

function getTemplateGuidePreviewContext(source: TemplateGuideSource): { context: TemplatePreviewContext; contextText: string } {
    const now = new Date();
    const sampleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 15, 8);
    const sampleStreamer = currentStreamer || 'sample_streamer';

    if (source === 'clip' && clipDialogData) {
        const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
        const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
        const clipDuration = Math.max(1, endSec - startSec);
        const totalSec = Math.max(1, clipTotalSeconds || parseDurationToSeconds(clipDialogData.duration));

        return {
            context: {
                title: clipDialogData.title || 'Clip Title',
                date: new Date(clipDialogData.date),
                streamer: clipDialogData.streamer || sampleStreamer,
                partNum: byId<HTMLInputElement>('clipStartPart').value.trim() || '1',
                startSec,
                durationSec: clipDuration,
                totalSec
            },
            contextText: UI_TEXT.static.templateGuideContextClipLive
        };
    }

    if (source === 'parts') {
        const partLen = Math.max(60, Number(config.part_minutes ?? 120) * 60);
        return {
            context: {
                title: 'Epic Ranked Session',
                date: sampleDate,
                streamer: sampleStreamer,
                partNum: '3',
                startSec: partLen * 2,
                durationSec: partLen,
                totalSec: partLen * 5
            },
            contextText: UI_TEXT.static.templateGuideContextParts
        };
    }

    if (source === 'clip') {
        return {
            context: {
                title: 'Funny Clip Moment',
                date: sampleDate,
                streamer: sampleStreamer,
                partNum: '1',
                startSec: 95,
                durationSec: 45,
                totalSec: 5400
            },
            contextText: UI_TEXT.static.templateGuideContextClip
        };
    }

    return {
        context: {
            title: 'Epic Ranked Session',
            date: sampleDate,
            streamer: sampleStreamer,
            partNum: '1',
            startSec: 0,
            durationSec: 3 * 3600 + 12 * 60 + 5,
            totalSec: 3 * 3600 + 12 * 60 + 5
        },
        contextText: UI_TEXT.static.templateGuideContextVod
    };
}

interface TemplateVariableDoc {
    placeholder: string;
    description: string;
    exampleTemplate: string;
}

function getTemplateVariableDocs(): TemplateVariableDoc[] {
    const de = currentLanguage !== 'en';
    const text = (deText: string, enText: string) => de ? deText : enText;

    return [
        { placeholder: '{title}', description: text('Titel des VODs/Clips', 'Title of the VOD/clip'), exampleTemplate: '{title}' },
        { placeholder: '{id}', description: text('VOD-ID', 'VOD id'), exampleTemplate: '{id}' },
        { placeholder: '{channel}', description: text('Kanalname', 'Channel name'), exampleTemplate: '{channel}' },
        { placeholder: '{date}', description: text('Datum (DD.MM.YYYY)', 'Date (DD.MM.YYYY)'), exampleTemplate: '{date}' },
        { placeholder: '{part}', description: text('Teilnummer', 'Part number'), exampleTemplate: '{part}' },
        { placeholder: '{part_padded}', description: text('Teilnummer mit 2 Stellen', 'Part number padded to 2 digits'), exampleTemplate: '{part_padded}' },
        { placeholder: '{trim_start}', description: text('Startzeit des Ausschnitts', 'Trim start time'), exampleTemplate: '{trim_start}' },
        { placeholder: '{trim_end}', description: text('Endzeit des Ausschnitts', 'Trim end time'), exampleTemplate: '{trim_end}' },
        { placeholder: '{trim_length}', description: text('Lange des Ausschnitts', 'Trimmed duration'), exampleTemplate: '{trim_length}' },
        { placeholder: '{length}', description: text('Gesamtdauer', 'Total duration'), exampleTemplate: '{length}' },
        { placeholder: '{ext}', description: text('Dateiendung', 'File extension'), exampleTemplate: '{ext}' },
        { placeholder: '{random_string}', description: text('Zufallsstring (8 Zeichen)', 'Random string (8 chars)'), exampleTemplate: '{random_string}' },
        { placeholder: '{date_custom="yyyy-MM-dd"}', description: text('Datum mit eigenem Format', 'Custom-formatted date'), exampleTemplate: '{date_custom="yyyy-MM-dd"}' },
        { placeholder: '{trim_start_custom="HH-mm-ss"}', description: text('Startzeit mit eigenem Format', 'Custom-formatted trim start'), exampleTemplate: '{trim_start_custom="HH-mm-ss"}' },
        { placeholder: '{trim_end_custom="HH-mm-ss"}', description: text('Endzeit mit eigenem Format', 'Custom-formatted trim end'), exampleTemplate: '{trim_end_custom="HH-mm-ss"}' },
        { placeholder: '{trim_length_custom="HH-mm-ss"}', description: text('Trim-Dauer mit eigenem Format', 'Custom-formatted trim length'), exampleTemplate: '{trim_length_custom="HH-mm-ss"}' },
        { placeholder: '{length_custom="HH-mm-ss"}', description: text('Gesamtdauer mit eigenem Format', 'Custom-formatted total duration'), exampleTemplate: '{length_custom="HH-mm-ss"}' }
    ];
}

function renderTemplateGuideTable(context: TemplatePreviewContext): void {
    const body = byId('templateGuideBody');
    body.innerHTML = '';

    for (const item of getTemplateVariableDocs()) {
        const row = document.createElement('tr');
        const varCell = document.createElement('td');
        const descCell = document.createElement('td');
        const exampleCell = document.createElement('td');

        varCell.textContent = item.placeholder;
        descCell.textContent = item.description;
        exampleCell.textContent = buildTemplatePreview(item.exampleTemplate, context);

        row.append(varCell, descCell, exampleCell);
        body.appendChild(row);
    }
}

function updateTemplateGuidePresetButtons(): void {
    const activeId: Record<TemplateGuideSource, string> = {
        vod: 'templateGuideUseVod',
        parts: 'templateGuideUseParts',
        clip: 'templateGuideUseClip'
    };

    (Object.keys(activeId) as TemplateGuideSource[]).forEach((key) => {
        const btn = byId<HTMLButtonElement>(activeId[key]);
        btn.classList.toggle('active', key === templateGuideSource);
    });
}

function refreshTemplateGuideTexts(): void {
    setText('settingsTemplateGuideBtn', UI_TEXT.static.templateGuideButton);
    setText('clipTemplateGuideBtn', UI_TEXT.static.templateGuideButton);
    setText('templateGuideTitle', UI_TEXT.static.templateGuideTitle);
    setText('templateGuideIntro', UI_TEXT.static.templateGuideIntro);
    setText('templateGuideTemplateLabel', UI_TEXT.static.templateGuideTemplateLabel);
    setText('templateGuideOutputLabel', UI_TEXT.static.templateGuideOutputLabel);
    setText('templateGuideVarsTitle', UI_TEXT.static.templateGuideVarsTitle);
    setText('templateGuideVarCol', UI_TEXT.static.templateGuideVarCol);
    setText('templateGuideDescCol', UI_TEXT.static.templateGuideDescCol);
    setText('templateGuideExampleCol', UI_TEXT.static.templateGuideExampleCol);
    setText('templateGuideUseVod', UI_TEXT.static.templateGuideUseVod);
    setText('templateGuideUseParts', UI_TEXT.static.templateGuideUseParts);
    setText('templateGuideUseClip', UI_TEXT.static.templateGuideUseClip);
    setText('templateGuideCloseBtn', UI_TEXT.static.templateGuideClose);
    setPlaceholder('templateGuideInput', getTemplateForSource(templateGuideSource));
    updateTemplateGuidePresetButtons();

    const modal = document.getElementById('templateGuideModal');
    if (modal?.classList.contains('show')) {
        updateTemplateGuidePreview();
    }
}

function openTemplateGuide(source: TemplateGuideSource = 'vod'): void {
    templateGuideSource = source;
    byId('templateGuideModal').classList.add('show');
    refreshTemplateGuideTexts();
    setTemplateGuidePreset(source);
}

function closeTemplateGuide(): void {
    byId('templateGuideModal').classList.remove('show');
}

function setTemplateGuidePreset(source: TemplateGuideSource): void {
    templateGuideSource = source;
    const template = getTemplateForSource(source);
    byId<HTMLInputElement>('templateGuideInput').value = template;
    setPlaceholder('templateGuideInput', template);
    updateTemplateGuidePresetButtons();
    updateTemplateGuidePreview();
}

function updateTemplateGuidePreview(): void {
    const input = byId<HTMLInputElement>('templateGuideInput');
    const template = input.value.trim() || getTemplateForSource(templateGuideSource);
    const { context, contextText } = getTemplateGuidePreviewContext(templateGuideSource);

    byId('templateGuideOutput').textContent = buildTemplatePreview(template, context);
    byId('templateGuideContext').textContent = contextText;
    renderTemplateGuideTable(context);
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

    byId('clipDialogTitle').textContent = `${UI_TEXT.clips.dialogTitle} (${duration})`;
    byId<HTMLInputElement>('clipStartSlider').max = String(clipTotalSeconds);
    byId<HTMLInputElement>('clipEndSlider').max = String(clipTotalSeconds);
    byId<HTMLInputElement>('clipStartSlider').value = '0';
    byId<HTMLInputElement>('clipEndSlider').value = String(Math.min(60, clipTotalSeconds));

    byId<HTMLInputElement>('clipStartTime').value = '00:00:00';
    byId<HTMLInputElement>('clipEndTime').value = formatSecondsToTime(Math.min(60, clipTotalSeconds));
    byId<HTMLInputElement>('clipStartPart').value = '';
    byId<HTMLInputElement>('clipFilenameTemplate').value = (config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE;
    query<HTMLInputElement>('input[name="filenameFormat"][value="simple"]').checked = true;
    updateFilenameTemplateVisibility();

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
        durationDisplay.textContent = UI_TEXT.clips.invalidDuration;
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
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const durationSec = Math.max(1, endSec - startSec);
    const timeStr = formatSecondsToTimeDashed(startSec);
    const template = byId<HTMLInputElement>('clipFilenameTemplate').value.trim() || (config.filename_template_clip as string) || DEFAULT_CLIP_TEMPLATE;

    updateFilenameTemplateVisibility();

    byId('formatSimple').textContent = `${dateStr}_${partNum}.mp4 ${UI_TEXT.clips.formatSimple}`;
    byId('formatTimestamp').textContent = `${dateStr}_CLIP_${timeStr}_${partNum}.mp4 ${UI_TEXT.clips.formatTimestamp}`;
    byId('formatTemplate').textContent = `${buildTemplatePreview(template, {
        title: clipDialogData.title,
        date,
        streamer: clipDialogData.streamer,
        partNum,
        startSec,
        durationSec,
        totalSec: clipTotalSeconds
    })} ${UI_TEXT.clips.formatTemplate}`;

    const guideModal = document.getElementById('templateGuideModal');
    if (guideModal?.classList.contains('show') && templateGuideSource === 'clip') {
        updateTemplateGuidePreview();
    }
}

async function confirmClipDialog(): Promise<void> {
    if (!clipDialogData) {
        return;
    }

    const startSec = parseTimeToSeconds(byId<HTMLInputElement>('clipStartTime').value);
    const endSec = parseTimeToSeconds(byId<HTMLInputElement>('clipEndTime').value);
    const startPartStr = byId<HTMLInputElement>('clipStartPart').value.trim();
    const startPart = startPartStr ? parseInt(startPartStr, 10) : 1;
    const filenameFormat = getSelectedFilenameFormat();
    const filenameTemplate = byId<HTMLInputElement>('clipFilenameTemplate').value.trim();

    if (endSec <= startSec) {
        alert(UI_TEXT.clips.endBeforeStart);
        return;
    }

    if (startSec < 0 || endSec > clipTotalSeconds) {
        alert(UI_TEXT.clips.outOfRange);
        return;
    }

    if (filenameFormat === 'template' && !filenameTemplate) {
        alert(UI_TEXT.clips.templateEmpty);
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
            filenameFormat,
            filenameTemplate: filenameFormat === 'template' ? filenameTemplate : undefined
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
        status.textContent = UI_TEXT.clips.enterUrl;
        status.className = 'clip-status error';
        return;
    }

    btn.disabled = true;
    btn.textContent = UI_TEXT.clips.loadingButton;
    status.textContent = UI_TEXT.clips.loadingStatus;
    status.className = 'clip-status loading';

    const result = await window.api.downloadClip(url);

    btn.disabled = false;
    btn.textContent = UI_TEXT.clips.downloadButton;

    if (result.success) {
        status.textContent = UI_TEXT.clips.success;
        status.className = 'clip-status success';
        return;
    }

    const backendError = (result.error || '').trim();
    let localizedError = backendError;

    if (backendError === 'Ungueltige Clip-URL') {
        localizedError = currentLanguage === 'en' ? 'Invalid clip URL' : backendError;
    } else if (backendError === 'Clip nicht gefunden') {
        localizedError = currentLanguage === 'en' ? 'Clip not found' : backendError;
    } else if (backendError === 'Streamlink nicht gefunden') {
        localizedError = currentLanguage === 'en' ? 'Streamlink not found' : backendError;
    } else if (backendError.startsWith('Download fehlgeschlagen')) {
        localizedError = currentLanguage === 'en' ? backendError.replace('Download fehlgeschlagen', 'Download failed') : backendError;
    }

    status.textContent = UI_TEXT.clips.errorPrefix + (localizedError || UI_TEXT.clips.unknownError);
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
        alert(UI_TEXT.cutter.videoInfoFailed);
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
    preview.innerHTML = `<div class="placeholder"><p>${UI_TEXT.cutter.previewLoading}</p></div>`;

    const frame = await window.api.extractFrame(cutterFile, time);
    if (frame) {
        preview.innerHTML = `<img src="${frame}" alt="Preview">`;
        return;
    }

    preview.innerHTML = `<div class="placeholder"><p>${UI_TEXT.cutter.previewUnavailable}</p></div>`;
}

async function startCutting(): Promise<void> {
    if (!cutterFile || isCutting) {
        return;
    }

    isCutting = true;
    byId('btnCut').disabled = true;
    byId('btnCut').textContent = UI_TEXT.cutter.cutting;
    byId('cutProgress').classList.add('show');

    const result = await window.api.cutVideo(cutterFile, cutterStartTime, cutterEndTime);

    isCutting = false;
    byId('btnCut').disabled = false;
    byId('btnCut').textContent = UI_TEXT.cutter.cut;
    byId('cutProgress').classList.remove('show');

    if (result.success) {
        alert(`${UI_TEXT.cutter.cutSuccess}\n\n${result.outputFile}`);
        return;
    }

    alert(UI_TEXT.cutter.cutFailed);
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
                <p style="margin-top:10px">${UI_TEXT.merge.empty}</p>
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
    byId('btnMerge').textContent = UI_TEXT.merge.merging;
    byId('mergeProgress').classList.add('show');

    const result = await window.api.mergeVideos(mergeFiles, outputFile);

    isMerging = false;
    byId('btnMerge').disabled = false;
    byId('btnMerge').textContent = UI_TEXT.merge.merge;
    byId('mergeProgress').classList.remove('show');

    if (result.success) {
        alert(`${UI_TEXT.merge.success}\n\n${result.outputFile}`);
        mergeFiles = [];
        renderMergeFiles();
        return;
    }

    alert(UI_TEXT.merge.failed);
}

void init();

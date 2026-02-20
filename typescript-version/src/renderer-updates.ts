let updateCheckInProgress = false;
let updateDownloadInProgress = false;
let manualUpdateCheckPending = false;
let latestUpdateVersion = '';

function notifyUpdate(message: string, type: 'info' | 'warn' = 'info'): void {
    const toastFn = (window as unknown as { showAppToast?: (msg: string, kind?: 'info' | 'warn') => void }).showAppToast;
    if (typeof toastFn === 'function') {
        toastFn(message, type);
    } else if (type === 'warn') {
        alert(message);
    }
}

function setCheckButtonCheckingState(enabled: boolean): void {
    const btn = byId<HTMLButtonElement>('checkUpdateBtn');
    btn.disabled = enabled;
    btn.textContent = enabled ? UI_TEXT.updates.checking : UI_TEXT.static.checkUpdates;
}

function showUpdateBanner(): void {
    byId('updateBanner').style.display = 'flex';
}

function setDownloadPendingUi(): void {
    showUpdateBanner();
    const button = byId<HTMLButtonElement>('updateButton');
    button.textContent = UI_TEXT.updates.downloading;
    button.disabled = true;
    byId('updateProgress').style.display = 'block';
    const bar = byId('updateProgressBar');
    bar.classList.add('downloading');
    bar.style.width = '30%';
}

function setDownloadReadyUi(version: string): void {
    showUpdateBanner();
    updateReady = true;
    updateDownloadInProgress = false;
    latestUpdateVersion = version || latestUpdateVersion;

    const bar = byId('updateProgressBar');
    bar.classList.remove('downloading');
    bar.style.width = '100%';

    byId('updateText').textContent = `Version ${latestUpdateVersion || '?'} ${UI_TEXT.updates.ready}`;
    const button = byId<HTMLButtonElement>('updateButton');
    button.textContent = UI_TEXT.updates.installNow;
    button.disabled = false;
}

async function checkUpdateSilent(): Promise<void> {
    try {
        await window.api.checkUpdate();
    } catch {
        // ignore silent updater errors
    }
}

async function checkUpdate(): Promise<void> {
    manualUpdateCheckPending = true;
    setCheckButtonCheckingState(true);

    try {
        const result = await window.api.checkUpdate();

        if (result?.error) {
            manualUpdateCheckPending = false;
            updateCheckInProgress = false;
            setCheckButtonCheckingState(false);
            notifyUpdate(UI_TEXT.updates.checkFailed, 'warn');
            return;
        }

        const skippedReason = result?.skipped;
        if (skippedReason === 'ready-to-install') {
            manualUpdateCheckPending = false;
            updateCheckInProgress = false;
            setCheckButtonCheckingState(false);
            notifyUpdate(UI_TEXT.updates.readyToInstall, 'info');
            return;
        }

        if (skippedReason === 'in-progress' || skippedReason === 'throttled') {
            manualUpdateCheckPending = false;
            updateCheckInProgress = false;
            setCheckButtonCheckingState(false);
            notifyUpdate(UI_TEXT.updates.checkInProgress, 'info');
            return;
        }
    } catch {
        manualUpdateCheckPending = false;
        updateCheckInProgress = false;
        setCheckButtonCheckingState(false);
        notifyUpdate(UI_TEXT.updates.checkFailed, 'warn');
    }
}

function downloadUpdate(): void {
    if (updateReady) {
        void window.api.installUpdate();
        return;
    }

    if (updateDownloadInProgress) {
        notifyUpdate(UI_TEXT.updates.downloadInProgress, 'info');
        return;
    }

    updateDownloadInProgress = true;
    setDownloadPendingUi();

    void window.api.downloadUpdate().then((result) => {
        if (result?.error) {
            updateDownloadInProgress = false;
            const button = byId<HTMLButtonElement>('updateButton');
            button.textContent = UI_TEXT.updates.downloadNow;
            button.disabled = false;
            byId('updateProgressBar').classList.remove('downloading');
            notifyUpdate(UI_TEXT.updates.downloadFailed, 'warn');
            return;
        }

        if (result?.skipped === 'ready-to-install') {
            setDownloadReadyUi(latestUpdateVersion);
            return;
        }

        if (result?.skipped === 'in-progress') {
            notifyUpdate(UI_TEXT.updates.downloadInProgress, 'info');
        }
    }).catch(() => {
        updateDownloadInProgress = false;
        const button = byId<HTMLButtonElement>('updateButton');
        button.textContent = UI_TEXT.updates.downloadNow;
        button.disabled = false;
        byId('updateProgressBar').classList.remove('downloading');
        notifyUpdate(UI_TEXT.updates.downloadFailed, 'warn');
    });
}

window.api.onUpdateChecking(() => {
    updateCheckInProgress = true;
    setCheckButtonCheckingState(true);
});

window.api.onUpdateAvailable((info: UpdateInfo) => {
    updateCheckInProgress = false;
    updateReady = false;
    updateDownloadInProgress = true;
    manualUpdateCheckPending = false;
    latestUpdateVersion = info.version;
    setCheckButtonCheckingState(false);

    showUpdateBanner();
    byId('updateText').textContent = `Version ${info.version} ${UI_TEXT.updates.available}`;
    byId('updateButton').textContent = UI_TEXT.updates.downloading;
    byId<HTMLButtonElement>('updateButton').disabled = true;
    byId('updateProgress').style.display = 'block';
    byId('updateProgressBar').classList.add('downloading');
});

window.api.onUpdateNotAvailable(() => {
    updateCheckInProgress = false;
    setCheckButtonCheckingState(false);

    if (manualUpdateCheckPending) {
        notifyUpdate(UI_TEXT.updates.latest, 'info');
    }

    manualUpdateCheckPending = false;
});

window.api.onUpdateDownloadProgress((progress: UpdateDownloadProgress) => {
    updateDownloadInProgress = true;
    const bar = byId('updateProgressBar');
    bar.classList.remove('downloading');
    bar.style.width = progress.percent + '%';

    const mb = (progress.transferred / 1024 / 1024).toFixed(1);
    const totalMb = (progress.total / 1024 / 1024).toFixed(1);
    byId('updateText').textContent = `${UI_TEXT.updates.downloadLabel}: ${mb} / ${totalMb} MB (${progress.percent.toFixed(0)}%)`;
});

window.api.onUpdateDownloaded((info: UpdateInfo) => {
    setDownloadReadyUi(info.version);
});

window.api.onUpdateError(() => {
    updateCheckInProgress = false;
    const wasDownloading = updateDownloadInProgress;
    updateDownloadInProgress = false;
    manualUpdateCheckPending = false;
    setCheckButtonCheckingState(false);

    const button = byId<HTMLButtonElement>('updateButton');
    if (!updateReady) {
        button.textContent = UI_TEXT.updates.downloadNow;
        button.disabled = false;
        byId('updateProgressBar').classList.remove('downloading');
    }

    notifyUpdate(wasDownloading ? UI_TEXT.updates.downloadFailed : UI_TEXT.updates.checkFailed, 'warn');
});

async function checkUpdateSilent(): Promise<void> {
    await window.api.checkUpdate();
}

async function checkUpdate(): Promise<void> {
    await window.api.checkUpdate();

    setTimeout(() => {
        if (byId('updateBanner').style.display !== 'flex') {
            alert(UI_TEXT.updates.latest);
        }
    }, 2000);
}

function downloadUpdate(): void {
    if (updateReady) {
        void window.api.installUpdate();
        return;
    }

    byId('updateButton').textContent = UI_TEXT.updates.downloading;
    byId('updateButton').disabled = true;
    byId('updateProgress').style.display = 'block';
    byId('updateProgressBar').classList.add('downloading');
    void window.api.downloadUpdate();
}

window.api.onUpdateAvailable((info: UpdateInfo) => {
    byId('updateBanner').style.display = 'flex';
    byId('updateText').textContent = `Version ${info.version} ${UI_TEXT.updates.available}`;
    byId('updateButton').textContent = UI_TEXT.updates.downloadNow;
});

window.api.onUpdateDownloadProgress((progress: UpdateDownloadProgress) => {
    const bar = byId('updateProgressBar');
    bar.classList.remove('downloading');
    bar.style.width = progress.percent + '%';

    const mb = (progress.transferred / 1024 / 1024).toFixed(1);
    const totalMb = (progress.total / 1024 / 1024).toFixed(1);
    byId('updateText').textContent = `${UI_TEXT.updates.downloadLabel}: ${mb} / ${totalMb} MB (${progress.percent.toFixed(0)}%)`;
});

window.api.onUpdateDownloaded((info: UpdateInfo) => {
    updateReady = true;

    const bar = byId('updateProgressBar');
    bar.classList.remove('downloading');
    bar.style.width = '100%';

    byId('updateText').textContent = `Version ${info.version} ${UI_TEXT.updates.ready}`;
    byId('updateButton').textContent = UI_TEXT.updates.installNow;
    byId('updateButton').disabled = false;
});

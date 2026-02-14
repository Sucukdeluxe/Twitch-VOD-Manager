type LanguageCode = 'de' | 'en';

const UI_TEXTS = {
    de: {
        appName: 'Twitch VOD Manager',
        static: {
            navVods: 'Twitch VODs',
            navClips: 'Twitch Clips',
            navCutter: 'Video schneiden',
            navMerge: 'Videos zusammenfugen',
            navSettings: 'Einstellungen',
            queueTitle: 'Warteschlange',
            clearQueue: 'Leeren',
            refresh: 'Aktualisieren',
            streamerPlaceholder: 'Streamer hinzufugen...',
            clipsHeading: 'Twitch Clip-Download',
            clipsInfoTitle: 'Info',
            clipsInfoText: 'Unterstutzte Formate:\n- https://clips.twitch.tv/ClipName\n- https://www.twitch.tv/streamer/clip/ClipName\n\nClips werden im Download-Ordner unter "Clips/StreamerName/" gespeichert.',
            cutterSelectTitle: 'Video auswahlen',
            cutterBrowse: 'Durchsuchen',
            mergeTitle: 'Videos zusammenfugen',
            mergeDesc: 'Wahle mehrere Videos aus, um sie zu einem Video zusammenzufugen. Die Reihenfolge kann geandert werden.',
            mergeAdd: '+ Videos hinzufugen',
            designTitle: 'Design',
            themeLabel: 'Theme',
            languageLabel: 'Sprache',
            languageDe: 'Deutsch',
            languageEn: 'Englisch',
            apiTitle: 'Twitch API',
            clientIdLabel: 'Client ID',
            clientSecretLabel: 'Client Secret',
            saveSettings: 'Speichern & Verbinden',
            downloadSettingsTitle: 'Download-Einstellungen',
            storageLabel: 'Speicherort',
            openFolder: 'Offnen',
            modeLabel: 'Download-Modus',
            modeFull: 'Ganzes VOD',
            modeParts: 'In Teile splitten',
            partMinutesLabel: 'Teil-Lange (Minuten)',
            updateTitle: 'Updates',
            checkUpdates: 'Nach Updates suchen',
            notConnected: 'Nicht verbunden'
        },
        status: {
            noLogin: 'Ohne Login (Public Modus)',
            connecting: 'Verbinde...',
            connected: 'Verbunden',
            connectFailedPublic: 'Verbindung fehlgeschlagen - Public Modus aktiv'
        },
        tabs: {
            vods: 'VODs',
            clips: 'Clips',
            cutter: 'Video schneiden',
            merge: 'Videos zusammenfugen',
            settings: 'Einstellungen'
        },
        queue: {
            empty: 'Keine Downloads in der Warteschlange',
            start: 'Start',
            stop: 'Stoppen',
            statusDone: 'Abgeschlossen',
            statusFailed: 'Fehlgeschlagen',
            statusRunning: 'Laeuft',
            statusWaiting: 'Wartet',
            progressError: 'Fehler',
            progressReady: 'Bereit',
            progressLoading: 'Lade...',
            readyToDownload: 'Bereit zum Download',
            started: 'Download gestartet',
            done: 'Fertig',
            failed: 'Download fehlgeschlagen',
            speed: 'Geschwindigkeit',
            eta: 'Restzeit',
            part: 'Teil',
            emptyAlert: 'Die Warteschlange ist leer. Fuge zuerst ein VOD oder einen Clip hinzu.'
        },
        vods: {
            noneTitle: 'Keine VODs',
            noneText: 'Wahle einen Streamer aus der Liste.',
            loading: 'Lade VODs...',
            notFound: 'Streamer nicht gefunden',
            noResultsTitle: 'Keine VODs gefunden',
            noResultsText: 'Dieser Streamer hat keine VODs.',
            untitled: 'Unbenanntes VOD',
            views: 'Aufrufe',
            addQueue: '+ Warteschlange'
        },
        clips: {
            dialogTitle: 'Clip zuschneiden',
            invalidDuration: 'Ungultig!',
            endBeforeStart: 'Endzeit muss grosser als Startzeit sein!',
            outOfRange: 'Zeit ausserhalb des VOD-Bereichs!',
            enterUrl: 'Bitte URL eingeben',
            loadingButton: 'Lade...',
            loadingStatus: 'Download laeuft...',
            downloadButton: 'Clip herunterladen',
            success: 'Download erfolgreich!',
            errorPrefix: 'Fehler: ',
            unknownError: 'Unbekannter Fehler',
            formatSimple: '(Standard)',
            formatTimestamp: '(mit Zeitstempel)'
        },
        cutter: {
            videoInfoFailed: 'Konnte Video-Informationen nicht lesen. FFprobe installiert?',
            previewLoading: 'Lade Vorschau...',
            previewUnavailable: 'Vorschau nicht verfugbar',
            cutting: 'Schneidet...',
            cut: 'Schneiden',
            cutSuccess: 'Video erfolgreich geschnitten!',
            cutFailed: 'Fehler beim Schneiden des Videos.'
        },
        merge: {
            empty: 'Keine Videos ausgewahlt',
            merging: 'Zusammenfugen...',
            merge: 'Zusammenfugen',
            success: 'Videos erfolgreich zusammengefugt!',
            failed: 'Fehler beim Zusammenfugen der Videos.'
        },
        updates: {
            latest: 'Du hast die neueste Version!',
            downloading: 'Wird heruntergeladen...',
            available: 'verfugbar!',
            downloadNow: 'Jetzt herunterladen',
            downloadLabel: 'Download',
            ready: 'bereit zur Installation!',
            installNow: 'Jetzt installieren'
        }
    },
    en: {
        appName: 'Twitch VOD Manager',
        static: {
            navVods: 'Twitch VODs',
            navClips: 'Twitch Clips',
            navCutter: 'Video Cutter',
            navMerge: 'Merge Videos',
            navSettings: 'Settings',
            queueTitle: 'Queue',
            clearQueue: 'Clear',
            refresh: 'Refresh',
            streamerPlaceholder: 'Add streamer...',
            clipsHeading: 'Twitch Clip Download',
            clipsInfoTitle: 'Info',
            clipsInfoText: 'Supported formats:\n- https://clips.twitch.tv/ClipName\n- https://www.twitch.tv/streamer/clip/ClipName\n\nClips are saved in your download folder under "Clips/StreamerName/".',
            cutterSelectTitle: 'Select video',
            cutterBrowse: 'Browse',
            mergeTitle: 'Merge videos',
            mergeDesc: 'Select multiple videos to merge into one file. You can change the order before merging.',
            mergeAdd: '+ Add videos',
            designTitle: 'Design',
            themeLabel: 'Theme',
            languageLabel: 'Language',
            languageDe: 'German',
            languageEn: 'English',
            apiTitle: 'Twitch API',
            clientIdLabel: 'Client ID',
            clientSecretLabel: 'Client Secret',
            saveSettings: 'Save & Connect',
            downloadSettingsTitle: 'Download Settings',
            storageLabel: 'Storage Path',
            openFolder: 'Open',
            modeLabel: 'Download Mode',
            modeFull: 'Full VOD',
            modeParts: 'Split into parts',
            partMinutesLabel: 'Part Length (Minutes)',
            updateTitle: 'Updates',
            checkUpdates: 'Check for updates',
            notConnected: 'Not connected'
        },
        status: {
            noLogin: 'No login (public mode)',
            connecting: 'Connecting...',
            connected: 'Connected',
            connectFailedPublic: 'Connection failed - public mode active'
        },
        tabs: {
            vods: 'VODs',
            clips: 'Clips',
            cutter: 'Video Cutter',
            merge: 'Merge Videos',
            settings: 'Settings'
        },
        queue: {
            empty: 'No downloads in queue',
            start: 'Start',
            stop: 'Stop',
            statusDone: 'Completed',
            statusFailed: 'Failed',
            statusRunning: 'Running',
            statusWaiting: 'Waiting',
            progressError: 'Error',
            progressReady: 'Ready',
            progressLoading: 'Loading...',
            readyToDownload: 'Ready to download',
            started: 'Download started',
            done: 'Done',
            failed: 'Download failed',
            speed: 'Speed',
            eta: 'ETA',
            part: 'Part',
            emptyAlert: 'Queue is empty. Add a VOD or clip first.'
        },
        vods: {
            noneTitle: 'No VODs',
            noneText: 'Select a streamer from the list.',
            loading: 'Loading VODs...',
            notFound: 'Streamer not found',
            noResultsTitle: 'No VODs found',
            noResultsText: 'This streamer has no VODs.',
            untitled: 'Untitled VOD',
            views: 'views',
            addQueue: '+ Queue'
        },
        clips: {
            dialogTitle: 'Trim clip',
            invalidDuration: 'Invalid!',
            endBeforeStart: 'End time must be greater than start time!',
            outOfRange: 'Time is outside VOD range!',
            enterUrl: 'Please enter a URL',
            loadingButton: 'Loading...',
            loadingStatus: 'Downloading...',
            downloadButton: 'Download clip',
            success: 'Download successful!',
            errorPrefix: 'Error: ',
            unknownError: 'Unknown error',
            formatSimple: '(default)',
            formatTimestamp: '(with timestamp)'
        },
        cutter: {
            videoInfoFailed: 'Could not read video info. Is FFprobe installed?',
            previewLoading: 'Loading preview...',
            previewUnavailable: 'Preview unavailable',
            cutting: 'Cutting...',
            cut: 'Cut',
            cutSuccess: 'Video cut successfully!',
            cutFailed: 'Failed to cut video.'
        },
        merge: {
            empty: 'No videos selected',
            merging: 'Merging...',
            merge: 'Merge',
            success: 'Videos merged successfully!',
            failed: 'Failed to merge videos.'
        },
        updates: {
            latest: 'You are on the latest version!',
            downloading: 'Downloading...',
            available: 'available!',
            downloadNow: 'Download now',
            downloadLabel: 'Download',
            ready: 'ready to install!',
            installNow: 'Install now'
        }
    }
} as const;

let currentLanguage: LanguageCode = 'de';
let UI_TEXT: (typeof UI_TEXTS)[LanguageCode] = UI_TEXTS[currentLanguage];

function setText(id: string, value: string): void {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
}

function setPlaceholder(id: string, value: string): void {
    const node = document.getElementById(id) as HTMLInputElement | null;
    if (node) node.placeholder = value;
}

function setLanguage(lang: string): LanguageCode {
    currentLanguage = lang === 'en' ? 'en' : 'de';
    UI_TEXT = UI_TEXTS[currentLanguage];
    applyLanguageToStaticUI();
    return currentLanguage;
}

function applyLanguageToStaticUI(): void {
    setText('logoText', UI_TEXT.appName);
    setText('navVodsText', UI_TEXT.static.navVods);
    setText('navClipsText', UI_TEXT.static.navClips);
    setText('navCutterText', UI_TEXT.static.navCutter);
    setText('navMergeText', UI_TEXT.static.navMerge);
    setText('navSettingsText', UI_TEXT.static.navSettings);
    setText('queueTitleText', UI_TEXT.static.queueTitle);
    setText('btnClear', UI_TEXT.static.clearQueue);
    setText('refreshText', UI_TEXT.static.refresh);
    setText('clipsHeading', UI_TEXT.static.clipsHeading);
    setText('clipsInfoTitle', UI_TEXT.static.clipsInfoTitle);
    setText('clipsInfoText', UI_TEXT.static.clipsInfoText);
    setText('cutterSelectTitle', UI_TEXT.static.cutterSelectTitle);
    setText('cutterBrowseBtn', UI_TEXT.static.cutterBrowse);
    setText('mergeTitle', UI_TEXT.static.mergeTitle);
    setText('mergeDesc', UI_TEXT.static.mergeDesc);
    setText('mergeAddBtn', UI_TEXT.static.mergeAdd);
    setText('designTitle', UI_TEXT.static.designTitle);
    setText('themeLabel', UI_TEXT.static.themeLabel);
    setText('languageLabel', UI_TEXT.static.languageLabel);
    setText('languageDeText', UI_TEXT.static.languageDe);
    setText('languageEnText', UI_TEXT.static.languageEn);
    setText('apiTitle', UI_TEXT.static.apiTitle);
    setText('clientIdLabel', UI_TEXT.static.clientIdLabel);
    setText('clientSecretLabel', UI_TEXT.static.clientSecretLabel);
    setText('saveSettingsBtn', UI_TEXT.static.saveSettings);
    setText('downloadSettingsTitle', UI_TEXT.static.downloadSettingsTitle);
    setText('storageLabel', UI_TEXT.static.storageLabel);
    setText('openFolderBtn', UI_TEXT.static.openFolder);
    setText('modeLabel', UI_TEXT.static.modeLabel);
    setText('modeFullText', UI_TEXT.static.modeFull);
    setText('modePartsText', UI_TEXT.static.modeParts);
    setText('partMinutesLabel', UI_TEXT.static.partMinutesLabel);
    setText('updateTitle', UI_TEXT.static.updateTitle);
    setText('checkUpdateBtn', UI_TEXT.static.checkUpdates);

    setPlaceholder('newStreamer', UI_TEXT.static.streamerPlaceholder);

    const status = document.getElementById('statusText')?.textContent?.trim() || '';
    if (status === UI_TEXTS.de.static.notConnected || status === UI_TEXTS.en.static.notConnected) {
        setText('statusText', UI_TEXT.static.notConnected);
    }
}

function localizeCurrentStatusText(current: string): string {
    const map: Record<string, keyof typeof UI_TEXT.status> = {
        [UI_TEXTS.de.status.noLogin]: 'noLogin',
        [UI_TEXTS.en.status.noLogin]: 'noLogin',
        [UI_TEXTS.de.status.connecting]: 'connecting',
        [UI_TEXTS.en.status.connecting]: 'connecting',
        [UI_TEXTS.de.status.connected]: 'connected',
        [UI_TEXTS.en.status.connected]: 'connected',
        [UI_TEXTS.de.status.connectFailedPublic]: 'connectFailedPublic',
        [UI_TEXTS.en.status.connectFailedPublic]: 'connectFailedPublic'
    };

    const key = map[current];
    return key ? UI_TEXT.status[key] : current;
}

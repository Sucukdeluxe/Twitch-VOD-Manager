type LanguageCode = 'de' | 'en';

const UI_TEXTS = {
    de: UI_TEXT_DE,
    en: UI_TEXT_EN
} as const;

let currentLanguage: LanguageCode = 'en';
let UI_TEXT: (typeof UI_TEXTS)[LanguageCode] = UI_TEXTS[currentLanguage];

function getIntlLocale(): string {
    return currentLanguage === 'en' ? 'en-US' : 'de-DE';
}

function formatUiDate(input: string | Date): string {
    const date = input instanceof Date ? input : new Date(input);
    return date.toLocaleDateString(getIntlLocale());
}

function formatUiNumber(value: number): string {
    return value.toLocaleString(getIntlLocale());
}

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
    setText('btnRetryFailed', UI_TEXT.static.retryFailed);
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
    setText('preflightTitle', UI_TEXT.static.preflightTitle);
    setText('btnPreflightRun', UI_TEXT.static.preflightRun);
    setText('btnPreflightFix', UI_TEXT.static.preflightFix);
    setText('preflightResult', UI_TEXT.static.preflightEmpty);
    setText('debugLogTitle', UI_TEXT.static.debugLogTitle);
    setText('btnRefreshLog', UI_TEXT.static.refreshLog);
    setText('autoRefreshText', UI_TEXT.static.autoRefresh);
    setText('updateText', UI_TEXT.updates.bannerDefault);
    setText('updateButton', UI_TEXT.updates.downloadNow);
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

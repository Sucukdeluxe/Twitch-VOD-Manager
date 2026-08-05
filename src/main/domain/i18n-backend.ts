// Backend-Messages (User-visible aus main.ts produziert). Pure: Sprache wird
// als Parameter uebergeben statt aus globalem config geholt.

export const BACKEND_MESSAGES = {
    de: {
        invalidVodUrl: 'Ungueltige VOD-URL',
        invalidClipUrl: 'Ungueltige Clip-URL',
        clipNotFound: 'Clip nicht gefunden',
        streamlinkAutoInstallFailed: 'Streamlink fehlt und konnte nicht automatisch installiert werden. Siehe debug.log.',
        streamlinkMissing: 'Streamlink fehlt.',
        streamlinkNotFound: 'Streamlink nicht gefunden. Installiere Streamlink oder Python+streamlink (py -3 -m pip install streamlink).',
        streamlinkExitCode: 'Streamlink Fehlercode {code}',
        ffmpegMissing: 'FFmpeg fehlt.',
        ffmpegMergeFailed: 'FFmpeg Merge fehlgeschlagen.',
        ffmpegSplitFailed: 'FFmpeg Split fehlgeschlagen.',
        fileTooSmall: 'Datei zu klein ({bytes} Bytes)',
        clipFileTooSmall: 'Clip-Datei zu klein ({bytes} Bytes) - Twitch hat den Stream evtl. nicht ausgeliefert.',
        integrityNoVideo: 'Integritaetspruefung fehlgeschlagen: Kein Videostream gefunden.',
        integrityTooShort: 'Integritaetspruefung fehlgeschlagen: Dauer zu kurz ({duration}s).',
        integrityDurationMismatch: 'Integritaetspruefung fehlgeschlagen: {actual}s statt erwarteter ~{expected}s.',
        integrityFailedGeneric: 'Integritaetspruefung fehlgeschlagen.',
        downloadCancelled: 'Download wurde abgebrochen.',
        downloadPaused: 'Download wurde pausiert.',
        downloadFailedExitCode: 'Download fehlgeschlagen (Exit-Code {code})',
        unknownDownloadError: 'Unbekannter Fehler beim Download',
        notAllClipPartsDownloaded: 'Nicht alle Clip-Teile konnten heruntergeladen werden.',
        notAllPartsDownloaded: 'Nicht alle Teile konnten heruntergeladen werden.',
        mergeGroupFileMissing: 'Heruntergeladene Datei {index} fehlt.',
        diskSpaceShortFor: 'Zu wenig Speicherplatz fur {context}: frei {free}, benoetigt ~{required}.',
        diskSpaceShortGeneric: 'Zu wenig Speicherplatz.',
        attemptFailed: 'Versuch {attempt}/{max} fehlgeschlagen ({errorClass}): {error}',
        retryingIn: 'Neuer Versuch in {seconds}s ({errorClass})...',
        statusCheckingTools: 'Prufe Download-Tools...',
        statusDownloadStarted: 'Download gestartet',
        statusBytesDownloaded: '{bytes} heruntergeladen',
        statusFetchingChatReplay: 'Chat-Replay wird heruntergeladen...',
        statusChatMessagesFetched: 'Chat-Nachrichten geladen: {count}',
        preflightNoInternet: 'Keine Internetverbindung erkannt.',
        preflightStreamlinkMissing: 'Streamlink fehlt oder ist nicht startbar.',
        preflightFfmpegMissing: 'FFmpeg fehlt oder ist nicht startbar.',
        preflightFfprobeMissing: 'FFprobe fehlt oder ist nicht startbar.',
        preflightDownloadPathNotWritable: 'Download-Ordner ist nicht beschreibbar.'
    },
    en: {
        invalidVodUrl: 'Invalid VOD URL',
        invalidClipUrl: 'Invalid clip URL',
        clipNotFound: 'Clip not found',
        streamlinkAutoInstallFailed: 'Streamlink is missing and could not be auto-installed. See debug.log.',
        streamlinkMissing: 'Streamlink is missing.',
        streamlinkNotFound: 'Streamlink not found. Install streamlink or Python+streamlink (py -3 -m pip install streamlink).',
        streamlinkExitCode: 'Streamlink exit code {code}',
        ffmpegMissing: 'FFmpeg is missing.',
        ffmpegMergeFailed: 'FFmpeg merge failed.',
        ffmpegSplitFailed: 'FFmpeg split failed.',
        fileTooSmall: 'File too small ({bytes} bytes)',
        clipFileTooSmall: 'Clip file too small ({bytes} bytes) - Twitch may not have served the stream.',
        integrityNoVideo: 'Integrity check failed: no video stream found.',
        integrityTooShort: 'Integrity check failed: duration too short ({duration}s).',
        integrityDurationMismatch: 'Integrity check failed: {actual}s instead of expected ~{expected}s.',
        integrityFailedGeneric: 'Integrity check failed.',
        downloadCancelled: 'Download was cancelled.',
        downloadPaused: 'Download was paused.',
        downloadFailedExitCode: 'Download failed (exit code {code})',
        unknownDownloadError: 'Unknown download error',
        notAllClipPartsDownloaded: 'Not all clip parts could be downloaded.',
        notAllPartsDownloaded: 'Not all parts could be downloaded.',
        mergeGroupFileMissing: 'Downloaded file {index} is missing.',
        diskSpaceShortFor: 'Not enough disk space for {context}: free {free}, need ~{required}.',
        diskSpaceShortGeneric: 'Not enough disk space.',
        attemptFailed: 'Attempt {attempt}/{max} failed ({errorClass}): {error}',
        retryingIn: 'Retrying in {seconds}s ({errorClass})...',
        statusCheckingTools: 'Checking download tools...',
        statusDownloadStarted: 'Download started',
        statusBytesDownloaded: '{bytes} downloaded',
        statusFetchingChatReplay: 'Fetching chat replay...',
        statusChatMessagesFetched: 'Chat messages fetched: {count}',
        preflightNoInternet: 'No internet connection detected.',
        preflightStreamlinkMissing: 'Streamlink is missing or not runnable.',
        preflightFfmpegMissing: 'FFmpeg is missing or not runnable.',
        preflightFfprobeMissing: 'FFprobe is missing or not runnable.',
        preflightDownloadPathNotWritable: 'Download folder is not writable.'
    }
} as const;

export type BackendMessageKey = keyof typeof BACKEND_MESSAGES.de;
export type BackendLanguage = 'de' | 'en';

export function tBackend(
    key: BackendMessageKey,
    params: Record<string, string | number> | undefined,
    language: BackendLanguage | string
): string {
    const lang: BackendLanguage = (language === 'en') ? 'en' : 'de';
    let template: string = BACKEND_MESSAGES[lang][key];
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            template = template.replace(`{${k}}`, String(v));
        }
    }
    return template;
}

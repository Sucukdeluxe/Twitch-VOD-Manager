function byId<T = any>(id: string): T {
    return document.getElementById(id) as T;
}

function query<T = any>(selector: string): T {
    return document.querySelector(selector) as T;
}

function queryAll<T = any>(selector: string): T[] {
    return Array.from(document.querySelectorAll(selector)) as T[];
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let config: AppConfig = {};
let currentStreamer: string | null = null;
let isConnected = false;
let downloading = false;
let queue: QueueItem[] = [];

let cutterFile: string | null = null;
let cutterVideoInfo: VideoInfo | null = null;
let cutterStartTime = 0;
let cutterEndTime = 0;
let isCutting = false;

let mergeFiles: string[] = [];
let isMerging = false;

let clipDialogData: ClipDialogData | null = null;
let clipTotalSeconds = 0;

let updateReady = false;
let debugLogAutoRefreshTimer: number | null = null;

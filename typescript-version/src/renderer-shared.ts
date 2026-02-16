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
let runtimeMetricsAutoRefreshTimer: number | null = null;
let draggedQueueItemId: string | null = null;

const TEMPLATE_EXACT_TOKENS = new Set([
    '{title}',
    '{id}',
    '{channel}',
    '{channel_id}',
    '{date}',
    '{part}',
    '{part_padded}',
    '{trim_start}',
    '{trim_end}',
    '{trim_length}',
    '{length}',
    '{ext}',
    '{random_string}'
]);

const TEMPLATE_CUSTOM_TOKEN_PATTERNS = [
    /^\{date_custom=".*"\}$/,
    /^\{trim_start_custom=".*"\}$/,
    /^\{trim_end_custom=".*"\}$/,
    /^\{trim_length_custom=".*"\}$/,
    /^\{length_custom=".*"\}$/
];

function isKnownTemplateToken(token: string): boolean {
    if (TEMPLATE_EXACT_TOKENS.has(token)) {
        return true;
    }

    return TEMPLATE_CUSTOM_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
}

function collectUnknownTemplatePlaceholders(template: string): string[] {
    const tokens = (template.match(/\{[^{}]+\}/g) || []).map((token) => token.trim());
    const unknown = tokens.filter((token) => !isKnownTemplateToken(token));
    return Array.from(new Set(unknown));
}

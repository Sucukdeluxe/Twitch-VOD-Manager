import * as fs from 'fs';
import * as path from 'path';
import type { DbHandle } from '../infra/db';
import { normalizeLogin } from './config-normalize';

export interface MigratorOptions {
    db: DbHandle;
    appDataDir: string;
}

export interface MigrationError {
    source: string;
    message: string;
}

export interface MigrationResult {
    alreadyApplied: boolean;
    configMigrated: boolean;
    queueMigrated: boolean;
    downloadedVodsCount: number;
    streamersCount: number;
    errors: MigrationError[];
}

const MIGRATION_NAME = 'v4-to-v5-jsons';

const CONFIG_KV_KEYS = [
    'language', 'performance_mode', 'metadata_cache_minutes', 'streamlink_quality',
    'streamlink_disable_ads', 'download_chat_replay', 'capture_live_chat',
    'discord_webhook_url', 'discord_notify_live_start', 'discord_notify_live_end',
    'discord_notify_vod_complete', 'discord_notify_vod_auto_queued',
    'auto_cleanup_enabled', 'auto_cleanup_days', 'auto_cleanup_target',
    'auto_cleanup_action', 'log_stream_events', 'auto_vod_download_poll_minutes',
    'auto_vod_max_age_hours', 'auto_resume_live_recording',
    'auto_merge_resumed_parts', 'delete_parts_after_merge',
    'auto_record_poll_seconds', 'filename_template_vod', 'filename_template_parts',
    'filename_template_clip', 'smart_queue_scheduler', 'prevent_duplicate_downloads',
    'persist_queue_on_restart', 'auto_resume_queue_on_startup',
    'notify_on_each_completion',
] as const;

function backupOnce(srcPath: string): void {
    const backupPath = srcPath + '.v4-backup';
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(srcPath, backupPath);
    }
}

function migrateConfig(db: DbHandle, configPath: string, errors: MigrationError[]): { ok: boolean; vodCount: number } {
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw) as Record<string, unknown>;

        let vodCount = 0;
        db.transaction(() => {
            for (const key of CONFIG_KV_KEYS) {
                if (key in config) {
                    db.run(
                        "INSERT OR REPLACE INTO config_kv(key, value, updated_at) VALUES (?, ?, strftime('%s','now'))",
                        [key, JSON.stringify(config[key])]
                    );
                }
            }

            const vodIds = Array.isArray(config.downloaded_vod_ids) ? config.downloaded_vod_ids : [];
            for (const id of vodIds) {
                if (typeof id !== 'string' || !id) continue;
                db.run('INSERT OR IGNORE INTO downloaded_vods(vod_id) VALUES (?)', [id]);
                vodCount += 1;
            }

            const autoRec = Array.isArray(config.auto_record_streamers) ? config.auto_record_streamers : [];
            for (const s of autoRec) {
                if (typeof s !== 'string' || !s) continue;
                const login = normalizeLogin(s);
                if (!login) continue;
                db.run(
                    'INSERT INTO streamers(login, auto_record) VALUES (?, 1) ON CONFLICT(login) DO UPDATE SET auto_record = 1',
                    [login]
                );
            }

            const autoDl = Array.isArray(config.auto_vod_download_streamers) ? config.auto_vod_download_streamers : [];
            for (const s of autoDl) {
                if (typeof s !== 'string' || !s) continue;
                const login = normalizeLogin(s);
                if (!login) continue;
                db.run(
                    'INSERT INTO streamers(login, auto_vod_download) VALUES (?, 1) ON CONFLICT(login) DO UPDATE SET auto_vod_download = 1',
                    [login]
                );
            }
        });

        backupOnce(configPath);
        return { ok: true, vodCount };
    } catch (e) {
        errors.push({ source: 'config.json', message: e instanceof Error ? e.message : String(e) });
        return { ok: false, vodCount: 0 };
    }
}

function migrateQueue(db: DbHandle, queuePath: string, errors: MigrationError[]): boolean {
    try {
        const raw = fs.readFileSync(queuePath, 'utf-8');
        const queue = JSON.parse(raw);
        if (!Array.isArray(queue)) return false;

        const now = Math.floor(Date.now() / 1000);
        db.transaction(() => {
            for (const rawItem of queue) {
                if (!rawItem || typeof rawItem !== 'object') continue;
                const item = rawItem as Record<string, unknown>;
                const id = typeof item.id === 'string' ? item.id : null;
                if (!id) continue;
                db.run(
                    `INSERT OR REPLACE INTO queue_items
                     (id, streamer_login, vod_id, clip_id, title, output_path, status,
                      progress_pct, error_message, created_at, updated_at, completed_at, payload_json)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        id,
                        typeof item.streamer === 'string' ? normalizeLogin(item.streamer) : null,
                        typeof item.vod_id === 'string' ? item.vod_id : null,
                        typeof item.clip_id === 'string' ? item.clip_id : null,
                        typeof item.title === 'string' ? item.title : null,
                        typeof item.output_path === 'string' ? item.output_path : null,
                        typeof item.status === 'string' ? item.status : 'pending',
                        typeof item.progress_pct === 'number' ? item.progress_pct : null,
                        typeof item.error_message === 'string' ? item.error_message : null,
                        typeof item.created_at === 'number' ? item.created_at : now,
                        typeof item.updated_at === 'number' ? item.updated_at : now,
                        typeof item.completed_at === 'number' ? item.completed_at : null,
                        JSON.stringify(item),
                    ]
                );
            }
        });

        backupOnce(queuePath);
        return true;
    } catch (e) {
        errors.push({ source: 'download_queue.json', message: e instanceof Error ? e.message : String(e) });
        return false;
    }
}

export function migrateJsonToSqlite(opts: MigratorOptions): MigrationResult {
    const { db, appDataDir } = opts;
    const errors: MigrationError[] = [];

    const existing = db.get<{ name: string }>(
        'SELECT name FROM migrations_applied WHERE name = ?',
        [MIGRATION_NAME]
    );
    if (existing) {
        return {
            alreadyApplied: true,
            configMigrated: false,
            queueMigrated: false,
            downloadedVodsCount: 0,
            streamersCount: 0,
            errors: [],
        };
    }

    let configMigrated = false;
    let queueMigrated = false;
    let downloadedVodsCount = 0;

    const configPath = path.join(appDataDir, 'config.json');
    if (fs.existsSync(configPath)) {
        const r = migrateConfig(db, configPath, errors);
        configMigrated = r.ok;
        downloadedVodsCount = r.vodCount;
    }

    const queuePath = path.join(appDataDir, 'download_queue.json');
    if (fs.existsSync(queuePath)) {
        queueMigrated = migrateQueue(db, queuePath, errors);
    }

    const streamersCount = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM streamers')?.c ?? 0;

    db.run(
        'INSERT INTO migrations_applied(name, payload) VALUES (?, ?)',
        [
            MIGRATION_NAME,
            JSON.stringify({ configMigrated, queueMigrated, downloadedVodsCount, streamersCount, errorCount: errors.length }),
        ]
    );

    return {
        alreadyApplied: false,
        configMigrated,
        queueMigrated,
        downloadedVodsCount,
        streamersCount,
        errors,
    };
}

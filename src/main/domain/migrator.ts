import * as fs from 'fs';
import * as path from 'path';
import type { DbHandle } from '../infra/db';
import { createAppStateStore } from './app-state-store';
import type { SecretStore } from './secret-store';

export interface MigratorOptions {
    db: DbHandle;
    appDataDir: string;
    secrets?: SecretStore;
    requireEncryption?: boolean;
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

const MIGRATION_NAME = 'authoritative-state-v1';
const SECRET_KEYS = new Set(['client_secret', 'discord_webhook_url']);

function readJson<T>(filePath: string, source: string, errors: MigrationError[]): T | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch (error) {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) });
        return undefined;
    }
}

function withoutSecrets(config: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(config).filter(([key]) => !SECRET_KEYS.has(key)));
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, filePath);
}

function backupJson(filePath: string, value: unknown): void {
    const backupPath = `${filePath}.v4-backup`;
    if (!fs.existsSync(backupPath)) writeJsonAtomic(backupPath, value);
}

function scrubConfigFiles(configPath: string, config: Record<string, unknown>): void {
    const sanitized = withoutSecrets(config);
    writeJsonAtomic(`${configPath}.v4-backup`, sanitized);
    writeJsonAtomic(configPath, sanitized);
}

function scrubExistingConfig(configPath: string): void {
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    scrubConfigFiles(configPath, config);
}

function emptyResult(alreadyApplied: boolean, errors: MigrationError[] = []): MigrationResult {
    return {
        alreadyApplied,
        configMigrated: false,
        queueMigrated: false,
        downloadedVodsCount: 0,
        streamersCount: 0,
        errors,
    };
}

export function migrateJsonToSqlite(opts: MigratorOptions): MigrationResult {
    const { db, appDataDir, secrets, requireEncryption = false } = opts;
    const configPath = path.join(appDataDir, 'config.json');
    const queuePath = path.join(appDataDir, 'download_queue.json');
    const existing = db.get<{ name: string }>('SELECT name FROM migrations_applied WHERE name = ?', [MIGRATION_NAME]);
    if (existing) {
        return emptyResult(true);
    }

    const errors: MigrationError[] = [];
    const configExists = fs.existsSync(configPath);
    const queueExists = fs.existsSync(queuePath);
    const config = readJson<Record<string, unknown>>(configPath, 'config.json', errors);
    const queue = readJson<unknown>(queuePath, 'download_queue.json', errors);
    if (queueExists && !Array.isArray(queue)) {
        errors.push({ source: 'download_queue.json', message: 'Queue JSON must be an array' });
    }
    if (errors.length > 0) return emptyResult(false, errors);
    if (configExists && (!config || typeof config !== 'object' || Array.isArray(config))) {
        return emptyResult(false, [{ source: 'config.json', message: 'Config JSON must be an object' }]);
    }
    if (config && !secrets && [...SECRET_KEYS].some((key) => typeof config[key] === 'string' && config[key])) {
        return emptyResult(false, [{ source: 'migration', message: 'Secure secret storage is required for plaintext secret migration' }]);
    }
    if (config && requireEncryption && [...SECRET_KEYS].some((key) => typeof config[key] === 'string' && config[key]) && !secrets?.status().encryptionAvailable) {
        return emptyResult(false, [{ source: 'migration', message: 'OS secret encryption is unavailable' }]);
    }

    const state = createAppStateStore(db);
    let downloadedVodsCount = 0;
    let streamersCount = 0;
    let configScrubbed = false;
    try {
        db.transaction(() => {
            if (configExists && config) {
                state.saveConfig(config);
                downloadedVodsCount = Array.isArray(config.downloaded_vod_ids)
                    ? config.downloaded_vod_ids.filter((value) => typeof value === 'string' && value).length
                    : 0;
                if (typeof config.client_secret === 'string' && config.client_secret) {
                    secrets!.set('twitch_client_secret', config.client_secret);
                }
                if (typeof config.discord_webhook_url === 'string' && config.discord_webhook_url) {
                    secrets!.set('discord_webhook_url', config.discord_webhook_url);
                }
            }
            if (queueExists) state.saveQueue(queue as Array<Record<string, unknown>>);
            streamersCount = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM streamers')?.count ?? 0;
            db.run(
                'INSERT INTO migrations_applied(name, payload) VALUES (?, ?)',
                [MIGRATION_NAME, JSON.stringify({ configMigrated: configExists, queueMigrated: queueExists, downloadedVodsCount, streamersCount })]
            );
            if (queueExists) backupJson(queuePath, queue);
            if (configExists && config) {
                scrubConfigFiles(configPath, config);
                configScrubbed = true;
            }
        });
    } catch (error) {
        if (configScrubbed && config) {
            try {
                writeJsonAtomic(configPath, config);
            } catch { }
        }
        return emptyResult(false, [{ source: 'migration', message: error instanceof Error ? error.message : String(error) }]);
    }

    return {
        alreadyApplied: false,
        configMigrated: configExists,
        queueMigrated: queueExists,
        downloadedVodsCount,
        streamersCount,
        errors: [],
    };
}

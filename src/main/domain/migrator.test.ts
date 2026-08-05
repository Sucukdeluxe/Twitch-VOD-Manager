import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase, type DbHandle } from '../infra/db';
import { migrateJsonToSqlite } from './migrator';

let tmpDir: string;
let appDataDir: string;
let db: DbHandle;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-'));
    appDataDir = path.join(tmpDir, 'appdata');
    fs.mkdirSync(appDataDir, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'app.db'));
});
afterEach(() => {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeJson(name: string, payload: unknown): string {
    const target = path.join(appDataDir, name);
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf-8');
    return target;
}

describe('migrateJsonToSqlite', () => {
    test('no JSON files: writes migrations_applied marker', () => {
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.configMigrated).toBe(false);
        expect(result.queueMigrated).toBe(false);
        expect(result.downloadedVodsCount).toBe(0);
        expect(result.streamersCount).toBe(0);

        const marker = db.get<{ name: string }>('SELECT name FROM migrations_applied WHERE name = ?', ['v4-to-v5-jsons']);
        expect(marker?.name).toBe('v4-to-v5-jsons');
    });

    test('migrates config.json keys into config_kv', () => {
        writeJson('config.json', {
            language: 'de',
            performance_mode: 'speed',
            metadata_cache_minutes: 30,
            downloaded_vod_ids: ['1', '2', '3'],
            auto_record_streamers: ['foo', 'bar'],
        });
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.configMigrated).toBe(true);

        const lang = db.get<{ value: string }>('SELECT value FROM config_kv WHERE key = ?', ['language']);
        expect(JSON.parse(lang!.value)).toBe('de');

        const perf = db.get<{ value: string }>('SELECT value FROM config_kv WHERE key = ?', ['performance_mode']);
        expect(JSON.parse(perf!.value)).toBe('speed');
    });

    test('migrates downloaded_vod_ids', () => {
        writeJson('config.json', { downloaded_vod_ids: ['100', '200', '300'] });
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.downloadedVodsCount).toBe(3);
        const rows = db.all<{ vod_id: string }>('SELECT vod_id FROM downloaded_vods ORDER BY vod_id');
        expect(rows.map(r => r.vod_id)).toEqual(['100', '200', '300']);
    });

    test('migrates streamers from both auto-record and auto-vod-download lists', () => {
        writeJson('config.json', {
            auto_record_streamers: ['Alice', '@bob'],
            auto_vod_download_streamers: ['bob', 'carol'],
        });
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.streamersCount).toBeGreaterThanOrEqual(3);

        const alice = db.get<{ login: string; auto_record: number }>('SELECT login, auto_record FROM streamers WHERE login = ?', ['alice']);
        expect(alice?.auto_record).toBe(1);

        const bob = db.get<{ login: string; auto_record: number; auto_vod_download: number }>('SELECT login, auto_record, auto_vod_download FROM streamers WHERE login = ?', ['bob']);
        expect(bob?.auto_record).toBe(1);
        expect(bob?.auto_vod_download).toBe(1);

        const carol = db.get<{ login: string; auto_vod_download: number }>('SELECT login, auto_vod_download FROM streamers WHERE login = ?', ['carol']);
        expect(carol?.auto_vod_download).toBe(1);
    });

    test('migrates download_queue.json items', () => {
        writeJson('download_queue.json', [
            { id: 'q1', status: 'pending', streamer: 'foo', vod_id: 'v1', created_at: 1000, updated_at: 1000 },
            { id: 'q2', status: 'completed', streamer: 'bar', vod_id: 'v2', created_at: 2000, updated_at: 3000, completed_at: 3000 },
        ]);
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.queueMigrated).toBe(true);

        const all = db.all<{ id: string; status: string }>('SELECT id, status FROM queue_items ORDER BY id');
        expect(all).toHaveLength(2);
        expect(all[0].status).toBe('pending');
        expect(all[1].status).toBe('completed');
    });

    test('idempotent second run', () => {
        writeJson('config.json', { downloaded_vod_ids: ['1', '2'] });
        migrateJsonToSqlite({ db, appDataDir });
        const result2 = migrateJsonToSqlite({ db, appDataDir });
        expect(result2.alreadyApplied).toBe(true);
        const count = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM downloaded_vods');
        expect(count?.c).toBe(2);
    });

    test('writes .v4-backup of source JSONs', () => {
        const configPath = writeJson('config.json', { language: 'en' });
        migrateJsonToSqlite({ db, appDataDir });
        expect(fs.existsSync(configPath + '.v4-backup')).toBe(true);
        expect(fs.readFileSync(configPath + '.v4-backup', 'utf-8')).toContain('"language": "en"');
    });

    test('malformed JSON is logged + skipped', () => {
        fs.writeFileSync(path.join(appDataDir, 'config.json'), '{ not valid json', 'utf-8');
        const result = migrateJsonToSqlite({ db, appDataDir });
        expect(result.configMigrated).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].source).toBe('config.json');
    });
});

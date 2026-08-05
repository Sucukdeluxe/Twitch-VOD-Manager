import type { DbHandle } from '../infra/db';
import { normalizeLogin } from './config-normalize';

export interface ArchiveFileRecord {
    path: string;
    streamerLogin: string | null;
    sizeBytes: number | null;
    durationSeconds: number | null;
    createdAt: number | null;
    verified: boolean;
}

export interface ArchiveFileWriteInput {
    path: string;
    streamerLogin?: string;
    sizeBytes?: number;
    durationSeconds?: number;
    createdAt?: number;
    verified?: boolean;
}

export interface ArchiveStreamerSummary {
    streamerLogin: string;
    fileCount: number;
    totalBytes: number;
}

export interface ArchiveFilesStore {
    upsert(input: ArchiveFileWriteInput): ArchiveFileRecord;
    get(path: string): ArchiveFileRecord | null;
    list(streamerLogin?: string): ArchiveFileRecord[];
    setVerified(path: string, verified: boolean): void;
    delete(path: string): void;
    summaryByStreamer(): ArchiveStreamerSummary[];
    totalBytes(): number;
}

interface ArchiveRow {
    path: string;
    streamer_login: string | null;
    size_bytes: number | null;
    duration_seconds: number | null;
    created_at: number | null;
    verified: number;
}

function rowToRecord(row: ArchiveRow): ArchiveFileRecord {
    return {
        path: row.path,
        streamerLogin: row.streamer_login,
        sizeBytes: row.size_bytes,
        durationSeconds: row.duration_seconds,
        createdAt: row.created_at,
        verified: row.verified === 1,
    };
}

export function createArchiveFilesStore(db: DbHandle): ArchiveFilesStore {
    return {
        upsert(input) {
            const streamerLogin = input.streamerLogin
                ? normalizeLogin(input.streamerLogin)
                : null;
            const verified = input.verified ? 1 : 0;
            db.run(
                `INSERT INTO archive_files(path, streamer_login, size_bytes, duration_seconds, created_at, verified)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(path) DO UPDATE SET
                    streamer_login = excluded.streamer_login,
                    size_bytes = excluded.size_bytes,
                    duration_seconds = excluded.duration_seconds,
                    created_at = excluded.created_at,
                    verified = excluded.verified`,
                [
                    input.path,
                    streamerLogin,
                    input.sizeBytes ?? null,
                    input.durationSeconds ?? null,
                    input.createdAt ?? null,
                    verified,
                ]
            );
            const row = db.get<ArchiveRow>('SELECT * FROM archive_files WHERE path = ?', [input.path]);
            if (!row) throw new Error(`archive-files-store: upsert lookup failed for ${input.path}`);
            return rowToRecord(row);
        },

        get(p) {
            const row = db.get<ArchiveRow>('SELECT * FROM archive_files WHERE path = ?', [p]);
            return row ? rowToRecord(row) : null;
        },

        list(streamerLogin) {
            const rows = streamerLogin
                ? db.all<ArchiveRow>(
                    'SELECT * FROM archive_files WHERE streamer_login = ? ORDER BY created_at DESC NULLS LAST, path',
                    [normalizeLogin(streamerLogin)]
                )
                : db.all<ArchiveRow>('SELECT * FROM archive_files ORDER BY created_at DESC NULLS LAST, path');
            return rows.map(rowToRecord);
        },

        setVerified(p, verified) {
            db.run(
                'UPDATE archive_files SET verified = ? WHERE path = ?',
                [verified ? 1 : 0, p]
            );
        },

        delete(p) {
            db.run('DELETE FROM archive_files WHERE path = ?', [p]);
        },

        summaryByStreamer() {
            const rows = db.all<{ streamer_login: string | null; cnt: number; total: number | null }>(
                `SELECT streamer_login, COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS total
                 FROM archive_files
                 WHERE streamer_login IS NOT NULL
                 GROUP BY streamer_login
                 ORDER BY total DESC`
            );
            return rows
                .filter((r): r is { streamer_login: string; cnt: number; total: number | null } => r.streamer_login !== null)
                .map(r => ({
                    streamerLogin: r.streamer_login,
                    fileCount: r.cnt,
                    totalBytes: r.total ?? 0,
                }));
        },

        totalBytes() {
            const row = db.get<{ total: number | null }>(
                'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM archive_files'
            );
            return row?.total ?? 0;
        },
    };
}

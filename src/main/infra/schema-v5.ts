// SQLite-Schema v5 fuer Twitch VOD Manager.
// Inline-Konstante damit tsc kein non-TS-Asset kopieren muss.
// Alle Tabellen mit IF NOT EXISTS — Schema-Bootstrap ist idempotent.
// PRAGMA-Statements (WAL etc.) werden separat von db.ts vor dem Bootstrap gesetzt.

export const SCHEMA_V5_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '5');
INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('created_at', CAST(strftime('%s','now') AS TEXT));

CREATE TABLE IF NOT EXISTS config_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS queue_items (
    id TEXT PRIMARY KEY,
    queue_position INTEGER NOT NULL DEFAULT 0,
    streamer_login TEXT,
    vod_id TEXT,
    clip_id TEXT,
    title TEXT,
    output_path TEXT,
    status TEXT NOT NULL,
    progress_pct REAL,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_items(status);
CREATE INDEX IF NOT EXISTS idx_queue_streamer ON queue_items(streamer_login);
CREATE INDEX IF NOT EXISTS idx_queue_created ON queue_items(created_at);

CREATE TABLE IF NOT EXISTS app_secrets (
    key TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    encrypted_value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS downloaded_vods (
    vod_id TEXT PRIMARY KEY,
    downloaded_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS streamers (
    login TEXT PRIMARY KEY,
    auto_record INTEGER NOT NULL DEFAULT 0,
    auto_vod_download INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_streamers_autorec ON streamers(auto_record);
CREATE INDEX IF NOT EXISTS idx_streamers_autodl ON streamers(auto_vod_download);

CREATE TABLE IF NOT EXISTS archive_files (
    path TEXT PRIMARY KEY,
    streamer_login TEXT,
    size_bytes INTEGER,
    duration_seconds INTEGER,
    created_at INTEGER,
    verified INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_archive_streamer ON archive_files(streamer_login);

CREATE TABLE IF NOT EXISTS chunk_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    chunk_seq INTEGER NOT NULL,
    sha1_hex TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(item_id, chunk_seq)
);

CREATE INDEX IF NOT EXISTS idx_chunk_item ON chunk_index(item_id);
CREATE INDEX IF NOT EXISTS idx_chunk_sha1 ON chunk_index(sha1_hex);

CREATE TABLE IF NOT EXISTS oauth_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    twitch_user_id TEXT,
    login TEXT,
    display_name TEXT,
    encrypted_access_token TEXT NOT NULL,
    encrypted_refresh_token TEXT,
    expires_at INTEGER,
    scopes_json TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(provider, twitch_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_provider ON oauth_accounts(provider);
CREATE INDEX IF NOT EXISTS idx_oauth_default ON oauth_accounts(is_default);

CREATE TABLE IF NOT EXISTS migrations_applied (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    payload TEXT
);
`;

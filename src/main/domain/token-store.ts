import type { DbHandle } from '../infra/db';
import type { SecureStorage } from '../infra/secure-storage';

export interface TokenRecord {
    id: number;
    provider: string;
    twitchUserId: string | null;
    login: string | null;
    displayName: string | null;
    expiresAt: number | null;
    scopes: string[];
    isDefault: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface TokenWriteInput {
    provider: string;
    twitchUserId?: string;
    login?: string;
    displayName?: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    isDefault?: boolean;
}

export interface TokenStore {
    upsert(input: TokenWriteInput): TokenRecord;
    list(provider?: string): TokenRecord[];
    getDefault(provider: string): TokenRecord | null;
    setDefault(id: number): void;
    getAccessToken(id: number): string;
    getRefreshToken(id: number): string | null;
    delete(id: number): void;
}

interface TokenRow {
    id: number;
    provider: string;
    twitch_user_id: string | null;
    login: string | null;
    display_name: string | null;
    encrypted_access_token: string;
    encrypted_refresh_token: string | null;
    expires_at: number | null;
    scopes_json: string | null;
    is_default: number;
    created_at: number;
    updated_at: number;
}

function rowToRecord(row: TokenRow): TokenRecord {
    let scopes: string[] = [];
    if (row.scopes_json) {
        try {
            const parsed = JSON.parse(row.scopes_json);
            if (Array.isArray(parsed)) {
                scopes = parsed.filter((s): s is string => typeof s === 'string');
            }
        } catch { /* malformed scopes payload — treat as empty */ }
    }
    return {
        id: row.id,
        provider: row.provider,
        twitchUserId: row.twitch_user_id,
        login: row.login,
        displayName: row.display_name,
        expiresAt: row.expires_at,
        scopes,
        isDefault: row.is_default === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function createTokenStore(db: DbHandle, storage: SecureStorage): TokenStore {
    function getRowOrThrow(id: number): TokenRow {
        const row = db.get<TokenRow>('SELECT * FROM oauth_accounts WHERE id = ?', [id]);
        if (!row) throw new Error(`token-store: account id=${id} not found`);
        return row;
    }

    return {
        upsert(input: TokenWriteInput): TokenRecord {
            const now = Math.floor(Date.now() / 1000);
            const encryptedAccess = storage.encrypt(input.accessToken);
            const encryptedRefresh = input.refreshToken !== undefined
                ? storage.encrypt(input.refreshToken)
                : null;
            const scopesJson = input.scopes && input.scopes.length > 0
                ? JSON.stringify(input.scopes)
                : null;
            const isDefault = input.isDefault ? 1 : 0;
            const twitchUserId = input.twitchUserId ?? null;

            let resultId: number | null = null;

            db.transaction(() => {
                // Insert or update conditional on UNIQUE(provider, twitch_user_id).
                // Sqlite's ON CONFLICT braucht den vollstaendigen Konflikt-Ausdruck.
                db.run(
                    `INSERT INTO oauth_accounts(
                        provider, twitch_user_id, login, display_name,
                        encrypted_access_token, encrypted_refresh_token,
                        expires_at, scopes_json, is_default, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(provider, twitch_user_id) DO UPDATE SET
                        login = excluded.login,
                        display_name = excluded.display_name,
                        encrypted_access_token = excluded.encrypted_access_token,
                        encrypted_refresh_token = excluded.encrypted_refresh_token,
                        expires_at = excluded.expires_at,
                        scopes_json = excluded.scopes_json,
                        is_default = excluded.is_default,
                        updated_at = excluded.updated_at`,
                    [
                        input.provider,
                        twitchUserId,
                        input.login ?? null,
                        input.displayName ?? null,
                        encryptedAccess,
                        encryptedRefresh,
                        input.expiresAt ?? null,
                        scopesJson,
                        isDefault,
                        now,
                        now,
                    ]
                );

                // Wenn dieser Eintrag default ist: alle anderen mit gleichem provider auf 0 setzen.
                if (isDefault === 1) {
                    db.run(
                        `UPDATE oauth_accounts
                         SET is_default = 0, updated_at = ?
                         WHERE provider = ?
                           AND NOT (twitch_user_id IS ? AND provider IS ?)`,
                        [now, input.provider, twitchUserId, input.provider]
                    );
                }

                const lookup = db.get<{ id: number }>(
                    `SELECT id FROM oauth_accounts
                     WHERE provider = ?
                       AND (twitch_user_id IS ? OR (twitch_user_id IS NULL AND ? IS NULL))`,
                    [input.provider, twitchUserId, twitchUserId]
                );
                resultId = lookup?.id ?? null;
            });

            if (resultId === null) throw new Error('token-store: upsert lookup failed');
            return rowToRecord(getRowOrThrow(resultId));
        },

        list(provider?: string): TokenRecord[] {
            const rows = provider
                ? db.all<TokenRow>('SELECT * FROM oauth_accounts WHERE provider = ? ORDER BY id', [provider])
                : db.all<TokenRow>('SELECT * FROM oauth_accounts ORDER BY id');
            return rows.map(rowToRecord);
        },

        getDefault(provider: string): TokenRecord | null {
            const row = db.get<TokenRow>(
                'SELECT * FROM oauth_accounts WHERE provider = ? AND is_default = 1 LIMIT 1',
                [provider]
            );
            return row ? rowToRecord(row) : null;
        },

        setDefault(id: number): void {
            const target = getRowOrThrow(id);
            const now = Math.floor(Date.now() / 1000);
            db.transaction(() => {
                db.run(
                    'UPDATE oauth_accounts SET is_default = 0, updated_at = ? WHERE provider = ?',
                    [now, target.provider]
                );
                db.run(
                    'UPDATE oauth_accounts SET is_default = 1, updated_at = ? WHERE id = ?',
                    [now, id]
                );
            });
        },

        getAccessToken(id: number): string {
            const row = getRowOrThrow(id);
            return storage.decrypt(row.encrypted_access_token);
        },

        getRefreshToken(id: number): string | null {
            const row = getRowOrThrow(id);
            return row.encrypted_refresh_token
                ? storage.decrypt(row.encrypted_refresh_token)
                : null;
        },

        delete(id: number): void {
            db.run('DELETE FROM oauth_accounts WHERE id = ?', [id]);
        },
    };
}

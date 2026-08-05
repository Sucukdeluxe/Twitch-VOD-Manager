import type { DbHandle } from '../infra/db';

export interface ChunkRecord {
    id: number;
    itemId: string;
    chunkSeq: number;
    sha1Hex: string;
    bytes: number;
    createdAt: number;
}

export interface ChunkIndexStore {
    /**
     * Persistiert einen Chunk-Hash. Bei (itemId, chunkSeq)-Konflikt wird das
     * bestehende Tupel ersetzt — die zuletzt geschriebene sha1 gewinnt
     * (sinnvoll, falls dasselbe Segment neu geladen wurde).
     */
    record(itemId: string, chunkSeq: number, sha1Hex: string, bytes: number): ChunkRecord;
    listForItem(itemId: string): ChunkRecord[];
    countForItem(itemId: string): number;
    lookupBySha1(sha1Hex: string): ChunkRecord[];
    deleteForItem(itemId: string): number;
}

interface ChunkRow {
    id: number;
    item_id: string;
    chunk_seq: number;
    sha1_hex: string;
    bytes: number;
    created_at: number;
}

function rowToRecord(row: ChunkRow): ChunkRecord {
    return {
        id: row.id,
        itemId: row.item_id,
        chunkSeq: row.chunk_seq,
        sha1Hex: row.sha1_hex,
        bytes: row.bytes,
        createdAt: row.created_at,
    };
}

export function createChunkIndexStore(db: DbHandle): ChunkIndexStore {
    return {
        record(itemId, chunkSeq, sha1Hex, bytes) {
            const now = Math.floor(Date.now() / 1000);
            db.run(
                `INSERT INTO chunk_index(item_id, chunk_seq, sha1_hex, bytes, created_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(item_id, chunk_seq) DO UPDATE SET
                    sha1_hex = excluded.sha1_hex,
                    bytes = excluded.bytes,
                    created_at = excluded.created_at`,
                [itemId, chunkSeq, sha1Hex, bytes, now]
            );
            const row = db.get<ChunkRow>(
                'SELECT * FROM chunk_index WHERE item_id = ? AND chunk_seq = ?',
                [itemId, chunkSeq]
            );
            if (!row) throw new Error(`chunk-index-store: record lookup failed for ${itemId}/${chunkSeq}`);
            return rowToRecord(row);
        },

        listForItem(itemId) {
            const rows = db.all<ChunkRow>(
                'SELECT * FROM chunk_index WHERE item_id = ? ORDER BY chunk_seq ASC',
                [itemId]
            );
            return rows.map(rowToRecord);
        },

        countForItem(itemId) {
            const row = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM chunk_index WHERE item_id = ?', [itemId]);
            return row?.c ?? 0;
        },

        lookupBySha1(sha1Hex) {
            const rows = db.all<ChunkRow>(
                'SELECT * FROM chunk_index WHERE sha1_hex = ? ORDER BY item_id, chunk_seq',
                [sha1Hex]
            );
            return rows.map(rowToRecord);
        },

        deleteForItem(itemId) {
            const before = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM chunk_index WHERE item_id = ?', [itemId])?.c ?? 0;
            db.run('DELETE FROM chunk_index WHERE item_id = ?', [itemId]);
            return before;
        },
    };
}

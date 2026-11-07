import { LIMITS, fail, integer } from './protocol';
/** Durable opaque V1 records. Never build a Y.Doc or a whole-page snapshot in the relay. */
export interface Cursor {
    version: number;
    offset: number;
}
export class Journal {
    constructor(private sql: SqlStorage) {
        for (const prefix of ['', 'backup_'])
            sql.exec(`
      CREATE TABLE IF NOT EXISTS ${prefix}journal_entries(page_id TEXT NOT NULL,version INTEGER NOT NULL,op_key TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,quarantined INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(page_id,version));
      CREATE INDEX IF NOT EXISTS ${prefix}journal_ops ON ${prefix}journal_entries(op_key);
      CREATE TABLE IF NOT EXISTS ${prefix}journal_chunks(page_id TEXT NOT NULL,version INTEGER NOT NULL,part INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(page_id,version,part));`);
    }
    bytes(): number { return this.sql.exec<{
        n: number;
    }>('SELECT COALESCE(SUM(bytes),0) AS n FROM journal_entries').one().n; }
    append(pageId: string, version: number, opKey: string, bytes: Uint8Array, sha256: string) {
        this.sql.exec('INSERT INTO journal_entries VALUES(?,?,?,?,?,0)', pageId, version, opKey, bytes.length, sha256);
        for (let offset = 0, part = 0; offset < bytes.length; offset += LIMITS.chunkBytes, part++)
            this.sql.exec('INSERT INTO journal_chunks VALUES(?,?,?,?)', pageId, version, part, bytes.slice(offset, offset + LIMITS.chunkBytes));
    }
    quarantine(keys: string[]) {
        for (const key of keys)
            this.sql.exec('UPDATE journal_entries SET quarantined=1 WHERE op_key=?', key);
    }
    freeze() {
        this.sql.exec('DELETE FROM backup_journal_entries');
        this.sql.exec('DELETE FROM backup_journal_chunks');
        this.sql.exec('INSERT INTO backup_journal_entries SELECT * FROM journal_entries');
        this.sql.exec('INSERT INTO backup_journal_chunks SELECT * FROM journal_chunks');
    }
    clearBackup() { this.sql.exec('DELETE FROM backup_journal_entries'); this.sql.exec('DELETE FROM backup_journal_chunks'); }
    reset() { this.sql.exec('DELETE FROM journal_entries'); this.sql.exec('DELETE FROM journal_chunks'); }
    page(pageId: string, through: number, cursor: Cursor = { version: 0, offset: 0 }, backup = false, max = 1024000) {
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor))
            return fail(400, 'invalid_journal_cursor');
        integer(cursor.version);
        integer(cursor.offset);
        if (cursor.version > through + 1 || (cursor.version === 0 && cursor.offset !== 0))
            return fail(400, 'invalid_journal_cursor');
        const prefix = backup ? 'backup_' : '';
        const output = new Uint8Array(max);
        let used = 0, next = { ...cursor };
        const entries = this.sql.exec<{
            version: number;
            bytes: number;
        }>(`SELECT version,bytes FROM ${prefix}journal_entries WHERE page_id=? AND version>=? AND version<=? AND quarantined=0 ORDER BY version`, pageId, cursor.version, through);
        for (const entry of entries) {
            let offset = entry.version === cursor.version ? cursor.offset : 0;
            if (offset > entry.bytes + 4)
                return fail(400, 'invalid_journal_cursor');
            if (offset < 4) {
                const header = new Uint8Array(4);
                new DataView(header.buffer).setUint32(0, entry.bytes, true);
                const count = Math.min(4 - offset, max - used);
                output.set(header.subarray(offset, offset + count), used);
                used += count;
                offset += count;
            }
            if (used < max && offset < entry.bytes + 4) {
                const rawOffset = offset - 4, firstPart = Math.floor(rawOffset / LIMITS.chunkBytes);
                for (const row of this.sql.exec<{
                    part: number;
                    bytes: ArrayBuffer;
                }>(`SELECT part,bytes FROM ${prefix}journal_chunks WHERE page_id=? AND version=? AND part>=? ORDER BY part`, pageId, entry.version, firstPart)) {
                    const raw = new Uint8Array(row.bytes), start = row.part === firstPart ? rawOffset % LIMITS.chunkBytes : 0, count = Math.min(raw.length - start, max - used);
                    output.set(raw.subarray(start, start + count), used);
                    used += count;
                    offset += count;
                    if (used === max)
                        break;
                }
            }
            next = offset === entry.bytes + 4 ? { version: entry.version + 1, offset: 0 } : { version: entry.version, offset };
            if (used === max)
                break;
        }
        const more = this.sql.exec<{
            n: number;
        }>(`SELECT COUNT(*) AS n FROM ${prefix}journal_entries WHERE page_id=? AND version>=? AND version<=? AND quarantined=0`, pageId, next.version, through).one().n > 0;
        return { bytes: output.subarray(0, used), cursor: next, hasMore: more };
    }
}
/** Streaming decoder used for bounded R2 recovery segments. One raw update is at most updateBytes. */
export class JournalDecoder {
    private prefix: number[] = [];
    private expected = 0;
    private current: Uint8Array | null = null;
    private offset = 0;
    feed(bytes: Uint8Array, consume: (update: Uint8Array) => void) {
        let pos = 0;
        while (pos < bytes.length) {
            if (this.current === null) {
                while (this.prefix.length < 4 && pos < bytes.length)
                    this.prefix.push(bytes[pos++]);
                if (this.prefix.length < 4)
                    break;
                this.expected = new DataView(Uint8Array.from(this.prefix).buffer).getUint32(0, true);
                this.prefix = [];
                if (this.expected < 2 || this.expected > LIMITS.updateBytes)
                    return fail(400, 'invalid_journal_record');
                this.current = new Uint8Array(this.expected);
                this.offset = 0;
            }
            const count = Math.min(this.expected - this.offset, bytes.length - pos);
            this.current.set(bytes.subarray(pos, pos + count), this.offset);
            pos += count;
            this.offset += count;
            if (this.offset === this.expected) {
                const ready = this.current;
                this.current = null;
                consume(ready);
            }
        }
    }
    finish() { if (this.prefix.length || this.current !== null)
        return fail(400, 'truncated_journal'); }
}

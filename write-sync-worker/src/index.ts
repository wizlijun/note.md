import * as Y from 'yjs';
import { Journal, JournalDecoder, Cursor } from './journal';
import { WireValidator } from './wire-validator';
import { PackedWireValidator } from './packed-wire-validator';
import { SqlMeter } from './sql-meter';
import { issueToken, verifyToken, sealCredential, verifyCredential } from './auth';
import { ApiError, Claims, LIMITS, Page, b64, date, fail, hash, id, integer, json, randomSecret, readJson, unb64, } from './protocol';
export interface Env {
    SPACES: DurableObjectNamespace;
    BACKUPS: R2Bucket;
    SIGNING_KEY: string;
    PROVISION_KEY: string;
    LOCAL_SQL_METRICS?: string;
}
interface SocketState extends Claims {
    hello: boolean;
    subscriptions: string[];
}
const MAX_SPACE_BYTES = 64000000;
const MAX_OPERATIONS = 200000;
function errorResponse(error: unknown) {
    return error instanceof ApiError
        ? json({ error: error.code }, error.status)
        : json({ error: 'internal_error' }, 500);
}
export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        try {
            const url = new URL(req.url);
            if (url.pathname === '/health' && req.method === 'GET')
                return json({ service: 'sumi-sync', protocol: 1 });
            if (['/admin/provision', '/admin/recover'].includes(url.pathname) && req.method === 'POST') {
                if (!env.PROVISION_KEY ||
                    (await hash(req.headers.get('authorization') ?? '')) !==
                        (await hash('Bearer ' + env.PROVISION_KEY)))
                    return fail(401, 'unauthorized');
                const body = await readJson(req);
                if (url.pathname === '/admin/recover' && typeof body.backupKey !== 'string')
                    return fail(400, 'backup_key_required');
                const spaceId = crypto.randomUUID();
                return env.SPACES.get(env.SPACES.idFromName(spaceId)).fetch('https://space/internal/provision', {
                    method: 'POST',
                    body: JSON.stringify({
                        spaceId,
                        ...(url.pathname === '/admin/recover' ? { backupKey: body.backupKey } : {}),
                    }),
                });
            }
            if ((url.pathname === '/v1/token' || url.pathname === '/v1/pair/redeem') &&
                req.method === 'POST') {
                const body = await readJson(req);
                const spaceId = id(body.spaceId);
                const kind = url.pathname === '/v1/token' ? 'device' : 'pair';
                if (!(await verifyCredential(env.SIGNING_KEY, spaceId, kind, kind === 'device' ? body.deviceSecret : body.code)))
                    return fail(401, 'unauthorized');
                return env.SPACES.get(env.SPACES.idFromName(spaceId)).fetch('https://space' + url.pathname, { method: 'POST', body: JSON.stringify(body) });
            }
            const claims = await verifyToken(env.SIGNING_KEY, req.headers.get('authorization'));
            // The DO performs the bounded JSON read. Forward the stream unchanged
            // instead of materializing/stringifying large updates a second time in
            // the edge Worker (which has a much smaller CPU budget on Free).
            const forwarded = new Request(req);
            // Replace all caller-supplied identity. A DO is only reachable through this Worker.
            forwarded.headers.set('x-sumi-claims', JSON.stringify(claims));
            return env.SPACES.get(env.SPACES.idFromName(claims.spaceId)).fetch(forwarded);
        }
        catch (error) {
            if (req.body && !req.bodyUsed)
                await req.body.cancel();
            return errorResponse(error);
        }
    },
};
export class SumiSpace {
    private readonly instanceId = crypto.randomUUID();
    private sql: SqlStorage;
    private readonly sqlMeter?: SqlMeter;
    private backupInFlight = false;
    private journal: Journal;
    private validator: Pick<WireValidator, 'validate' | 'reset'>;
    private readonly validatorSchema: 'legacy-v1' | 'packed-v1';
    constructor(private ctx: DurableObjectState, private env: Env) {
        this.sqlMeter = env.LOCAL_SQL_METRICS === '1' ? new SqlMeter(ctx.storage.sql) : undefined;
        this.sql = this.sqlMeter?.sql ?? ctx.storage.sql;
        this.journal = new Journal(this.sql);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invitations (hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,created_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,generation INTEGER NOT NULL,deleted INTEGER NOT NULL,local_date TEXT,sequence INTEGER,after_id TEXT,version INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS page_filename ON pages(local_date,sequence);
      CREATE TABLE IF NOT EXISTS operations (device_id TEXT NOT NULL,op_id TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(device_id,op_id));
      CREATE TABLE IF NOT EXISTS changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT,page_id TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);`);
        const configured = this.one<{value: string}>("SELECT value FROM settings WHERE key='wire_schema'")?.value;
        const legacyTable = this.one("SELECT name FROM sqlite_master WHERE type='table' AND name='wire_ops'");
        const legacyData = !!legacyTable && !!this.one('SELECT 1 AS present FROM wire_ops LIMIT 1');
        const selected = configured ?? (legacyData ? 'legacy-v1' : 'packed-v1');
        if (selected !== 'legacy-v1' && selected !== 'packed-v1')
            throw new Error('unsupported durable wire index schema');
        this.validatorSchema = selected;
        this.validator = selected === 'legacy-v1' ? new WireValidator(this.sql) : new PackedWireValidator(this.sql);
        if (!configured)
            this.sql.exec("INSERT INTO settings VALUES('wire_schema',?)", selected);
    }
    private rows<T extends Record<string, SqlStorageValue>>(query: string, ...args: SqlStorageValue[]): T[] {
        return this.sql.exec<T>(query, ...args).toArray();
    }
    private one<T extends Record<string, SqlStorageValue>>(query: string, ...args: SqlStorageValue[]): T | undefined {
        return this.rows<T>(query, ...args)[0];
    }
    private space(): string {
        return (this.one<{
            value: string;
        }>('SELECT value FROM settings WHERE key=?', 'space_id')?.value ??
            fail(404, 'space_not_found'));
    }
    private active(deviceId: string) {
        if (!this.one('SELECT id FROM devices WHERE id=? AND revoked=0', deviceId))
            return fail(401, 'device_revoked');
    }
    private auth(req: Request): Claims {
        let claims: Claims;
        try {
            claims = JSON.parse(req.headers.get('x-sumi-claims') ?? '');
        }
        catch {
            return fail(401, 'unauthorized');
        }
        if (claims.spaceId !== this.space() || claims.exp <= Math.floor(Date.now() / 1000))
            return fail(401, 'unauthorized');
        this.active(claims.deviceId);
        return claims;
    }
    private rateAuth() {
        const now = Math.floor(Date.now() / 60000);
        const old = this.one<{
            window: number;
            count: number;
        }>('SELECT window,count FROM auth_limits WHERE key=?', 'auth');
        if (old?.window === now && old.count >= 60)
            return fail(429, 'authentication_rate_limited');
        this.sql.exec('INSERT OR REPLACE INTO auth_limits VALUES (?,?,?)', 'auth', now, old?.window === now ? old.count + 1 : 1);
    }
    async fetch(req: Request): Promise<Response> {
        // Freeze SQLite synchronously, but never hold the input gate across R2 uploads.
        if (new URL(req.url).pathname === '/v1/backup' && req.method === 'POST') {
            try {
                this.auth(req);
                if (req.body)
                    await readJson(req);
                return json(await this.backup());
            }
            catch (error) {
                return errorResponse(error);
            }
        }
        // Upload streams must finish before taking the input gate; otherwise a
        // remote body can wait on events that the gate itself is holding closed.
        let body: Record<string, any> | undefined;
        try {
            if (req.method === 'POST' || (req.method === 'DELETE' && /^\/v1\/pages\/[^/]+$/.test(new URL(req.url).pathname)))
                body = await readJson(req);
        } catch (error) {
            return errorResponse(error);
        }
        return this.ctx.blockConcurrencyWhile(async () => {
            try {
                return await this.route(req, body);
            }
            catch (error) {
                if (req.body && !req.bodyUsed)
                    await req.body.cancel();
                return errorResponse(error);
            }
        });
    }
    private async route(req: Request, parsed?: Record<string, any>): Promise<Response> {
        const url = new URL(req.url);
        const path = url.pathname;
        if (path === '/internal/provision' && req.method === 'POST') {
            if (this.one('SELECT key FROM settings WHERE key=?', 'space_id'))
                return fail(409, 'already_provisioned');
            const body = parsed!;
            const spaceId = id(body.spaceId);
            const device = await this.newDevice(spaceId);
            const recovered = body.backupKey ? await this.loadBackup(body.backupKey) : [];
            this.ctx.storage.transactionSync(() => {
                this.sql.exec('INSERT INTO settings VALUES (?,?)', 'space_id', spaceId);
                this.sql.exec('INSERT INTO devices VALUES (?,?,0)', device.deviceId, device.secretHash);
                for (const { page } of recovered) {
                    this.sql.exec('INSERT INTO pages VALUES (?,?,?,?,?,?,?,?)', page.id, page.epoch, page.generation, page.deleted, page.local_date, page.sequence, page.after_id, page.version);
                    this.appendChange(page);
                }
            });
            if (recovered.length)
                await this.ctx.storage.setAlarm(Date.now() + LIMITS.backupIntervalMs);
            return json({
                spaceId,
                deviceId: device.deviceId,
                deviceSecret: device.deviceSecret,
                ...(await issueToken(this.env.SIGNING_KEY, spaceId, device.deviceId)),
            }, 201);
        }
        if (path === '/v1/token' && req.method === 'POST') {
            this.rateAuth();
            const body = parsed!;
            const deviceId = id(body.deviceId);
            if (id(body.spaceId) !== this.space() ||
                typeof body.deviceSecret !== 'string' ||
                body.deviceSecret.length !== 88)
                return fail(401, 'unauthorized');
            const record = this.one<{
                secret_hash: string;
                revoked: number;
            }>('SELECT secret_hash,revoked FROM devices WHERE id=?', deviceId);
            if (!record || record.revoked || record.secret_hash !== (await hash(body.deviceSecret)))
                return fail(401, 'unauthorized');
            return json(await issueToken(this.env.SIGNING_KEY, this.space(), deviceId));
        }
        if (path === '/v1/pair/redeem' && req.method === 'POST') {
            this.rateAuth();
            const body = parsed!;
            if (id(body.spaceId) !== this.space() ||
                typeof body.code !== 'string' ||
                body.code.length !== 88)
                return fail(401, 'invalid_invitation');
            const codeHash = await hash(body.code);
            const invitation = this.one<{
                expires: number;
                created_by: string;
            }>('SELECT expires,created_by FROM invitations WHERE hash=?', codeHash);
            if (!invitation || invitation.expires <= Date.now())
                return fail(401, 'invalid_invitation');
            this.active(invitation.created_by);
            const device = await this.newDevice();
            this.ctx.storage.transactionSync(() => {
                this.sql.exec('DELETE FROM invitations WHERE hash=?', codeHash);
                this.sql.exec('INSERT INTO devices VALUES (?,?,0)', device.deviceId, device.secretHash);
            });
            return json({
                spaceId: this.space(),
                deviceId: device.deviceId,
                deviceSecret: device.deviceSecret,
                ...(await issueToken(this.env.SIGNING_KEY, this.space(), device.deviceId)),
            }, 201);
        }
        const claims = this.auth(req);
        if (path === '/v1/diagnostics' && req.method === 'GET') {
            return json({ instanceId: this.instanceId, sockets: this.ctx.getWebSockets().length, wireSchema: this.validatorSchema, sql: this.sqlMeter?.snapshot() });
        }
        if (path === '/v1/pair' && req.method === 'POST') {
            this.sql.exec('DELETE FROM invitations WHERE expires<=?', Date.now());
            if ((this.one<{
                n: number;
            }>('SELECT COUNT(*) AS n FROM invitations')?.n ?? 0) >= 32)
                return fail(429, 'invitation_limit');
            const code = await sealCredential(this.env.SIGNING_KEY, this.space(), 'pair', randomSecret());
            const expiresAt = Date.now() + LIMITS.invitationSeconds * 1000;
            this.sql.exec('INSERT INTO invitations VALUES (?,?,?)', await hash(code), expiresAt, claims.deviceId);
            return json({ spaceId: this.space(), code, expiresAt }, 201);
        }
        if (path === '/v1/devices' && req.method === 'GET')
            return json({ devices: this.rows('SELECT id,revoked FROM devices ORDER BY id') });
        const deviceMatch = path.match(/^\/v1\/devices\/([^/]+)$/);
        if (deviceMatch && req.method === 'DELETE') {
            const deviceId = id(deviceMatch[1]);
            if (!this.one('SELECT id FROM devices WHERE id=?', deviceId))
                return fail(404, 'device_not_found');
            this.ctx.storage.transactionSync(() => {
                this.sql.exec('UPDATE devices SET revoked=1 WHERE id=?', deviceId);
                this.sql.exec('DELETE FROM invitations WHERE created_by=?', deviceId);
            });
            for (const ws of this.ctx.getWebSockets()) {
                const state = ws.deserializeAttachment() as SocketState;
                if (state.deviceId === deviceId)
                    ws.close(4001, 'device_revoked');
            }
            return json({ revoked: true });
        }
        if (path === '/v1/ws' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            if (this.ctx.getWebSockets().length >= LIMITS.connections)
                return fail(429, 'connection_limit');
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            this.ctx.acceptWebSocket(server);
            server.serializeAttachment({
                ...claims,
                hello: false,
                subscriptions: [],
            } satisfies SocketState);
            return new Response(null, { status: 101, webSocket: client });
        }
        if (path === '/v1/pages' && req.method === 'GET') {
            const cursor = integer(Number(url.searchParams.get('cursor') ?? 0));
            const changes = this.rows<{
                cursor: number;
                value: string;
            }>('SELECT cursor,value FROM changes WHERE cursor>? ORDER BY cursor LIMIT ?', cursor, LIMITS.changesPerPage);
            return json({
                changes: changes.map((row) => ({ cursor: row.cursor, page: JSON.parse(row.value) })),
                cursor: changes.at(-1)?.cursor ?? cursor,
                hasMore: changes.length === LIMITS.changesPerPage,
            });
        }
        if (path === '/v1/pages' && req.method === 'POST') {
            const body = parsed!;
            return json(await this.create(claims, body), 201);
        }
        const match = path.match(/^\/v1\/pages\/([^/]+)(?:\/(update|sync|restore))?$/);
        if (match) {
            const pageId = id(match[1]);
            const action = match[2];
            if (req.method === 'GET' && !action)
                return json({ page: this.page(pageId) });
            if (req.method === 'POST' && action === 'update')
                return json(await this.update(claims, pageId, parsed!));
            if (req.method === 'POST' && action === 'sync') {
                const body = parsed!;
                return json(await this.sync(pageId, body));
            }
            if (req.method === 'DELETE' && !action)
                return json(await this.lifecycle(claims, pageId, parsed!, true));
            if (req.method === 'POST' && action === 'restore')
                return json(await this.lifecycle(claims, pageId, parsed!, false));
        }
        return fail(404, 'not_found');
    }
    private async newDevice(spaceId = this.space()) {
        if ((this.one<{
            n: number;
        }>('SELECT COUNT(*) AS n FROM devices WHERE revoked=0')?.n ?? 0) >=
            LIMITS.devices)
            return fail(429, 'device_limit');
        const deviceId = crypto.randomUUID(), deviceSecret = await sealCredential(this.env.SIGNING_KEY, spaceId, 'device', randomSecret());
        return { deviceId, deviceSecret, secretHash: await hash(deviceSecret) };
    }
    private page(pageId: string): Page {
        return this.one<any>('SELECT * FROM pages WHERE id=?', pageId) ?? fail(404, 'page_not_found');
    }
    private appendChange(page: Page) {
        this.sql.exec('INSERT INTO changes(page_id,value) VALUES (?,?)', page.id, JSON.stringify(page));
    }
    private async operation(claims: Claims, body: Record<string, any>, kind: string, run: () => unknown) {
        const opId = id(body.opId), fingerprint = await hash(kind + '\n' + JSON.stringify(body));
        const existing = this.one<{
            fingerprint: string;
            response: string;
        }>('SELECT fingerprint,response FROM operations WHERE device_id=? AND op_id=?', claims.deviceId, opId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                return fail(409, 'operation_id_reused');
            return JSON.parse(existing.response);
        }
        if ((this.one<{
            n: number;
        }>('SELECT COUNT(*) AS n FROM operations')?.n ?? 0) >= MAX_OPERATIONS)
            return fail(507, 'operation_quota');
        return this.ctx.storage.transactionSync(() => {
            const result = run();
            this.sql.exec('INSERT INTO operations VALUES (?,?,?,?)', claims.deviceId, opId, fingerprint, JSON.stringify(result));
            return result;
        });
    }
    private async create(claims: Claims, body: Record<string, any>) {
        const pageId = id(body.pageId), localDate = body.localDate == null ? null : date(body.localDate), afterId = body.afterId == null ? null : id(body.afterId);
        const result = await this.operation(claims, body, 'create', () => {
            if (this.one('SELECT id FROM pages WHERE id=?', pageId))
                return fail(409, 'page_exists');
            if ((this.one<{
                n: number;
            }>('SELECT COUNT(*) AS n FROM pages')?.n ?? 0) >= LIMITS.pages)
                return fail(507, 'page_quota');
            if (afterId)
                this.page(afterId);
            const sequence = localDate === null
                ? null
                : (this.one<{
                    n: number;
                }>('SELECT MAX(sequence) AS n FROM pages WHERE local_date=?', localDate)?.n ?? 0) + 1;
            const page: Page = {
                id: pageId,
                epoch: 1,
                generation: 0,
                deleted: 0,
                local_date: localDate,
                sequence,
                after_id: afterId,
                version: 0,
            };
            this.sql.exec('INSERT INTO pages VALUES (?,?,?,?,?,?,?,?)', page.id, page.epoch, page.generation, page.deleted, page.local_date, page.sequence, page.after_id, page.version);
            this.appendChange(page);
            return { page };
        });
        this.notifyDirectory(pageId);
        if ((await this.ctx.storage.getAlarm()) === null)
            await this.ctx.storage.setAlarm(Date.now() + LIMITS.backupIntervalMs);
        return result;
    }
    private async update(claims: Claims, pageId: string, body: Record<string, any>, maxBytes: number = LIMITS.updateBytes) {
        const epoch = integer(body.epoch, 1), generation = integer(body.generation), update = unb64(body.update, maxBytes), checksum = await hash(update);
        let applied = false, directoryChanged = false, quarantined: string[] = [];
        const result = await this.operation(claims, { opId: body.opId, epoch, generation, update: body.update, ...(body.firstWriteDate === undefined ? {} : { firstWriteDate: body.firstWriteDate }) }, 'update:' + pageId, () => {
            const page = this.page(pageId);
            if (page.deleted)
                return fail(409, 'page_deleted');
            if (page.epoch !== epoch)
                return fail(409, 'epoch_mismatch');
            if (page.generation !== generation)
                return fail(409, 'generation_mismatch');
            if (this.journal.bytes() + update.length > MAX_SPACE_BYTES)
                return fail(507, 'space_quota');
            const opKey = claims.deviceId + ':' + id(body.opId);
            const validation = this.validator.validate(pageId, epoch, opKey, update);
            quarantined = validation.quarantined;
            this.journal.quarantine(quarantined);
            if (quarantined.length) {
                const revision = this.quarantineRevision(pageId) + 1;
                this.sql.exec('INSERT OR REPLACE INTO settings VALUES(?,?)', 'quarantine:' + pageId, String(revision));
            }
            page.version++;
            this.journal.append(pageId, page.version, opKey, update, checksum);
            if (page.local_date === null && validation.hasContent) {
                page.local_date = date(body.firstWriteDate);
                page.sequence = (this.one<{
                    n: number;
                }>('SELECT MAX(sequence) AS n FROM pages WHERE local_date=?', page.local_date)?.n ?? 0) + 1;
                directoryChanged = true;
            }
            this.sql.exec('UPDATE pages SET version=?,local_date=?,sequence=? WHERE id=?', page.version, page.local_date, page.sequence, pageId);
            if (directoryChanged)
                this.appendChange(page);
            applied = true;
            return { type: 'ack', opId: body.opId, pageId, epoch, generation, version: page.version, localDate: page.local_date, sequence: page.sequence, validationPending: validation.pending };
        });
        if (!applied)
            return result;
        if (directoryChanged)
            this.notifyDirectory(pageId);
        if (quarantined.length) {
            this.broadcast(pageId, { type: 'resync_required', page: this.page(pageId), reason: 'quarantined_update', quarantineRevision: this.quarantineRevision(pageId) });
        }
        else if (update.length > LIMITS.websocketUpdateBytes) {
            const transferId = crypto.randomUUID(), count = Math.ceil(update.length / LIMITS.chunkBytes);
            this.broadcast(pageId, { type: 'sync_begin', transferId, page: this.page(pageId), stateVector: 'AA==', sha256: checksum, chunks: count });
            for (let offset = 0, index = 0; offset < update.length; offset += LIMITS.chunkBytes, index++)
                this.broadcast(pageId, { type: 'sync_chunk', transferId, index, data: b64(update.subarray(offset, offset + LIMITS.chunkBytes)) });
            this.broadcast(pageId, { type: 'sync_end', transferId });
        }
        else
            this.broadcast(pageId, { type: 'update', pageId, epoch, generation, opId: body.opId, deviceId: claims.deviceId, update: body.update, version: (result as any).version });
        if ((await this.ctx.storage.getAlarm()) === null)
            await this.ctx.storage.setAlarm(Date.now() + LIMITS.backupIntervalMs);
        return result;
    }
    private quarantineRevision(pageId: string): number {
        return Number(this.one<{
            value: string;
        }>('SELECT value FROM settings WHERE key=?', 'quarantine:' + pageId)?.value ?? 0);
    }
    private async lifecycle(claims: Claims, pageId: string, body: Record<string, any>, deleted: boolean) {
        const generation = integer(body.generation);
        let applied = false;
        const result = await this.operation(claims, body, (deleted ? 'delete:' : 'restore:') + pageId, () => {
            const page = this.page(pageId);
            if (page.generation !== generation)
                return fail(409, 'generation_mismatch');
            if (Boolean(page.deleted) === deleted)
                return fail(409, 'invalid_lifecycle_transition');
            applied = true;
            page.deleted = deleted ? 1 : 0;
            page.generation++;
            page.version++;
            this.sql.exec('UPDATE pages SET deleted=?,generation=?,version=? WHERE id=?', page.deleted, page.generation, page.version, pageId);
            this.appendChange(page);
            return { page };
        });
        if (applied) {
            this.broadcast(pageId, { type: 'page', ...(result as object) });
            this.notifyDirectory(pageId);
        }
        return result;
    }
    private async sync(pageId: string, body: Record<string, any>, batchBytes = 1024000) {
        const current = this.page(pageId);
        if (current.deleted)
            return fail(409, 'page_deleted');
        if (integer(body.epoch, 1) !== current.epoch)
            return fail(409, 'epoch_mismatch');
        try {
            Y.decodeStateVector(unb64(body.stateVector, LIMITS.vectorBytes));
        }
        catch {
            return fail(400, 'invalid_state_vector');
        }
        const through = body.throughVersion === undefined ? current.version : integer(body.throughVersion);
        if (through > current.version)
            return fail(400, 'invalid_journal_version');
        const quarantineRevision = this.quarantineRevision(pageId);
        if (body.quarantineRevision !== undefined && integer(body.quarantineRevision) !== quarantineRevision)
            return fail(409, 'journal_changed');
        if (body.generation !== undefined && integer(body.generation) !== current.generation)
            return fail(409, 'generation_mismatch');
        const batch = this.journal.page(pageId, through, body.cursor, false, batchBytes);
        const chunks = [];
        for (let offset = 0; offset < batch.bytes.length; offset += LIMITS.chunkBytes)
            chunks.push(b64(batch.bytes.subarray(offset, offset + LIMITS.chunkBytes)));
        return { page: { ...current, version: through }, stateVector: 'AA==', format: 'journal-v1', sha256: await hash(batch.bytes), chunks, cursor: batch.cursor, hasMore: batch.hasMore, throughVersion: through, quarantineRevision };
    }
    private notifyDirectory(pageId: string) {
        const change = this.one<{
            cursor: number;
            value: string;
        }>('SELECT cursor,value FROM changes WHERE page_id=? ORDER BY cursor DESC LIMIT 1', pageId);
        if (!change)
            return;
        const message = JSON.stringify({
            type: 'directory',
            cursor: change.cursor,
            page: JSON.parse(change.value),
        });
        for (const ws of this.ctx.getWebSockets()) {
            const state = ws.deserializeAttachment() as SocketState;
            if (state.hello && state.exp > Math.floor(Date.now() / 1000)) {
                try {
                    ws.send(message);
                }
                catch {
                    ws.close(1011, 'send_failed');
                }
            }
        }
    }
    private broadcast(pageId: string, message: unknown) {
        const raw = JSON.stringify(message);
        for (const ws of this.ctx.getWebSockets()) {
            const state = ws.deserializeAttachment() as SocketState;
            if (state.exp <= Math.floor(Date.now() / 1000)) {
                ws.close(4001, 'token_expired');
                continue;
            }
            if (state.hello && state.subscriptions.includes(pageId)) {
                try {
                    ws.send(raw);
                }
                catch {
                    ws.close(1011, 'send_failed');
                }
            }
        }
    }
    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        await this.ctx.blockConcurrencyWhile(async () => {
            try {
                const state = ws.deserializeAttachment() as SocketState;
                if (state.exp <= Math.floor(Date.now() / 1000))
                    return ws.close(4001, 'token_expired');
                this.active(state.deviceId);
                if (typeof message !== 'string' ||
                    new TextEncoder().encode(message).length > LIMITS.messageBytes)
                    return fail(413, 'payload_too_large');
                let body: Record<string, any>;
                try {
                    body = JSON.parse(message);
                }
                catch {
                    return fail(400, 'invalid_json');
                }
                if (!body || typeof body !== 'object' || Array.isArray(body))
                    return fail(400, 'invalid_json');
                if (body.type === 'hello') {
                    if (body.protocol !== 1)
                        return fail(426, 'protocol_mismatch');
                    state.hello = true;
                    ws.serializeAttachment(state);
                    ws.send(JSON.stringify({
                        type: 'hello',
                        protocol: 1,
                        spaceId: state.spaceId,
                        deviceId: state.deviceId,
                    }));
                    return;
                }
                if (!state.hello)
                    return fail(400, 'hello_required');
                if (body.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong', instanceId: this.instanceId }));
                    return;
                }
                const pageId = id(body.pageId);
                if (body.type === 'unsubscribe') {
                    state.subscriptions = state.subscriptions.filter((x) => x !== pageId);
                    ws.serializeAttachment(state);
                    return;
                }
                if (body.type === 'subscribe') {
                    if (!state.subscriptions.includes(pageId) &&
                        state.subscriptions.length >= LIMITS.subscriptions)
                        return fail(429, 'subscription_limit');
                    if (!state.subscriptions.includes(pageId))
                        state.subscriptions.push(pageId);
                    ws.serializeAttachment(state);
                    const transferId = crypto.randomUUID();
                    let request = body, totalIndex = 0, started = false;
                    while (true) {
                        const sync = await this.sync(pageId, request, 192000);
                        if (!started) {
                            ws.send(JSON.stringify({ type: 'sync_begin', transferId, page: sync.page, stateVector: 'AA==', format: 'journal-v1', sha256: '', chunks: null, quarantineRevision: sync.quarantineRevision }));
                            started = true;
                        }
                        // Each bounded page is independently checksummed; ordering and final count are mandatory.
                        ws.send(JSON.stringify({ type: 'journal_page', transferId, index: totalIndex++, sha256: sync.sha256, chunks: sync.chunks }));
                        if (!sync.hasMore)
                            break;
                        request = { ...body, cursor: sync.cursor, throughVersion: sync.throughVersion, generation: sync.page.generation, quarantineRevision: sync.quarantineRevision };
                    }
                    ws.send(JSON.stringify({ type: 'sync_end', transferId, pages: totalIndex }));
                    return;
                }
                if (body.type === 'update') {
                    if (!state.subscriptions.includes(pageId))
                        return fail(403, 'subscription_required');
                    ws.send(JSON.stringify(await this.update(state, pageId, body, LIMITS.websocketUpdateBytes)));
                    return;
                }
                return fail(400, 'unknown_message');
            }
            catch (error) {
                ws.send(JSON.stringify({
                    type: 'error',
                    error: error instanceof ApiError ? error.code : 'internal_error',
                }));
                if (error instanceof ApiError && error.status === 401)
                    ws.close(4001, error.code);
            }
        });
    }
    webSocketClose(ws: WebSocket, code: number, reason: string) {
        ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
    }
    webSocketError(ws: WebSocket) {
        ws.close(1011, 'socket_error');
    }
    private async loadBackup(key: unknown): Promise<{
        page: Page;
    }[]> {
        if (this.one('SELECT key FROM settings WHERE key=?', 'space_id'))
            return fail(409, 'already_provisioned');
        const reset = () => this.ctx.storage.transactionSync(() => { this.journal.reset(); this.validator.reset(); });
        reset();
        try {
            return await this.restoreBackup(key);
        }
        catch (error) {
            reset();
            throw error;
        }
    }
    private async restoreBackup(key: unknown): Promise<{
        page: Page;
    }[]> {
        if (typeof key !== 'string' || !/^[-0-9a-f]+\/\d{4}-\d{2}-\d{2}\/[-0-9a-f]+\/manifest\.json$/.test(key))
            return fail(400, 'invalid_backup_key');
        const object = await this.env.BACKUPS.get(key);
        if (!object || object.size > 4000000)
            return fail(404, 'backup_not_found');
        const raw = await object.text();
        if (object.customMetadata?.sha256 !== await hash(raw))
            return fail(409, 'backup_checksum_mismatch');
        const manifest = JSON.parse(raw);
        if (manifest.schema !== 2 || !Array.isArray(manifest.entries) || manifest.entries.length > LIMITS.pages)
            return fail(400, 'invalid_backup_manifest');
        const prefix = key.slice(0, -'manifest.json'.length), entries: {
            page: Page;
        }[] = [], ids = new Set<string>();
        let total = 0;
        for (const entry of manifest.entries) {
            const page = entry.page as Page;
            id(page.id);
            integer(page.epoch, 1);
            integer(page.generation);
            integer(page.version);
            if (page.deleted !== 0 && page.deleted !== 1)
                return fail(400, 'invalid_backup_page');
            if (page.local_date !== null) {
                date(page.local_date);
                integer(page.sequence, 1);
            }
            else if (page.sequence !== null)
                return fail(400, 'invalid_backup_page');
            if (page.after_id !== null)
                id(page.after_id);
            if (ids.has(page.id) || !Array.isArray(entry.segments) || entry.segments.length > 1000)
                return fail(400, 'invalid_backup_page');
            ids.add(page.id);
            const decoder = new JournalDecoder();
            let version = 0;
            for (let index = 0; index < entry.segments.length; index++) {
                const segment = entry.segments[index];
                if (segment.key !== `${prefix}${page.id}/${index}.updates`)
                    return fail(400, 'invalid_backup_page');
                const item = await this.env.BACKUPS.get(segment.key);
                if (!item || item.size > 1024000)
                    return fail(409, 'backup_incomplete');
                total += item.size;
                if (total > MAX_SPACE_BYTES + MAX_OPERATIONS * 4)
                    return fail(413, 'backup_too_large');
                const bytes = new Uint8Array(await item.arrayBuffer());
                if (segment.bytes !== bytes.length || segment.sha256 !== await hash(bytes))
                    return fail(409, 'backup_checksum_mismatch');
                const ready: Uint8Array[] = [];
                decoder.feed(bytes, update => ready.push(update));
                for (const update of ready) {
                    const checksum = await hash(update), opKey = 'restore:' + crypto.randomUUID();
                    this.ctx.storage.transactionSync(() => {
                        const check = this.validator.validate(page.id, page.epoch, opKey, update);
                        if (check.quarantined.length)
                            return fail(409, 'backup_invalid_history');
                        this.journal.append(page.id, ++version, opKey, update, checksum);
                    });
                }
            }
            decoder.finish();
            if (version !== entry.records || version > page.version)
                return fail(409, 'backup_record_count');
            entries.push({ page });
        }
        for (const entry of entries)
            if (entry.page.after_id && !ids.has(entry.page.after_id))
                return fail(409, 'backup_missing_anchor');
        return entries;
    }
    private freezeBackup() {
        const pending = this.one<{
            value: string;
        }>('SELECT value FROM settings WHERE key=?', 'pending_backup');
        if (pending)
            return JSON.parse(pending.value);
        const spaceId = this.space(), backupId = crypto.randomUUID(), createdAt = new Date().toISOString();
        const job = {
            schema: 2,
            spaceId,
            backupId,
            createdAt,
            prefix: `${spaceId}/${createdAt.slice(0, 10)}/${backupId}`,
            pages: this.rows<any>('SELECT * FROM pages ORDER BY id'),
        };
        this.ctx.storage.transactionSync(() => {
            this.journal.freeze();
            this.sql.exec('INSERT INTO settings VALUES (?,?)', 'pending_backup', JSON.stringify(job));
        });
        return job;
    }
    private async backup() {
        if (this.backupInFlight)
            return { pending: true };
        this.backupInFlight = true;
        try {
            const job = this.freezeBackup(), entries = [];
            for (const page of job.pages) {
                const segments = [];
                let cursor: Cursor = { version: 0, offset: 0 }, index = 0;
                while (true) {
                    const part = this.journal.page(page.id, page.version, cursor, true);
                    if (part.bytes.length) {
                        const key = `${job.prefix}/${page.id}/${index++}.updates`, sha256 = await hash(part.bytes);
                        await this.env.BACKUPS.put(key, part.bytes, { customMetadata: { sha256 } });
                        segments.push({ key, sha256, bytes: part.bytes.length });
                    }
                    if (!part.hasMore)
                        break;
                    cursor = part.cursor;
                }
                const records = this.one<{
                    n: number;
                }>('SELECT COUNT(*) AS n FROM backup_journal_entries WHERE page_id=? AND quarantined=0', page.id)?.n ?? 0;
                entries.push({ page, segments, records });
            }
            const manifest = { schema: 2, spaceId: job.spaceId, backupId: job.backupId, createdAt: job.createdAt, entries };
            const raw = JSON.stringify(manifest), key = `${job.prefix}/manifest.json`;
            await this.env.BACKUPS.put(key, raw, { customMetadata: { sha256: await hash(raw) } });
            this.ctx.storage.transactionSync(() => {
                this.sql.exec('INSERT OR REPLACE INTO settings VALUES (?,?)', 'last_backup', key);
                this.sql.exec('DELETE FROM settings WHERE key=?', 'pending_backup');
                this.journal.clearBackup();
            });
            return { backupId: job.backupId, key, pages: entries.length };
        }
        finally {
            this.backupInFlight = false;
        }
    }
    async alarm() {
        await this.backup();
        await this.ctx.storage.setAlarm(Date.now() + LIMITS.backupIntervalMs);
    }
}

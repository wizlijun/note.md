import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { b64, hash, unb64 } from '../src/protocol';
import { SumiSpace, Env } from '../src/index';
import { JournalDecoder } from '../src/journal';
import rustFixture from '../../write-core/tests/fixtures/yrs-v1.json';
import maliciousPending from '../../write-core/tests/fixtures/pending-invalid-v1.json';
const bindings = env as unknown as Env;
const uuid = () => crypto.randomUUID();
async function request(path: string, method = 'GET', body?: unknown, token?: string) {
    return SELF.fetch('https://sumi.test' + path, {
        method,
        headers: {
            ...(token ? { authorization: 'Bearer ' + token } : {}),
            'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}
async function provision() {
    const r = await request('/admin/provision', 'POST', {}, 'test-admin-secret');
    expect(r.status).toBe(201);
    return r.json<any>();
}
async function create(auth: any) {
    const body = { opId: uuid(), pageId: uuid(), localDate: '2026-11-07' };
    const r = await request('/v1/pages', 'POST', body, auth.accessToken);
    expect(r.status).toBe(201);
    return { body, ...(await r.json<any>()) };
}
function docFor(pageId: string, clientID?: number) {
    const d = new Y.Doc();
    if (clientID)
        d.clientID = clientID;
    d.getText('body');
    d.getMap('timing');
    const p = d.getMap('page');
    p.set('schema', 1);
    p.set('page_id', pageId);
    p.set('epoch', 1);
    p.set('root_line_id', uuid());
    return d;
}
async function send(auth: any, pageId: string, update: Uint8Array, opId = uuid(), generation = 0) {
    return request(`/v1/pages/${pageId}/update`, 'POST', { opId, epoch: 1, generation, update: b64(update) }, auth.accessToken);
}
function mergePacked(bytes: Uint8Array): Uint8Array {
    const records: Uint8Array[] = [];
    const decoder = new JournalDecoder();
    decoder.feed(bytes, u => records.push(u));
    decoder.finish();
    return records.length ? Y.mergeUpdates(records) : new Uint8Array([0, 0]);
}
async function sync(auth: any, pageId: string, doc = new Y.Doc()) {
    doc.getText('body');
    doc.getMap('page');
    doc.getMap('timing');
    let body: any = { epoch: 1, stateVector: b64(Y.encodeStateVector(doc)) }, data: any;
    const parts: Uint8Array[] = [];
    while (true) {
        const response = await request(`/v1/pages/${pageId}/sync`, 'POST', body, auth.accessToken);
        expect(response.status).toBe(200);
        data = await response.json<any>();
        const batch = data.chunks.map((s: string) => unb64(s, 64000));
        const raw = new Uint8Array(batch.reduce((n: number, p: Uint8Array) => n + p.length, 0));
        let at = 0;
        for (const p of batch) {
            raw.set(p, at);
            at += p.length;
        }
        expect(await hash(raw)).toBe(data.sha256);
        parts.push(raw);
        if (!data.hasMore)
            break;
        body = { ...body, cursor: data.cursor, throughVersion: data.throughVersion, quarantineRevision: data.quarantineRevision, generation: data.page.generation };
    }
    const raw = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        raw.set(p, at);
        at += p.length;
    }
    Y.applyUpdate(doc, mergePacked(raw));
    return { doc, data };
}
describe('Sumi actual SQLite DO', () => {
    it('requires administrator provisioning and signed per-space authentication', async () => {
        expect((await request('/admin/provision', 'POST', {})).status).toBe(401);
        expect((await request('/v1/pages')).status).toBe(401);
        const a = await provision(), b = await provision(), p = await create(a);
        expect((await request(`/v1/pages/${p.page.id}`, 'GET', undefined, b.accessToken)).status).toBe(404);
        expect((await request('/v1/pages', 'GET', undefined, a.accessToken + 'x')).status).toBe(401);
        expect((await request('/v1/token', 'POST', {
            spaceId: a.spaceId,
            deviceId: a.deviceId,
            deviceSecret: 'x'.repeat(43),
        })).status).toBe(401);
        expect((await request('/v1/token', 'POST', a)).status).toBe(200);
    });
    it('redeems once and revokes refresh, access and invitations', async () => {
        const a = await provision(), invite = await (await request('/v1/pair', 'POST', {}, a.accessToken)).json<any>();
        const pair = await request('/v1/pair/redeem', 'POST', invite);
        expect(pair.status).toBe(201);
        const b = await pair.json<any>();
        expect((await request('/v1/pair/redeem', 'POST', invite)).status).toBe(401);
        const bInvite = await (await request('/v1/pair', 'POST', {}, b.accessToken)).json<any>();
        expect((await SELF.fetch('https://sumi.test/v1/devices/' + b.deviceId, { method: 'DELETE', headers: { authorization: 'Bearer ' + a.accessToken }, body: '' })).status).toBe(200);
        expect((await request('/v1/pages', 'GET', undefined, b.accessToken)).status).toBe(401);
        expect((await request('/v1/token', 'POST', b)).status).toBe(401);
        expect((await request('/v1/pair/redeem', 'POST', bInvite)).status).toBe(401);
    });
    it('allocates permanent sequences and idempotent directory operations', async () => {
        const a = await provision(), first = await create(a), retry = await (await request('/v1/pages', 'POST', first.body, a.accessToken)).json<any>();
        expect(retry.page).toEqual(first.page);
        expect((await create(a)).page.sequence).toBe(2);
        const list = await (await request('/v1/pages', 'GET', undefined, a.accessToken)).json<any>();
        expect(list.changes).toHaveLength(2);
        expect((await (await request('/v1/pages?cursor=' + list.cursor, 'GET', undefined, a.accessToken)).json<any>()).changes).toHaveLength(0);
        expect((await request('/v1/pages', 'POST', { ...first.body, localDate: '2026-11-08' }, a.accessToken)).status).toBe(409);
    });
    it('reads a delayed upload stream before entering the durable input gate', async () => {
        const a = await provision(), p = await create(a), doc = docFor(p.page.id);
        doc.getText('body').insert(0, '中'.repeat(100000));
        const bytes = new TextEncoder().encode(JSON.stringify({opId: uuid(), epoch: 1, generation: 0, update: b64(Y.encodeStateAsUpdate(doc))}));
        const body = new ReadableStream<Uint8Array>({start(controller) {
            controller.enqueue(bytes.subarray(0, 31));
            setTimeout(() => { controller.enqueue(bytes.subarray(31)); controller.close(); }, 25);
        }});
        const response = await SELF.fetch('https://sumi.test/v1/pages/' + p.page.id + '/update', {method: 'POST', headers: {authorization: 'Bearer ' + a.accessToken}, body});
        expect(response.status).toBe(200);
        expect((await sync(a, p.page.id)).doc.getText('body').length).toBe(100000);
    });
    it('merges concurrent offline edits and acknowledges retries once', async () => {
        const auth = await provision(), p = await create(auth), base = docFor(p.page.id, 10);
        base.getText('body').insert(0, '你😀好\n');
        expect((await send(auth, p.page.id, Y.encodeStateAsUpdate(base))).status).toBe(200);
        const a = new Y.Doc(), b = new Y.Doc();
        a.clientID = 20;
        b.clientID = 30;
        Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(base));
        const sv = Y.encodeStateVector(base);
        a.getText('body').insert(1, '甲');
        b.getText('body').insert(1, '乙');
        const ua = Y.encodeStateAsUpdate(a, sv), ub = Y.encodeStateAsUpdate(b, sv), opId = uuid();
        const first = await (await send(auth, p.page.id, ub, opId)).json<any>();
        expect(await (await send(auth, p.page.id, ub, opId)).json<any>()).toEqual(first);
        expect((await send(auth, p.page.id, ua)).status).toBe(200);
        const out = await sync(auth, p.page.id);
        Y.applyUpdate(a, ub);
        Y.applyUpdate(b, ua);
        expect(out.doc.getText('body').toString()).toBe(a.getText('body').toString());
        expect(a.getText('body').toString()).toBe(b.getText('body').toString());
        expect(out.data.page.version).toBe(3);
        await runInDurableObject(bindings.SPACES.get(bindings.SPACES.idFromName(auth.spaceId)), async (_instance: any, state: any) => {
            const fresh = new SumiSpace(state, bindings);
            const response = await fresh.fetch(new Request('https://space/v1/pages/' + p.page.id, {
                headers: {
                    'x-sumi-claims': JSON.stringify({
                        spaceId: auth.spaceId,
                        deviceId: auth.deviceId,
                        v: 1,
                        exp: Math.floor(Date.now() / 1000) + 100,
                    }),
                },
            }));
            expect((await response.json<any>()).page.version).toBe(3);
        });
    });
    it('retains causally pending updates arriving before their prerequisites', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id, 40);
        d.getText('body').insert(0, 'a');
        const first = Y.encodeStateAsUpdate(d), sv = Y.encodeStateVector(d);
        d.getText('body').insert(1, 'b');
        const second = Y.encodeStateAsUpdate(d, sv);
        expect((await send(a, p.page.id, second)).status).toBe(200);
        expect((await send(a, p.page.id, first)).status).toBe(200);
        expect((await sync(a, p.page.id)).doc.getText('body').toString()).toBe('ab');
    });
    it('retains tombstones and rejects stale offline edits after restore', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, 'saved');
        await send(a, p.page.id, Y.encodeStateAsUpdate(d));
        const del = { opId: uuid(), generation: 0 };
        expect((await request(`/v1/pages/${p.page.id}`, 'DELETE', del, a.accessToken)).status).toBe(200);
        expect((await request(`/v1/pages/${p.page.id}`, 'DELETE', del, a.accessToken)).status).toBe(200);
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d))).status).toBe(409);
        expect((await request(`/v1/pages/${p.page.id}/restore`, 'POST', { opId: uuid(), generation: 1 }, a.accessToken)).status).toBe(200);
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d))).status).toBe(409);
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d), uuid(), 2)).status).toBe(200);
        expect((await sync(a, p.page.id)).doc.getText('body').toString()).toBe('saved');
    });
    it('rejects corrupt, oversized, and identity-changing updates atomically', async () => {
        const a = await provision(), p = await create(a);
        expect((await send(a, p.page.id, new Uint8Array([255, 255]))).status).toBe(400);
        expect((await send(a, p.page.id, new Uint8Array(16000001))).status).toBe(413);
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(docFor(uuid())))).status).toBe(409);
        expect((await (await request(`/v1/pages/${p.page.id}`, 'GET', undefined, a.accessToken)).json<any>())
            .page.version).toBe(0);
    });
    it('creates checksummed R2 snapshots recoverable into a fresh CRDT document', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, '备份😀');
        await send(a, p.page.id, Y.encodeStateAsUpdate(d));
        const r = await request('/v1/backup', 'POST', {}, a.accessToken);
        expect(r.status).toBe(200);
        const info = await r.json<any>();
        const manifest = await (await bindings.BACKUPS.get(info.key))!.json<any>();
        expect(manifest.entries).toHaveLength(1);
        const object = await bindings.BACKUPS.get(manifest.entries[0].segments[0].key), recovered = new Y.Doc();
        Y.applyUpdate(recovered, mergePacked(new Uint8Array(await object!.arrayBuffer())));
        expect(recovered.getText('body').toString()).toBe('备份😀');
        expect(object!.customMetadata!.sha256).toBe(manifest.entries[0].segments[0].sha256);
    });
    it('rolls back a failed durable write without acknowledging or advancing state', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, 'must persist');
        await runInDurableObject(bindings.SPACES.get(bindings.SPACES.idFromName(a.spaceId)), async (_i: any, state: any) => {
            state.storage.sql.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON journal_chunks BEGIN SELECT RAISE(ABORT, 'test disk failure'); END");
        });
        const opId = uuid();
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d), opId)).status).toBe(500);
        expect((await (await request(`/v1/pages/${p.page.id}`, 'GET', undefined, a.accessToken)).json<any>())
            .page.version).toBe(0);
        await runInDurableObject(bindings.SPACES.get(bindings.SPACES.idFromName(a.spaceId)), async (_i: any, state: any) => {
            state.storage.sql.exec('DROP TRIGGER fail_snapshot');
        });
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d), opId)).status).toBe(200);
        expect((await sync(a, p.page.id)).doc.getText('body').toString()).toBe('must persist');
    });
    it('chunks a large snapshot with a verifiable checksum and reconstructs the complete document', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, '文字😀'.repeat(20000));
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d))).status).toBe(200);
        const out = await sync(a, p.page.id);
        expect(out.data.chunks.length).toBeGreaterThan(1);
        expect(out.doc.getText('body').toString()).toBe(d.getText('body').toString());
    });
    it('rehydrates WebSocket subscriptions and closes a revoked connection', async () => {
        const a = await provision(), p = await create(a);
        const response = await SELF.fetch('https://sumi.test/v1/ws', {
            headers: { upgrade: 'websocket', authorization: 'Bearer ' + a.accessToken },
        });
        expect(response.status).toBe(101);
        const ws = response.webSocket!;
        ws.accept();
        const queue: any[] = [];
        const waiters: ((x: any) => void)[] = [];
        ws.addEventListener('message', (event) => {
            const item = JSON.parse(event.data as string);
            const waiter = waiters.shift();
            if (waiter)
                waiter(item);
            else
                queue.push(item);
        });
        const next = () => queue.length
            ? Promise.resolve(queue.shift())
            : new Promise<any>((resolve) => waiters.push(resolve));
        ws.send(JSON.stringify({ type: 'hello', protocol: 1 }));
        expect((await next()).type).toBe('hello');
        ws.send(JSON.stringify({
            type: 'subscribe',
            pageId: p.page.id,
            epoch: 1,
            stateVector: b64(Y.encodeStateVector(new Y.Doc())),
        }));
        expect((await next()).type).toBe('sync_begin');
        expect((await next()).type).toBe('journal_page');
        expect((await next()).type).toBe('sync_end');
        await runInDurableObject(bindings.SPACES.get(bindings.SPACES.idFromName(a.spaceId)), async (_i: any, state: any) => {
            const fresh = new SumiSpace(state, bindings);
            await fresh.webSocketMessage(state.getWebSockets()[0], JSON.stringify({ type: 'ping' }));
        });
        expect((await next()).type).toBe('pong');
        const closed = new Promise<number>((resolve) => ws.addEventListener('close', (event) => resolve(event.code)));
        expect((await request(`/v1/devices/${a.deviceId}`, 'DELETE', undefined, a.accessToken)).status).toBe(200);
        expect(await closed).toBe(4001);
        ws.close();
    });
    it('keeps an empty page undated and assigns its first writing date once across concurrent devices', async () => {
        const a = await provision(), pageId = uuid();
        const created = await (await request('/v1/pages', 'POST', { opId: uuid(), pageId, localDate: null }, a.accessToken)).json<any>();
        expect(created.page.local_date).toBeNull();
        expect(created.page.sequence).toBeNull();
        const base = docFor(pageId, 100);
        expect((await send(a, pageId, Y.encodeStateAsUpdate(base))).status).toBe(200);
        const one = new Y.Doc(), two = new Y.Doc();
        one.clientID = 200;
        two.clientID = 300;
        Y.applyUpdate(one, Y.encodeStateAsUpdate(base));
        Y.applyUpdate(two, Y.encodeStateAsUpdate(base));
        const sv = Y.encodeStateVector(base);
        one.getText('body').insert(0, 'next-day');
        two.getText('body').insert(0, 'remote');
        const update = (d: Y.Doc, day: string) => request(`/v1/pages/${pageId}/update`, 'POST', {
            opId: uuid(),
            epoch: 1,
            generation: 0,
            update: b64(Y.encodeStateAsUpdate(d, sv)),
            firstWriteDate: day,
        }, a.accessToken);
        expect((await update(one, '2026-11-08')).status).toBe(200);
        expect((await update(two, '2026-11-07')).status).toBe(200);
        const page = (await (await request(`/v1/pages/${pageId}`, 'GET', undefined, a.accessToken)).json<any>()).page;
        expect(page.local_date).toBe('2026-11-08');
        expect(page.sequence).toBe(1);
        const entries = (await (await request('/v1/pages', 'GET', undefined, a.accessToken)).json<any>()).changes;
        expect(entries.at(-1).page.local_date).toBe('2026-11-08');
        const out = await sync(a, pageId);
        expect(out.doc.getText('body').toString()).toContain('next-day');
        expect(out.doc.getText('body').toString()).toContain('remote');
    });
    it('rejects an undated first edit without silently inventing a date or saving the update', async () => {
        const a = await provision(), pageId = uuid();
        await request('/v1/pages', 'POST', { opId: uuid(), pageId, localDate: null }, a.accessToken);
        const d = docFor(pageId);
        d.getText('body').insert(0, 'text');
        expect((await send(a, pageId, Y.encodeStateAsUpdate(d))).status).toBe(400);
        const out = await sync(a, pageId);
        expect(out.doc.getText('body').toString()).toBe('');
        expect(out.data.page.version).toBe(0);
    });
    it('recovers a checksummed service backup into a new credential-isolated space', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, 'disaster recovery');
        await send(a, p.page.id, Y.encodeStateAsUpdate(d));
        const info = await (await request('/v1/backup', 'POST', {}, a.accessToken)).json<any>();
        expect((await request('/admin/recover', 'POST', { backupKey: info.key }, a.accessToken)).status).toBe(401);
        const recovered = await request('/admin/recover', 'POST', { backupKey: info.key }, 'test-admin-secret');
        expect(recovered.status).toBe(201);
        const b = await recovered.json<any>();
        expect(b.spaceId).not.toBe(a.spaceId);
        expect((await sync(b, p.page.id)).doc.getText('body').toString()).toBe('disaster recovery');
        const manifestObject = await bindings.BACKUPS.get(info.key);
        const manifest = await manifestObject!.json<any>();
        await bindings.BACKUPS.put(manifest.entries[0].segments[0].key, new Uint8Array([0]));
        expect((await request('/admin/recover', 'POST', { backupKey: info.key }, 'test-admin-secret'))
            .status).toBe(409);
    });
    it('rejects mutation of immutable timing events and root line identity', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id), eventId = uuid();
        d.getText('body').insert(0, 'body');
        d.getMap('timing').set(eventId, JSON.stringify([1, 100, 1, []]));
        await send(a, p.page.id, Y.encodeStateAsUpdate(d));
        const sv = Y.encodeStateVector(d);
        d.getMap('timing').set(eventId, JSON.stringify([1, 1, 1, []]));
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d, sv))).status).toBe(409);
        const fresh = (await sync(a, p.page.id)).doc;
        const before = Y.encodeStateVector(fresh);
        fresh.getMap('page').set('root_line_id', uuid());
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(fresh, before))).status).toBe(409);
        expect((await sync(a, p.page.id)).doc.getMap('timing').get(eventId)).toBe(JSON.stringify([1, 100, 1, []]));
    });
    it('merges the actual Rust wire fixture in reverse and duplicate order through SQLite', async () => {
        const a = await provision(), pageId = rustFixture.pageId;
        expect((await request('/v1/pages', 'POST', { opId: uuid(), pageId, localDate: '2026-11-07' }, a.accessToken)).status).toBe(201);
        const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        for (const update of [...rustFixture.updates]
            .reverse()
            .concat([rustFixture.base], rustFixture.updates))
            expect((await send(a, pageId, decode(update))).status).toBe(200);
        const out = await sync(a, pageId);
        expect(out.doc.getText('body').toString()).toBe(rustFixture.expected.body);
        const full = new Y.Doc();
        full.getText('body');
        full.getMap('timing');
        full.getMap('page');
        Y.applyUpdate(full, decode(rustFixture.full));
        expect(out.doc.toJSON()).toEqual(full.toJSON());
    });
    it('expires a hibernation attachment before serving another message', async () => {
        const a = await provision(), response = await SELF.fetch('https://sumi.test/v1/ws', {
            headers: { upgrade: 'websocket', authorization: 'Bearer ' + a.accessToken },
        }), ws = response.webSocket!;
        ws.accept();
        const closed = new Promise<number>((resolve) => ws.addEventListener('close', (event) => resolve(event.code)));
        await runInDurableObject(bindings.SPACES.get(bindings.SPACES.idFromName(a.spaceId)), async (_i: any, state: any) => {
            const socket = state.getWebSockets()[0], attachment = socket.deserializeAttachment();
            attachment.exp = 1;
            socket.serializeAttachment(attachment);
            await new SumiSpace(state, bindings).webSocketMessage(socket, JSON.stringify({ type: 'ping' }));
        });
        expect(await closed).toBe(4001);
        ws.close();
    });
    it('does not hold editing behind slow R2 and keeps the backup at its frozen revision', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, 'before');
        await send(a, p.page.id, Y.encodeStateAsUpdate(d));
        const stub = bindings.SPACES.get(bindings.SPACES.idFromName(a.spaceId));
        const result = await runInDurableObject(stub, async (instance: any, state: any) => {
            let release!: () => void, entered!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve)), started = new Promise<void>((resolve) => (entered = resolve));
            const original = instance.env;
            let first = true;
            instance.env = {
                ...original,
                BACKUPS: {
                    put: async (...args: any[]) => {
                        if (first) {
                            first = false;
                            entered();
                            await gate;
                        }
                        return original.BACKUPS.put(...args);
                    },
                },
            };
            const pending = instance.backup();
            await started;
            const edited = new Y.Doc();
            Y.applyUpdate(edited, Y.encodeStateAsUpdate(d));
            const vector = Y.encodeStateVector(edited);
            edited.getText('body').insert(edited.getText('body').length, ' after');
            const response = await instance.fetch(new Request('https://space/v1/pages/' + p.page.id + '/update', {
                method: 'POST',
                headers: {
                    'x-sumi-claims': JSON.stringify({
                        spaceId: a.spaceId,
                        deviceId: a.deviceId,
                        v: 1,
                        exp: Math.floor(Date.now() / 1000) + 100,
                    }),
                },
                body: JSON.stringify({
                    opId: uuid(),
                    epoch: 1,
                    generation: 0,
                    update: b64(Y.encodeStateAsUpdate(edited, vector)),
                }),
            }));
            expect(response.status).toBe(200);
            release();
            const backup = await pending;
            instance.env = original;
            return backup;
        });
        expect((await sync(a, p.page.id)).doc.getText('body').toString()).toBe('before after');
        const manifest = await (await bindings.BACKUPS.get(result.key))!.json<any>(), raw = await (await bindings.BACKUPS.get(manifest.entries[0].segments[0].key))!.arrayBuffer(), backupDoc = new Y.Doc();
        Y.applyUpdate(backupDoc, mergePacked(new Uint8Array(raw)));
        expect(backupDoc.getText('body').toString()).toBe('before');
    });
    it('resumes the same durable backup job after R2 failure and a new DO instance', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, 'recoverable');
        await send(a, p.page.id, Y.encodeStateAsUpdate(d));
        await runInDurableObject(bindings.SPACES.get(bindings.SPACES.idFromName(a.spaceId)), async (instance: any, state: any) => {
            const original = instance.env;
            instance.env = {
                ...original,
                BACKUPS: {
                    put: async () => {
                        throw new Error('test R2 unavailable');
                    },
                },
            };
            await expect(instance.backup()).rejects.toThrow('test R2 unavailable');
            const job = JSON.parse(state.storage.sql.exec("SELECT value FROM settings WHERE key='pending_backup'").one()
                .value);
            expect(state.storage.sql.exec("SELECT value FROM settings WHERE key='last_backup'").toArray()).toHaveLength(0);
            instance.env = original;
            const fresh = new SumiSpace(state, bindings) as any;
            const resumed = await fresh.backup();
            expect(resumed.backupId).toBe(job.backupId);
            expect(state.storage.sql.exec("SELECT value FROM settings WHERE key='pending_backup'").toArray()).toHaveLength(0);
        });
    });
    it('broadcasts committed binary edits across devices and supports HTTP retry of a WS operation', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, 'initial');
        await send(a, p.page.id, Y.encodeStateAsUpdate(d));
        const invite = await (await request('/v1/pair', 'POST', {}, a.accessToken)).json<any>(), b = await (await request('/v1/pair/redeem', 'POST', invite)).json<any>();
        async function connect(auth: any) {
            const response = await SELF.fetch('https://sumi.test/v1/ws', {
                headers: { upgrade: 'websocket', authorization: 'Bearer ' + auth.accessToken },
            }), ws = response.webSocket!;
            ws.accept();
            const queue: any[] = [], waiters: ((x: any) => void)[] = [];
            ws.addEventListener('message', (event) => {
                const item = JSON.parse(event.data as string), waiter = waiters.shift();
                if (waiter)
                    waiter(item);
                else
                    queue.push(item);
            });
            const next = () => queue.length
                ? Promise.resolve(queue.shift())
                : new Promise<any>((resolve) => waiters.push(resolve));
            ws.send(JSON.stringify({ type: 'hello', protocol: 1 }));
            expect((await next()).type).toBe('hello');
            ws.send(JSON.stringify({
                type: 'subscribe',
                pageId: p.page.id,
                epoch: 1,
                stateVector: b64(Y.encodeStateVector(new Y.Doc())),
            }));
            const begin = await next();
            expect(begin.type).toBe('sync_begin');
            let frame = await next();
            while (frame.type === 'journal_page') {
                frame = await next();
            }
            expect(frame.type).toBe('sync_end');
            return {
                ws,
                next,
                closed: new Promise<void>((resolve) => ws.addEventListener('close', () => resolve())),
            };
        }
        const left = await connect(a), right = await connect(b), vector = Y.encodeStateVector(d);
        d.getText('body').insert(7, ' live');
        const update = Y.encodeStateAsUpdate(d, vector), opId = uuid();
        left.ws.send(JSON.stringify({
            type: 'update',
            pageId: p.page.id,
            opId,
            epoch: 1,
            generation: 0,
            update: b64(update),
        }));
        const remote = await right.next();
        expect(remote.type).toBe('update');
        expect(remote.deviceId).toBe(a.deviceId);
        expect((await left.next()).type).toBe('update');
        const ack = await left.next();
        expect(ack.type).toBe('ack');
        const retry = await (await send(a, p.page.id, update, opId)).json<any>();
        expect(retry).toEqual(ack);
        const out = await sync(b, p.page.id);
        expect(out.doc.getText('body').toString()).toBe('initial live');
        expect(out.data.page.version).toBe(2);
        const bulkVector = Y.encodeStateVector(d);
        left.ws.send(JSON.stringify({
            type: 'update', pageId: p.page.id, opId: uuid(), epoch: 1, generation: 0,
            update: b64(new Uint8Array(256001)),
        }));
        expect(await left.next()).toEqual({ type: 'error', error: 'payload_too_large' });
        d.getText('body').insert(d.getText('body').length, '墨'.repeat(100000));
        const bulk = Y.encodeStateAsUpdate(d, bulkVector);
        expect(bulk.length).toBeGreaterThan(256000);
        const bulkAck = await (await send(a, p.page.id, bulk)).json<any>();
        expect(bulkAck.version).toBe(3);
        for (const peer of [left, right]) {
            const begin = await peer.next();
            expect(begin.type).toBe('sync_begin');
            expect(begin.page.version).toBe(3);
            const parts: Uint8Array[] = [];
            for (let index = 0; index < begin.chunks; index++) {
                const chunk = await peer.next();
                expect(chunk.type).toBe('sync_chunk');
                expect(chunk.index).toBe(index);
                expect(chunk.transferId).toBe(begin.transferId);
                parts.push(unb64(chunk.data, 64000));
            }
            expect(await peer.next()).toEqual({ type: 'sync_end', transferId: begin.transferId });
            const joined = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
            let offset = 0;
            for (const part of parts) {
                joined.set(part, offset);
                offset += part.length;
            }
            expect(await hash(joined)).toBe(begin.sha256);
            expect(joined).toEqual(bulk);
        }
        Y.applyUpdate(out.doc, bulk);
        expect(out.doc.getText('body').toString()).toBe(d.getText('body').toString());
        left.ws.close(1000);
        right.ws.close(1000);
        await Promise.all([left.closed, right.closed]);
    });
    it('rejects malformed timing metadata before acknowledging a document', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, 'body');
        const key = uuid();
        d.getMap('timing').set(key, 'not JSON');
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d))).status).toBe(400);
        d.getMap('timing').set(key, JSON.stringify({
            at_ms: 1,
            source: 'device',
            spans: [
                {
                    start: { tname: 'page' },
                    end: { tname: 'body' },
                    first_ms: 1,
                    touch: true,
                    origins: [],
                },
            ],
        }));
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d))).status).toBe(400);
        expect((await sync(a, p.page.id)).data.page.version).toBe(0);
    });
    it('accepts 100000 Chinese characters as one atomic bulk edit', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, '文'.repeat(100000));
        const update = Y.encodeStateAsUpdate(d);
        expect(update.length).toBeGreaterThan(256000);
        expect((await send(a, p.page.id, update)).status).toBe(200);
        const out = await sync(a, p.page.id);
        expect(out.doc.getText('body').toString()).toBe('文'.repeat(100000));
        expect(out.data.page.version).toBe(1);
    });
    it('quarantines an invalid causal predecessor without rejecting its valid dependency', async () => {
        const a = await provision(), pageId = maliciousPending.pageId;
        await request('/v1/pages', 'POST', { opId: uuid(), pageId, localDate: '2026-11-07' }, a.accessToken);
        expect((await send(a, pageId, unb64(maliciousPending.base, 16000000))).status).toBe(200);
        const pending = await (await send(a, pageId, unb64(maliciousPending.pendingInvalid, 16000000))).json<any>();
        expect(pending.validationPending).toBe(true);
        expect((await send(a, pageId, unb64(maliciousPending.dependency, 16000000))).status).toBe(200);
        const replay = await sync(a, pageId);
        expect(replay.doc.getMap('page').get('epoch')).toBe(1);
        expect(replay.doc.getText('body').toString()).toBe(maliciousPending.expectedLastGood);
        expect(replay.data.quarantineRevision).toBe(1);
        await runInDurableObject(bindings.SPACES.get(bindings.SPACES.idFromName(a.spaceId)), async (_i: any, state: any) => {
            expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM journal_entries WHERE quarantined=1').one().n).toBe(1);
        });
    });
    it('cleans partially restored journals so the same unprovisioned space can retry', async () => {
        const a = await provision(), p = await create(a), d = docFor(p.page.id);
        d.getText('body').insert(0, '墨'.repeat(230000));
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d))).status).toBe(200);
        const vector = Y.encodeStateVector(d);
        d.getText('body').insert(d.getText('body').length, '紙'.repeat(230000));
        expect((await send(a, p.page.id, Y.encodeStateAsUpdate(d, vector))).status).toBe(200);
        const backup = await (await request('/v1/backup', 'POST', {}, a.accessToken)).json<any>();
        const manifest = await (await bindings.BACKUPS.get(backup.key))!.json<any>();
        expect(manifest.entries[0].segments).toHaveLength(2);
        const segment = manifest.entries[0].segments[1], saved = await bindings.BACKUPS.get(segment.key), bytes = await saved!.arrayBuffer();
        await bindings.BACKUPS.put(segment.key, new Uint8Array([0]));
        const spaceId = uuid();
        await runInDurableObject(bindings.SPACES.get(bindings.SPACES.idFromName(spaceId)), async (instance: any, state: any) => {
            const restore = () => instance.fetch(new Request('https://space/internal/provision', { method: 'POST', body: JSON.stringify({ spaceId, backupKey: backup.key }) }));
            expect((await restore()).status).toBe(409);
            expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM journal_entries').one().n).toBe(0);
            for (const {name} of state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'wire_%' OR name LIKE 'packed_%')")) {
                expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM ' + name).one().n).toBe(0);
            }
            await bindings.BACKUPS.put(segment.key, bytes, { customMetadata: saved!.customMetadata });
            expect((await restore()).status).toBe(201);
            expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM journal_entries').one().n).toBe(2);
            expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
        });
    });
});

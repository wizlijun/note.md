import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { Env, SumiSpace } from '../src/index';
import { WireValidator } from '../src/wire-validator';
const bindings = env as unknown as Env;
it('uses packed indexes for empty spaces and freezes their durable schema', async () => {
    const stub = bindings.SPACES.get(bindings.SPACES.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (_instance, state) => {
        expect(state.storage.sql.exec("SELECT value FROM settings WHERE key='wire_schema'").one().value).toBe('packed-v1');
        new SumiSpace(state, bindings);
        expect(state.storage.sql.exec("SELECT value FROM settings WHERE key='wire_schema'").one().value).toBe('packed-v1');
    });
});
it('retains old populated wire indexes without reindexing or discarding their state', async () => {
    const stub = bindings.SPACES.get(bindings.SPACES.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (_instance, state) => {
        const validator = new WireValidator(state.storage.sql), doc = new Y.Doc(), pageId = crypto.randomUUID();
        const page = doc.getMap('page');
        page.set('schema',1); page.set('page_id',pageId); page.set('epoch',1); page.set('root_line_id',crypto.randomUUID());
        doc.getText('body').insert(0,'legacy preserved');
        state.storage.transactionSync(() => validator.validate(pageId,1,'old-operation',Y.encodeStateAsUpdate(doc)));
        state.storage.sql.exec("DELETE FROM settings WHERE key='wire_schema'");
        const oldCount = state.storage.sql.exec('SELECT COUNT(*) AS n FROM wire_items').one().n;
        new SumiSpace(state, bindings);
        expect(state.storage.sql.exec("SELECT value FROM settings WHERE key='wire_schema'").one().value).toBe('legacy-v1');
        expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM wire_items').one().n).toBe(oldCount);
        expect(state.storage.transactionSync(() => validator.validate(pageId,1,'repeat',Y.encodeStateAsUpdate(doc))).quarantined).toEqual([]);
    });
});
it('can select packed for an older but still empty namespace', async () => {
    const stub = bindings.SPACES.get(bindings.SPACES.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (_instance, state) => {
        new WireValidator(state.storage.sql);
        state.storage.sql.exec("DELETE FROM settings WHERE key='wire_schema'");
        new SumiSpace(state, bindings);
        expect(state.storage.sql.exec("SELECT value FROM settings WHERE key='wire_schema'").one().value).toBe('packed-v1');
    });
});

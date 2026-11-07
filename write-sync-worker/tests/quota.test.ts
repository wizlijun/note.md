import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { WireValidator } from '../src/wire-validator';
import { PackedWireValidator } from '../src/packed-wire-validator';
import { Env } from '../src/index';
for (const implementation of [{name: 'legacy', type: WireValidator}, {name: 'packed', type: PackedWireValidator}]) it('measures '+implementation.name+' row writes for individual and batched typing', async () => {
    const bindings = env as unknown as Env;
    const stub = bindings.SPACES.get(bindings.SPACES.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
        let written = 0;
        const sql = new Proxy(state.storage.sql, { get(target, key) {
            if (key === 'exec') return (...args: [string, ...SqlStorageValue[]]) => {
                const cursor = target.exec(...args); written += cursor.rowsWritten; return cursor;
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        }});
        const validator = new implementation.type(sql), doc = new Y.Doc(), pageId = crypto.randomUUID();
        const page = doc.getMap('page');
        page.set('schema', 1); page.set('page_id', pageId); page.set('epoch', 1); page.set('root_line_id', crypto.randomUUID());
        state.storage.transactionSync(() => validator.validate(pageId, 1, 'base', Y.encodeStateAsUpdate(doc)));
        written = 0;
        for (let i = 0; i < 100; i++) {
            const vector = Y.encodeStateVector(doc);
            doc.transact(() => { doc.getText('body').insert(i, '中'); doc.getMap('timing').set(crypto.randomUUID(), JSON.stringify([1, i + 1, 1, []])); });
            state.storage.transactionSync(() => validator.validate(pageId, 1, 'key-' + i, Y.encodeStateAsUpdate(doc, vector)));
        }
        const individual = written;
        validator.reset(); written = 0;
        state.storage.transactionSync(() => validator.validate(pageId, 1, 'full', Y.encodeStateAsUpdate(doc)));
        const batched = written;
        expect(individual).toBeGreaterThan(100);
        expect(batched).toBeGreaterThan(100);
        console.log('SUMI_ROW_BUDGET', JSON.stringify({implementation: implementation.name, keys: 100, individualValidatorRowsWritten: individual, individualPerKey: individual / 100, fullInitialValidatorRowsWritten: batched, excludes: 'journal, operation receipts, page version, catalog, backup'}));
    });
});

import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Env } from '../src/index';
import { SqlMeter } from '../src/sql-meter';
it('counts each consumed SQL row once across cursor APIs', async () => {
    const bindings=env as unknown as Env;
    await runInDurableObject(bindings.SPACES.get(bindings.SPACES.idFromName(crypto.randomUUID())), async (_instance,state) => {
        const meter=new SqlMeter(state.storage.sql), sql=meter.sql;
        sql.exec('CREATE TABLE probe(value INTEGER)');
        const base=meter.snapshot();sql.exec('INSERT INTO probe VALUES (1),(2),(3)');
        expect(meter.snapshot().rowsWritten-base.rowsWritten).toBe(3);
        const cursor=sql.exec('SELECT * FROM probe');expect(cursor.toArray()).toHaveLength(3);
        expect(meter.snapshot().rowsRead-base.rowsRead).toBe(3);
        expect(cursor.toArray()).toHaveLength(0);
        expect(meter.snapshot().rowsRead-base.rowsRead).toBe(3);
        expect([...sql.exec('SELECT * FROM probe').raw()]).toHaveLength(3);
        expect([...sql.exec('SELECT * FROM probe')]).toHaveLength(3);
        expect(meter.snapshot().rowsRead-base.rowsRead).toBe(9);
    });
});

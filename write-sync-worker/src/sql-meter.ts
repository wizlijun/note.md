/** Optional local acceptance instrumentation. No query text or values are retained. */
export class SqlMeter {
    private reads = 0;
    private writes = 0;
    readonly sql: SqlStorage;
    constructor(storage: SqlStorage) {
        this.sql = new Proxy(storage, { get: (target, key) => {
            if (key !== 'exec') {
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            }
            return (query: string, ...bindings: SqlStorageValue[]) => {
                const cursor = target.exec(query, ...bindings);
                let read = 0, written = 0;
                const collect = () => {
                    this.reads += cursor.rowsRead - read; this.writes += cursor.rowsWritten - written;
                    read = cursor.rowsRead; written = cursor.rowsWritten;
                };
                collect();
                return new Proxy(cursor, { get(object, property) {
                    if (property === Symbol.iterator) return function* () { try { yield* cursor; } finally { collect(); } };
                    if (property === 'raw') return function* () { try { yield* cursor.raw(); } finally { collect(); } };
                    if (property === 'one' || property === 'toArray') return () => {
                        try { return property === 'one' ? cursor.one() : cursor.toArray(); } finally { collect(); }
                    };
                    const value = Reflect.get(object, property);
                    return typeof value === 'function' ? value.bind(object) : value;
                }});
            };
        }});
    }
    snapshot() { return { rowsRead: this.reads, rowsWritten: this.writes }; }
}

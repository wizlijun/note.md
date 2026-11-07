# Packed wire index v1

The relay still retains original Yjs V1 updates as its recovery authority. The packed index checks wire structure, actor identity, immutable page/timing values and deferred deletions without creating a Y.Doc. It does not claim to validate Markdown, logical line IDs or timing provenance; clients validate the combined document before displaying it.

A space's persisted `wire_schema` selects its index. Existing spaces with legacy operations retain the legacy reader/validator. Empty and new spaces use `packed-v1`. Recovery into a new space rebuilds a packed index from the original journal; it does not discard or reinterpret old index state in place.

## Storage and bounds

- `packed_items` holds at most 256 client clocks per row. Text structs crossing a clock boundary are sliced with their original UTF-16 clocks and origin identity preserved. The per-transaction cache retains at most 32 blocks and approximately 2 MiB of serialized data; dirty eviction happens inside the caller's transaction.
- `packed_values` stores scalar values larger than 4 KiB separately. This prevents 256 large timing values from exceeding SQLite's row size or forcing a large resident item block. Existing protocol limits still bound each timing value and the complete raw update.
- `packed_fields` holds immutable-field references, not duplicate timing strings. Each reference contains 16 UUID bytes, a 32-bit hexadecimal-case mask, and the client/clock pointer: 28 bytes. The case mask preserves Yjs's case-sensitive map keys. References are distributed into 4,096 UUID-prefix buckets; the four page identity fields use a separate bucket. Each SQL segment contains at most 2,048 references (57,344 bytes).
- New field references are buffered per packet and flushed once per affected segment, so random UUIDs do not turn a full-history import back into one SQL write per event. The raw update/struct limits bound the reference buffer. A bucket may hold at most 4,096 references; `field_bucket_capacity` rejects the entire current packet if that resource bound would be exceeded. A population of 100,000 uniform random UUIDs averages about 24 references per bucket. This explicit skew bound prevents chosen-prefix quadratic work; it is not an immutable-field exception.
- `packed_refs` and `packed_deletes` store operation-to-block references and deletion ranges in bounded binary segments. They avoid putting a large operation's entire index into one SQL row or a large JavaScript object graph. `packed_ops` retains operation quarantine/pending status, and `packed_clients` retains contiguous client-clock prefixes.

All caches are local to one validation call. An exception lets the enclosing journal transaction roll back without retaining a contradictory in-memory index. Reset is only for an unprovisioned recovery staging object and clears every `packed_*` table owned by this implementation.

## Deferred validation and quarantine

Missing parents remain pending. Once dependencies arrive, the index resolves parents, checks immutable values and validates protected-field deletions. A failing earlier operation is quarantined by its original operation ID; its original journal bytes remain retained for diagnosis/recovery, while the service excludes that operation from active replay. Its index contributions and immutable-field references are removed, and affected clock prefixes and later pending operations are reevaluated.

Deletion checks distinguish a valid same-value map replacement from a later pending deletion of that replacement. Following the Yjs map origin chain prevents processing order from blaming the legitimate replacement transaction, which may also contain valid body edits. A deletion targeting an unresolved parent cannot be marked fully validated before that parent resolves.

## Verification

Run the dedicated real workerd/SQLite suite:

```sh
../worker/node_modules/.bin/vitest run tests/packed-validator.test.ts
```

It covers actual Rust forward/reverse fixtures, 180 edits from four offline peers plus duplicate delivery against the legacy oracle, every ordering of a deferred identity violation, long UTF-16 text crossing blocks, large external timing values, UUID spelling, valid field segmentation, adversarial dense buckets with complete rollback, reopening, protected-field mutation, quarantine with surviving same-value fields, and both processing orders of a malicious pending final-field deletion while retaining the legitimate body edit.

Capacity evidence must be measured against the frozen source hash. The initial 100k-history proof used a real 13.26 MB update and measured about 10k SQL row writes for initial import and about 21k for import plus backup/recovery; those preliminary numbers do not substitute for the final deployment proof. Free-plan quotas remain account-wide and finite; packing does not promise unlimited daily editing or recovery work.

# Sumi document wire contract (pre-release V1)

Yrs 0.24.0 / Yjs 13.6.33, update V1 and state-vector V1. The body uses UTF-16 indexing. A replica client ID is a fresh unsigned 32-bit integer, never reused by another live document instance. Public `Document::load` rejects client IDs already in the supplied state. An incoming update that advances the active local client ID is rejected as an actor collision; restore with a fresh actor before continuing.

Shared roots:

- `page`: Y.Map containing `schema: 1`, UUID `page_id`, positive integer `epoch`, UUID `root_line_id`. Identity cannot change within an epoch.
- `body`: Y.Text containing canonical LF Markdown only. Every LF has the `next_line_id` UUID attribute identifying the following logical line. Non-LF text clears that attribute. No presentation styles are stored as Y.Text formatting; Markdown remains canonical.
- `timing`: Y.Map whose UUID keys identify immutable event values. No update may delete or overwrite an existing event. Values are compact JSON strings with the shape below.

```text
[1, at_ms, source, [span, ...]]
span = [start_anchor, end_anchor, first_ms, touch, origins, carried_last_ms, source_mask]
origins = [[client, inclusive_clock, exclusive_clock], ...]
```

`source` is 1 for device time and 2 for external import time. Source 0 is reserved for explicit portable-snapshot recovery into a new page UUID: all its spans must have `touch=false`, and only inherited first/last/source-mask values are restored. `source_mask` is a bit mask (1 device, 2 import) for inherited provenance. `first_ms` and `carried_last_ms` are nullable; all actual times are nonnegative safe JavaScript integers. `touch` is boolean. Each anchor is standard base64 of a Yjs relative position V1 (`StickyIndex::encode_v1` in Yrs). Every resolved anchor must refer to `body`.

Origins identify original Yjs text contributions, without adding a separate UUID formatting item for every keystroke. End clocks are exclusive. A range may include non-text map/format clocks; it must not acquire other currently visible body contributions outside the intended range. `compact_origins` merges a gap only after checking that no visible body item occupies it. Undo reinserts text under new IDs and emits a fresh event carrying prior line provenance.

The current logical lines are derived from `body`, then events reduce into first=min and last=max over surviving origin intersections and resolved relative spans. A collapsed retained event preserves an emptied line's history. Newly pasted middle lines receive their own first time; split suffixes inherit the original line's first time through their retained contributions. The JSON sidecar is a materialized snapshot of this result, never a competing CRDT truth.

The root shape and event version are validated in Rust and Worker tests. `tests/fixtures/yrs-v1.json` is produced by the actual Rust encoder. `write-sync-worker/scripts/interop.mjs` applies reversed and duplicate updates in Yjs and produces the reverse fixture. These fixtures must be regenerated together if the protocol changes.

The current body limit is 1,000,000 UTF-16 units. Binary state, immutable event count, and server memory have separate limits that must be measured with real typing history; a short body does not imply a small history. No epoch rewrite or destructive history compaction is implemented.

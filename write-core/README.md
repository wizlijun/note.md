# Sumi write-core

Platform-independent Markdown editing, Yrs CRDT, line provenance, rich-view source mapping, and durable SQLite state. Wire format is **Yjs update/state-vector V1**, tested against Yjs 13.6.33; Yrs is pinned to 0.24.0. All editor ranges are UTF-16, but committed edits must start/end at extended grapheme boundaries. LF is the only canonical newline.

## Host integration

1. `Document::new` is only for the creator of a page. Persist and synchronize its initial `encode_full()` so identity roots precede dependent edits. Load replicas with `Document::load`; restore a durable revision with `Document::restore` or `Store::load`.
2. Use a new 32-bit Yjs client ID for every live replica, including background persistence replicas. `fresh_client_id` excludes IDs already observed in the document. Do not clone a live actor ID into a second editing process.
3. Build `SourceMap::new(body, revision)` and display its `document`. Native callbacks carry that revision and visible UTF-16 range; `apply_edit` performs a minimal canonical Markdown transaction. Hold committed remote updates during IME composition; never put marked text into the CRDT.
4. Seed a page with `Store::commit_local_with`, then use `commit_local_delta_with` / `commit_remote_delta_with` for ordinary accepted transactions. These atomically append exact-revision CRDT deltas, outbox or inbox acknowledgement, and host catalog/generation/dirty markers without encoding a full state. `checkpoint_with` writes the current full state and portable pair and prunes covered deltas in one transaction. The store belongs on a persistence worker; a queued edit is not durable until its delta commit succeeds.
5. Project portable Markdown and sidecar only from committed state. Keep the CRDT state corresponding to a projection baseline; `import_external` uses it for a three-way CRDT merge. Overlapping edits and ambiguous repeated lines return a conflict without modifying the current document.

## Line time semantics

The body is one Y.Text. Each newline carries the stable UUID of its following line. Immutable timing events contain relative-position spans and the Yjs client/clock intervals of the original character contributions. The reducer keeps time attached to surviving contributions across concurrent splits/merges, instead of trusting line numbers or last-writer-wins row objects. Blank new lines have no first-written timestamp; clearing an existing line keeps its prior history. `time_source` is `device`, `import`, `mixed`, or `unknown`.

Portable files contain a small YAML identity header and unchanged Markdown body. Per-line hashes, first/last time and provenance live in the JSON sidecar. Full CRDT history remains in SQLite; the two portable files do not replace it.

## Verification

```sh
cargo +1.99.0 test --manifest-path write-core/Cargo.toml
cargo +1.99.0 clippy --manifest-path write-core/Cargo.toml --all-targets -- -D warnings
cargo +1.99.0 run --release --manifest-path write-core/Cargo.toml --example full_path_benchmark
```

Regression coverage includes reverse and duplicate update delivery, offline concurrent splitting and merging, local undo with remote edits, Unicode boundaries, indexed-versus-reference provenance replay, source mapping, three-way imports, durability rollback and portable-file conflicts. The sibling Worker generates the reverse Yjs fixture used by `yjs_reverse_interop`.

Benchmarks measure core computation, not physical keyboard/IME/display latency. Unsupported Markdown blocks are retained verbatim and protected in rich mode; source editing is available to the host. Setext headings currently use that protected path. The immutable history capacity and full native/host acceptance remain integration gates; passing these Rust tests does not constitute a release acceptance.

## Native transaction helpers

`SourceMap::anchor_selection` and `resolve_selection` bridge visible UTF-16 selections through stable CRDT positions; read-only Markdown can still be selected. `Document` exposes equivalent helpers for canonical-source offsets. Resolution snaps away from grapheme interiors after remote combining-character edits. The anchor type is `Send`.

`prepare_remote` validates against an isolated candidate and computes the next snapshot off the input thread. `commit_prepared` checks the exact revision, page/epoch, causal state vector/delete set, pending-state fingerprint, and active actor before integrating only the incremental update and moving in the precomputed caches. A stale result must never overwrite newly typed text. Use `CandidateSession` for the continuous sync path: seed once from the live state and its active writer ID, then feed the exact FIFO committed journal through `advance_local`. Feed network packets through `receive_remote`, obtain `prepare_current`, take its `commit_token`, and call `ack_committed` on the background owner only after the live `commit_prepared` succeeds. Process acknowledgements before replaying journal records newer than `base_revision`. A bounded host journal overflow requires a fresh seed; it must not skip revisions.

The session retains a confirmed baseline and a private candidate. New timing entries are decoded once and immutable decoded events are shared across preparations. Every candidate transaction, including local catch-up that could resolve old pending network data, still runs full semantic provenance validation. An invalid candidate becomes quarantined; retain its original inbox and the live draft for recovery. A legal duplicate remains a revision-advancing remote transaction. The background owner is `Send`; the native input thread must never wait for its lock.

The actual-thread `candidate_continuous` benchmark exercises continuous 100ms local input and 400ms remote packets. At 100k genuine prior keystrokes, 118 local keys and all 30 remote updates completed without waiting for typing to stop; remote computation p95 was 149.44ms, and commit/snapshot/render p95 was 1.67ms. Adding an explicit 100ms network budget gives 249.44ms; this is not a measured transport RTT or physical native rendering measurement. At 10k prior edits the corresponding budgeted p95 was 111.71ms. Cold seeding is separate from the per-packet path.

`import_source` performs the conservative three-way merge with device provenance and one local undo item; `import_external` uses import provenance and does not enter local undo. Both preserve concurrent non-overlapping changes. `import::rebase_draft(submitted, accepted, newer_draft)` handles additional source typing while a save is in flight. Only `Merged` may be bound to the accepted revision; overlapping replacements return all three texts as `Conflict`. Same-boundary independent inserts retain both in accepted-then-draft order.

`apply_rich_paste` accepts only the already-sanitized `RenderDocument` subset, converts it to a local Markdown replacement and verifies visible text round-trips before mutation. It never parses HTML/RTF or loads resources. The host must retain unsupported raw clipboard data and obtain an explicit plain-text fallback decision. Overlapping or invalid UTF-16 runs are rejected atomically.

`storage::fork_pair` restores a verified Markdown/sidecar pair into a **new** page UUID, preserving line identity and known first/last/source values. `Document::import_unknown` imports text without fabricated timestamps. Complete CRDT recovery from the sync journal should be attempted before offering a portable-file fork. `merge_wire_updates` merges a bounded, fully collected transport journal before semantic validation, so partial updates do not need to contain page identity independently.


`Document::apply_confirmed_update(target_revision, bytes)` is only for a disposable persistence replica replaying a same-process transaction already accepted by the live editor. It avoids full history cloning and returns the cached validated snapshot; the target must be exactly current revision + 1. Every error requires discarding that replica and restoring the durable checkpoint. Never use it to accept unconfirmed network packets or mutate the live editor. The 100k-history computation benchmark measured p95 61.26ms, excluding SQLite and projection I/O; full queue throughput remains a host acceptance check.


## Incremental durability

`documents.revision` is the checkpoint cut, not necessarily the current durable head. `Store::load` reads the checkpoint and ordered `document_deltas` in one SQLite read transaction, requires contiguous revisions and matching epochs, rejects a requested actor already present in the delta tail, and replays using the confirmed-state semantic validator. Corrupt or missing deltas fail closed. The host owns a bounded checkpoint schedule and records projection dirtiness in the same delta transaction; a durable text acknowledgement is separate from a completed Markdown/sidecar projection.

`checkpoint_with` accepts exactly the current durable revision, performs no inbox/outbox changes, and updates the pair and covered delta deletion atomically with the host callback. Initial/import full commits also prune covered deltas and reject revision regression or epoch drift. Abrupt subprocess-exit regressions verify recovery after a committed delta and rollback halfway through a checkpoint, without running SQLite connection destructors.

# Conversation Dictionary review dataset

Use schema `notemd.conversation-dictionary-dataset.v1`. The plugin accepts only the four proposal kinds documented below.

```yaml
schema: notemd.conversation-dictionary-dataset.v1
run_id: 853f8a64-51d4-4dc8-8a97-8bd6d98784a3
subject_id: human:bruce
state: completed
base_dictionary:
  state: present
  dictionary_id: dict_example
  revision: 2
  sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
evidence_file:
  path: evidence.jsonl
  sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
coverage:
  discovered: 1
  processed: 1
  excluded: 0
  unknown_scope: 0
  failed: 0
  pending: 0
  chunks_planned: 1
  chunks_processed: 1
sources:
  - id: src_1
    canonical_source_id: meeting_20260920
    resource: ssot/meetings/20260920/transcript.srt
    content_sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    status: processed
    eligible_ranges: [[0, 100]]
    processed_ranges: [[0, 100]]
proposals:
  - id: p_entry
    kind: create_entry
    value:
      kind: person
      label: 伟滔
      forms: [伟滔, Bruce, 滔哥]
      description: 产品团队沟通中的人名写法，待用户确认。
    evidence_ids: [ev_1]
    reason: 上下文支持该写法，但同一人物关系仍需确认。
  - id: p_rule
    kind: create_rule
    depends_on: [p_entry]
    value:
      domain_ref: {existing_id: d_product}
      observed: 伟涛
      action: replace
      target:
        entry_ref: {proposal_id: p_entry}
        text: 伟滔
      application: suggest
    evidence_ids: [ev_1]
    reason: 该场景的一处 ASR 观测可能指向该词条，最终统一输出正式名。
conflicts: []
unresolved: []
```

Coverage must satisfy `discovered = processed + excluded + unknown_scope + failed + pending`, and `chunks_processed <= chunks_planned`. There must be one `sources` item per discovered source.

Proposal kinds:

- `create_domain`: `value` has non-empty `name` and optional `description`.
- `create_entry`: `value` has `kind`, `label`, non-empty `forms`, and optional `description`. `label` is the one formal name and must also appear in `forms`; the other forms are confirmed aliases.
- `add_forms`: `value` has an existing `entry_id` and non-empty `forms`. It adds confirmed aliases; it does not add ASR mistakes or change the formal name.
- `create_rule`: `value` has `domain_ref`, `observed`, and `action`. Replace rules also require `target` and `application: suggest|automatic`; preserve rules must omit both.

For every replace proposal, `target.text` must equal the referenced entry's formal name. The plugin derives the committed output from the entry and never stores an alias as rule output.

Aliases do not act globally. When `forms` contains aliases, include one `create_rule` per alias and evidence-supported context that should normalize it. If the same alias is ambiguous in a context, report the competing targets in `conflicts` or `unresolved` instead of silently choosing one. The review UI shows these alias rules independently, and every approved rule still outputs the single formal name.

An object reference has exactly one of `existing_id` or `proposal_id`. Declare every proposal reference in `depends_on`; dependencies must exist and be acyclic. A rule that normalizes a confirmed alias still targets the same entry's formal name.

`evidence.jsonl` stores one JSON object per occurrence. Bind it to the original file bytes and source identity:

```json
{"id":"ev_1","source_id":"src_1","subject_id":"human:bruce","communication":{"user_relation":"participant","basis":{"type":"user_statement","detail":"The user identified this as their meeting"}},"content_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","span":{"start":79,"end":81},"observed":"伟涛","excerpt":"伟涛负责发布。","excerpt_span":{"start":79,"end":86},"locator":"00:00:03,000-00:00:04,000"}
```

The span and `excerpt_span` are `[start,end)` Unicode code-point ranges in the complete decoded original file, before stripping SRT/VTT metadata or normalizing line endings. `excerpt_span` must contain `span`, and `excerpt` must equal that exact source slice. The hash is SHA-256 of the original bytes. Keep excerpts at or below 2,000 code points.

The report states selected roots, participation basis, counts, failures, unknown sources, conflicts, unresolved observations, and the exact dataset path. A completed scan can still contain failed or unknown sources; describe the resulting gap.

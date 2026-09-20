#!/usr/bin/env python3
"""Validate the deterministic structure of a Conversation Dictionary dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
import uuid
from pathlib import Path

import yaml

ALLOWED_KINDS = {"create_domain", "create_entry", "add_forms", "create_rule"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def is_sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdefABCDEF" for character in value)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    args = parser.parse_args()
    data = yaml.safe_load(args.dataset.read_text(encoding="utf-8"))
    require(isinstance(data, dict), "dataset must be a mapping")
    require(data.get("schema") == "notemd.conversation-dictionary-dataset.v1", "unsupported schema")
    uuid.UUID(str(data.get("run_id")))
    require(str(data.get("subject_id", "")).startswith("human:"), "invalid subject_id")

    evidence_file = data.get("evidence_file", {})
    evidence_relative = evidence_file.get("path")
    require(isinstance(evidence_relative, str) and evidence_relative, "evidence_file.path is required")
    evidence_path = (args.dataset.parent / evidence_relative).resolve()
    dataset_root = args.dataset.parent.resolve()
    require(evidence_path.is_relative_to(dataset_root), "evidence file must remain beside the dataset")
    evidence_bytes = evidence_path.read_bytes()
    evidence_hash = hashlib.sha256(evidence_bytes).hexdigest()
    require(is_sha256(evidence_file.get("sha256")) and evidence_hash == evidence_file.get("sha256"), "evidence file hash does not match dataset")
    evidence_ids: set[str] = set()
    for line_number, line in enumerate(evidence_bytes.splitlines(), start=1):
        if not line.strip():
            continue
        evidence = json.loads(line)
        evidence_id = evidence.get("id")
        require(isinstance(evidence_id, str) and evidence_id, f"evidence line {line_number} has no id")
        require(evidence_id not in evidence_ids, f"duplicate evidence id: {evidence_id}")
        evidence_ids.add(evidence_id)

    coverage = data.get("coverage", {})
    total = sum(int(coverage.get(key, 0)) for key in ("processed", "excluded", "unknown_scope", "failed", "pending"))
    require(total == int(coverage.get("discovered", -1)), "coverage counters do not add up")
    require(int(coverage.get("chunks_processed", 0)) <= int(coverage.get("chunks_planned", -1)), "chunk coverage is invalid")
    base = data.get("base_dictionary", {})
    if base.get("state") == "absent":
        require(not any(key in base for key in ("dictionary_id", "revision", "sha256")), "absent base_dictionary cannot include identity fields")
    else:
        require(base.get("state") == "present", "base_dictionary.state must be absent or present")
        require(base.get("dictionary_id") and int(base.get("revision", 0)) > 0 and is_sha256(base.get("sha256")), "present base_dictionary is incomplete")
    sources = data.get("sources", [])
    require(len(sources) == int(coverage["discovered"]), "source count differs from discovered")
    source_statuses = {key: 0 for key in ("processed", "excluded", "unknown_scope", "failed", "pending")}
    source_ids: set[str] = set()
    for source in sources:
        source_id = source.get("id")
        require(isinstance(source_id, str) and source_id and source_id not in source_ids, f"invalid source id: {source_id}")
        source_ids.add(source_id)
        require(is_sha256(source.get("content_sha256")), f"invalid source hash: {source.get('id')}")
        require(source.get("canonical_source_id") and source.get("resource"), f"source identity missing: {source.get('id')}")
        status = source.get("status")
        require(status in source_statuses, f"invalid source status: {source_id}")
        source_statuses[status] += 1
        eligible = source.get("eligible_ranges", [])
        processed = source.get("processed_ranges", [])
        for start, end in [*eligible, *processed]:
            require(isinstance(start, int) and isinstance(end, int) and 0 <= start < end, f"invalid source range: {source_id}")
        for start, end in processed:
            require(any(left <= start and end <= right for left, right in eligible), f"processed range is not eligible: {source_id}")
    for status, count in source_statuses.items():
        require(count == int(coverage.get(status, -1)), f"source count differs from coverage.{status}")

    source_lookup = {source["id"]: source for source in sources}
    evidence_source_ids: set[str] = set()
    for line_number, line in enumerate(evidence_bytes.splitlines(), start=1):
        if not line.strip():
            continue
        evidence = json.loads(line)
        evidence_id = evidence["id"]
        require(evidence.get("subject_id") == data["subject_id"], f"evidence subject mismatch: {evidence_id}")
        relation = evidence.get("communication", {}).get("user_relation")
        require(relation in {"participant", "direct_recipient"}, f"evidence outside communication scope: {evidence_id}")
        require(evidence.get("communication", {}).get("basis", {}).get("detail"), f"evidence basis missing: {evidence_id}")
        source_id = evidence.get("source_id")
        require(source_id in source_ids, f"evidence source missing: {evidence_id}")
        source = source_lookup[source_id]
        require(evidence.get("content_sha256") == source["content_sha256"], f"evidence source hash mismatch: {evidence_id}")
        span = evidence.get("span", {})
        start, end = span.get("start"), span.get("end")
        require(isinstance(start, int) and isinstance(end, int) and 0 <= start < end, f"invalid evidence span: {evidence_id}")
        require(source["status"] == "processed" and any(left <= start and end <= right for left, right in source.get("processed_ranges", [])), f"evidence is outside processed ranges: {evidence_id}")
        observed = evidence.get("observed")
        excerpt = evidence.get("excerpt")
        excerpt_span = evidence.get("excerpt_span", {})
        excerpt_start, excerpt_end = excerpt_span.get("start"), excerpt_span.get("end")
        require(isinstance(observed, str) and observed, f"evidence observed missing: {evidence_id}")
        require(isinstance(excerpt, str) and len(excerpt) <= 2_000, f"invalid evidence excerpt: {evidence_id}")
        require(isinstance(excerpt_start, int) and isinstance(excerpt_end, int) and 0 <= excerpt_start <= start < end <= excerpt_end, f"invalid evidence excerpt span: {evidence_id}")
        evidence_source_ids.add(source_id)

    proposals = data.get("proposals", [])
    ids = [proposal.get("id") for proposal in proposals]
    require(all(ids) and len(set(ids)) == len(ids), "proposal IDs must be unique and non-empty")
    lookup = {proposal["id"]: proposal for proposal in proposals}
    for proposal in proposals:
        require(proposal.get("kind") in ALLOWED_KINDS, f"unsupported proposal kind: {proposal.get('kind')}")
        value = proposal.get("value", {})
        require("confirmed_by" not in value and "confirmed_at" not in value, f"approval injection: {proposal['id']}")
        if proposal.get("kind") != "create_domain":
            require(bool(proposal.get("evidence_ids")), f"proposal requires verified communication evidence: {proposal['id']}")
        if proposal.get("kind") == "create_entry":
            label = value.get("label")
            forms = value.get("forms")
            require(isinstance(label, str) and label.strip(), f"formal name missing: {proposal['id']}")
            require(isinstance(forms, list) and forms and all(isinstance(form, str) and form.strip() for form in forms), f"entry forms invalid: {proposal['id']}")
            normalized_label = unicodedata.normalize("NFC", label)
            require(any(unicodedata.normalize("NFC", form) == normalized_label for form in forms), f"formal name must appear in forms: {proposal['id']}")
        if proposal.get("kind") == "create_rule" and value.get("action") == "replace":
            target = value.get("target", {})
            require(isinstance(target.get("text"), str) and target["text"].strip(), f"formal target missing: {proposal['id']}")
        for evidence_id in proposal.get("evidence_ids", []):
            require(evidence_id in evidence_ids, f"missing evidence: {proposal['id']} -> {evidence_id}")
        for dependency in proposal.get("depends_on", []):
            require(dependency in lookup and dependency != proposal["id"], f"invalid dependency: {proposal['id']} -> {dependency}")
        if proposal.get("kind") == "create_rule" and value.get("action") == "replace":
            target = value["target"]
            entry_proposal_id = target.get("entry_ref", {}).get("proposal_id")
            if entry_proposal_id:
                entry_proposal = lookup.get(entry_proposal_id, {})
                require(entry_proposal.get("kind") == "create_entry", f"rule target proposal is not an entry: {proposal['id']}")
                require(target["text"] == entry_proposal.get("value", {}).get("label"), f"rule output must equal formal name: {proposal['id']}")

    visiting: set[str] = set()
    done: set[str] = set()
    def visit(proposal_id: str) -> None:
        if proposal_id in done:
            return
        require(proposal_id not in visiting, f"dependency cycle at {proposal_id}")
        visiting.add(proposal_id)
        for dependency in lookup[proposal_id].get("depends_on", []):
            visit(dependency)
        visiting.remove(proposal_id)
        done.add(proposal_id)
    for proposal_id in ids:
        visit(proposal_id)

    print(json.dumps({"ok": True, "run_id": data["run_id"], "sources": len(sources), "proposals": len(proposals)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        raise SystemExit(2)

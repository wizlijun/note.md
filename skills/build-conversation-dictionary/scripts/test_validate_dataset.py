#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

import yaml


SCRIPT = Path(__file__).with_name("validate_dataset.py")


class DatasetValidatorTest(unittest.TestCase):
    def test_accepts_bound_evidence_and_rejects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = {
                "id": "ev_1",
                "source_id": "src_1",
                "subject_id": "human:bruce",
                "communication": {
                    "user_relation": "participant",
                    "basis": {"type": "user_statement", "detail": "用户确认参与"},
                },
                "content_sha256": "a" * 64,
                "span": {"start": 0, "end": 2},
                "observed": "伟涛",
                "excerpt": "伟涛负责发布。",
                "excerpt_span": {"start": 0, "end": 7},
            }
            evidence_bytes = (json.dumps(evidence, ensure_ascii=False) + "\n").encode()
            (root / "evidence.jsonl").write_bytes(evidence_bytes)
            dataset = {
                "schema": "notemd.conversation-dictionary-dataset.v1",
                "run_id": str(uuid.uuid4()),
                "subject_id": "human:bruce",
                "state": "completed",
                "base_dictionary": {"state": "absent"},
                "evidence_file": {
                    "path": "evidence.jsonl",
                    "sha256": hashlib.sha256(evidence_bytes).hexdigest(),
                },
                "coverage": {
                    "discovered": 1,
                    "processed": 1,
                    "excluded": 0,
                    "unknown_scope": 0,
                    "failed": 0,
                    "pending": 0,
                    "chunks_planned": 1,
                    "chunks_processed": 1,
                },
                "sources": [{
                    "id": "src_1",
                    "canonical_source_id": "meeting_1",
                    "resource": "ssot/meetings/meeting_1/transcript.srt",
                    "content_sha256": "a" * 64,
                    "status": "processed",
                    "eligible_ranges": [[0, 10]],
                    "processed_ranges": [[0, 10]],
                }],
                "proposals": [{
                    "id": "p_entry",
                    "kind": "create_entry",
                    "depends_on": [],
                    "value": {"kind": "person", "label": "伟滔", "forms": ["伟滔"]},
                    "evidence_ids": ["ev_1"],
                }],
                "conflicts": [],
                "unresolved": [],
            }
            dataset_path = root / "dataset.yml"
            dataset_path.write_text(yaml.safe_dump(dataset, allow_unicode=True, sort_keys=False), encoding="utf-8")

            valid = subprocess.run([str(SCRIPT), str(dataset_path)], capture_output=True, text=True, check=False)
            self.assertEqual(valid.returncode, 0, valid.stdout + valid.stderr)

            (root / "evidence.jsonl").write_text("{}\n", encoding="utf-8")
            tampered = subprocess.run([str(SCRIPT), str(dataset_path)], capture_output=True, text=True, check=False)
            self.assertEqual(tampered.returncode, 2)
            self.assertIn("evidence file hash does not match", tampered.stdout)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Real NDJSON subprocess, synthetic sources and local fake Agent only.

cargo build --manifest-path plugins-src/strata/backend/Cargo.toml
python3 plugins-src/strata/backend/tests/protocol_smoke.py
"""
import hashlib
import json
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

BINARY = Path(sys.argv.pop(1)) if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else Path(__file__).resolve().parents[1] / "target/debug/notemd-strata"
RANGE = {"from": "2026-09-01", "to": "2026-09-30"}
HARNESS = "notemd.codex-agent"


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


class Wire:
    def __init__(self, directory, mode="success"):
        self.directory = Path(directory)
        self.mode = mode
        self.released = False
        self.launch_release = threading.Event()
        self.conflict = False
        self.expired = False
        self.defer_proof = False
        self.providers = True
        self.root = str(self.directory / "synthetic-vault")
        self.calls = []
        self.runs = []
        self.errors = []
        self.responses = {}
        self.sequence = 10000
        self.lock = threading.Lock()
        self.input_lock = threading.Lock()
        self.files = [self.file("note-a.md", "我决定先验证证据。", 2), self.file("note-b.md", "下周复盘。", 1)]
        self.process = subprocess.Popen([str(BINARY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.call("$initialize", {"data_dir": str(self.directory / "cache")}, direct=True)
        self.call("$activate", {}, direct=True)

    def file(self, path, text, priority):
        return {"fileKey": sha(path), "path": path, "contentHash": sha(text), "title": path[:-3], "tags": ["证据"], "docDate": "2026-09-15", "dateInferred": False, "indexOrigin": "human", "humanVerified": False, "confidentiality": "unknown", "attentionMinutes": 0, "links": [], "filePriority": priority, "priorityBasis": None, "_text": text}

    def write(self, value):
        with self.input_lock:
            self.process.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
            self.process.stdin.flush()

    def read(self):
        try:
            for line in self.process.stdout:
                value = json.loads(line)
                if "method" in value:
                    if "id" not in value:
                        continue
                    try:
                        result = self.host(value["method"], value.get("params", {}))
                        if value["method"] == "host.agent.run" and self.mode == "launch-wait":
                            def delayed(ident=value["id"], reply=result):
                                self.launch_release.wait(timeout=7)
                                self.write({"jsonrpc": "2.0", "id": ident, "result": reply})
                            threading.Thread(target=delayed, daemon=True).start()
                            continue
                        self.write({"jsonrpc": "2.0", "id": value["id"], "result": result})
                    except Exception as error:
                        self.write({"jsonrpc": "2.0", "id": value["id"], "error": {"code": -32000, "message": str(error)}})
                else:
                    with self.lock:
                        waiting = self.responses.get(value["id"])
                    if waiting:
                        waiting.put(value)
        except Exception as error:
            self.errors.append(str(error))

    def call(self, method, params=None, direct=False):
        with self.lock:
            self.sequence += 1
            ident = self.sequence
            waiting = queue.Queue()
            self.responses[ident] = waiting
        self.write({"jsonrpc": "2.0", "id": ident, "method": method if direct else "ui.request", "params": params if direct else {"method": "plugin." + method, "params": params or {}}})
        result = waiting.get(timeout=8)
        with self.lock:
            del self.responses[ident]
        if "error" in result:
            raise RuntimeError(result["error"]["message"])
        return result["result"]

    def host(self, method, params):
        self.calls.append((method, params))
        if method == "host.vault.info":
            return {"root": self.root}
        if method == "host.index.snapshot":
            chosen = self.files
            if "range" in params:
                chosen = [f for f in chosen if f["docDate"] and params["range"]["from"] <= f["docDate"] <= params["range"]["to"]]
            return {"snapshotId": "frozen-range" if "range" in params else "frozen-atlas", "configHash": sha("weights"), "asOf": "2026-09-30", "mode": "range" if "range" in params else "atlas_metadata", "files": [{k: v for k, v in f.items() if not k.startswith("_")} for f in chosen], "coverage": {}, "freshness": "current", "nextCursor": None}
        if method == "host.index.blocks":
            assert params["snapshotId"] == "frozen-range", "atlas body access is prohibited"
            if self.expired:
                raise RuntimeError("SNAPSHOT_EXPIRED")
            if self.conflict:
                return {"snapshotId": params["snapshotId"], "units": [], "conflicts": [{"reason": "changed"}], "nextCursor": None}
            if self.defer_proof:
                return {"snapshotId": params["snapshotId"], "units": [], "conflicts": [{"reason": "too_large"}], "nextCursor": None}
            units = []
            conflicts = []
            for file in self.files:
                if file["fileKey"] in params["fileKeys"]:
                    if len(file["_text"].encode()) > params["maxBytes"]:
                        conflicts.append({"fileKey": file["fileKey"], "reason": "too_large"})
                    else:
                        units.append({"fileKey": file["fileKey"], "contentHash": file["contentHash"], "blockKey": "block-" + file["fileKey"], "lineStart": 1, "lineEnd": 1, "text": file["_text"], "breadcrumb": "", "level": "file", "isAnnotation": False, "agentBy": None, "priority": file["filePriority"], "priorityFactors": {}})
            return {"snapshotId": params["snapshotId"], "units": units, "conflicts": conflicts, "nextCursor": None}
        if method == "host.agent.providers":
            return {"providers": [{"id": HARNESS, "harness": {"ok": True, "capabilities": {"tasks": ["strata-extract-v1"], "terminal_result": True, "input_only_isolation": True}}}] if self.providers else []}
        if method == "host.agent.run":
            assert params["task"] == "strata-extract-v1"
            assert sha(params["prompt"]) == params["input_hash"]
            packet = json.loads(params["prompt"])["input"]
            assert packet["invocationId"] == params["invocation_id"]
            self.runs.append(packet)
            if self.mode == "no-receipt":
                raise RuntimeError("lost launch receipt")
            return {"run_id": "run-" + str(len(self.runs)), "resolved_model": "synthetic-only"}
        if method == "host.agent.status":
            if self.mode == "running" and not self.released:
                return {"state": "running"}
            packet = self.runs[int(params["run_id"].split("-")[1]) - 1]
            unit = packet["units"][0]
            if self.mode == "changed":
                self.conflict = True
            if self.mode == "expired":
                self.expired = True
            output = {"schema": "notemd.strata/extraction/v1", "invocationId": packet["invocationId"], "nodes": [{"id": "n1", "title": "来源中的具体决定", "kind": "claim", "features": ["证据"], "epistemic": "explicit_statement", "ownerSpecificity": "unknown", "confidentiality": "unknown", "classificationReason": "本人身份尚未确定", "speaker": "说话人不明", "conditions": ["按原文范围"], "limits": ["不推断实际完成"], "evidence": [{"blockKey": unit["blockKey"], "lineStart": 1, "lineEnd": 1, "quote": "伪造的引文" if self.mode == "forged" else unit["text"]}]}], "relations": []}
            return {"state": "done", "record": {"status": "success"}, "terminal_result": {"complete": self.mode != "truncated", "content": json.dumps(output, ensure_ascii=False)}}
        raise AssertionError("unexpected host method " + method)

    def extract(self, **extra):
        return self.call("extract", {**RANGE, "harness": HARNESS, "budget": {"maxFiles": 1, "maxBytes": 1024, "maxSeconds": 10}, **extra})

    def await_job(self, predicate=lambda j: j["state"] not in ["running", "recovering", "stopping"]):
        until = time.monotonic() + 7
        while time.monotonic() < until:
            job = self.call("job")
            if job and predicate(job):
                return job
            time.sleep(0.02)
        raise AssertionError("job did not settle: " + str(job))

    def close(self, crash=False):
        if crash:
            self.process.kill()
        else:
            self.call("$deactivate", {}, direct=True)
        self.process.wait(timeout=4)
        self.reader.join(timeout=1)
        stderr = self.process.stderr.read()
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.stderr.close()
        assert not self.errors, self.errors
        assert not stderr, stderr


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="strata-synthetic-")
        self.wire = None

    def wire_for(self, mode="success"):
        self.wire = Wire(self.temp.name, mode)
        return self.wire

    def tearDown(self):
        if self.wire and self.wire.process.poll() is None:
            self.wire.close()
        self.temp.cleanup()

    def test_candidate_without_agent_and_hash_checked_open(self):
        w = self.wire_for()
        w.providers = False
        w.files[1]["docDate"] = None
        snap = w.call("snapshot", RANGE)
        self.assertEqual(snap["snapshotId"], "frozen-atlas")
        self.assertEqual(snap["coverage"]["selected"], 1)
        self.assertTrue(all(n["state"] == "candidate" and n["ownerSpecificity"] == "unknown" for n in snap["nodes"]))
        self.assertFalse(any(m.startswith("host.agent") or m == "host.index.blocks" for m, _ in w.calls))
        node = next(n for n in snap["nodes"] if n["sourceGroups"][0]["dates"])
        source = w.call("open_source", {**RANGE, "nodeId": node["id"]})
        self.assertEqual(source["path"], "note-a.md")
        self.assertNotIn("quote", source)
        w.conflict = True
        with self.assertRaises(RuntimeError):
            w.call("open_source", {**RANGE, "nodeId": node["id"]})

    def test_success_budget_cache_and_exact_source_open(self):
        w = self.wire_for()
        start = w.extract()
        self.assertEqual(start["state"], "running")
        job = w.await_job()
        self.assertEqual(job["state"], "partial")
        self.assertEqual(len(w.runs), 1)
        snap = w.call("snapshot", RANGE)
        verified = [n for n in snap["nodes"] if n["state"] == "verified"]
        self.assertEqual(len(verified), 1)
        self.assertEqual(verified[0]["conditions"], ["按原文范围"])
        self.assertEqual(len(verified[0]["sourceGroups"][0]["canonicalIds"]), 1)
        ev = verified[0]["evidence"][0]
        self.assertEqual(w.call("open_source", {**RANGE, "nodeId": verified[0]["id"], "evidenceId": ev["id"]})["quote"], ev["quote"])
        w.conflict = True
        after = w.call("snapshot", RANGE)
        self.assertTrue(all(n["state"] == "candidate" for n in after["nodes"]))

    def test_reject_forged_truncated_changed_and_expired_outputs(self):
        for mode in ["forged", "truncated", "changed", "expired"]:
            with self.subTest(mode=mode):
                w = self.wire_for(mode)
                w.extract()
                job = w.await_job()
                self.assertGreater(job["failed"], 0)
                self.assertFalse(list((Path(self.temp.name) / "cache").glob("*/sources/*.json")))
                w.close()

    def test_default_confidential_skip_and_body_budget(self):
        w = self.wire_for()
        w.files[0]["confidentiality"] = "confidential"
        w.files[1] = w.file("note-b.md", "预算" * 200, 1)
        w.extract(budget={"maxFiles": 1, "maxBytes": 256, "maxSeconds": 10})
        job = w.await_job()
        self.assertEqual(job["skipped"], 1)
        self.assertEqual(job["failed"], 1)
        self.assertEqual(w.runs, [])

    def test_deferred_proof_keeps_identity_but_withdraws_evidence_and_personal_label(self):
        w = self.wire_for()
        w.extract()
        w.await_job()
        current = w.call("snapshot", RANGE)
        node = next(n for n in current["nodes"] if n["state"] == "verified")
        w.defer_proof = True
        deferred = w.call("snapshot", RANGE)
        same = next(n for n in deferred["nodes"] if n["id"] == node["id"])
        self.assertEqual(deferred["coverage"]["proofDeferred"], 1)
        self.assertEqual(same["state"], "candidate")
        self.assertEqual(same["evidence"], [])
        self.assertEqual(same["ownerSpecificity"], "unknown")
        self.assertEqual(same["sourceGroups"], node["sourceGroups"])
        w.defer_proof = False
        self.assertEqual(w.call("open_source", {**RANGE, "nodeId": same["id"]})["path"], "note-a.md")
        outside = w.call("snapshot", {"from": "2026-10-01", "to": "2026-10-02"})
        old = next(n for n in outside["nodes"] if n["id"] == node["id"])
        self.assertEqual(old["evidence"], [])
        self.assertEqual(old["sourceGroups"], node["sourceGroups"])

    def test_cancel_is_responsive_and_recovered_result_never_publishes(self):
        w = self.wire_for("running")
        w.extract()
        until = time.monotonic() + 4
        while not w.runs and time.monotonic() < until:
            time.sleep(0.01)
        before = time.monotonic()
        self.assertTrue(w.call("stop")["stopRequested"])
        self.assertLess(time.monotonic() - before, 1)
        w.released = True
        w.await_job()
        self.assertFalse(list((Path(self.temp.name) / "cache").glob("*/sources/*.json")))
        self.assertEqual(len(w.runs), 1)

    def test_stop_does_not_wait_behind_an_unanswered_agent_launch_rpc(self):
        w = self.wire_for("launch-wait")
        w.extract()
        until = time.monotonic() + 4
        while not w.runs and time.monotonic() < until:
            time.sleep(0.01)
        self.assertEqual(len(w.runs), 1)
        before = time.monotonic()
        stopped = w.call("stop")
        self.assertTrue(stopped["stopRequested"])
        self.assertLess(time.monotonic() - before, 1)
        self.assertFalse(w.launch_release.is_set())
        w.launch_release.set()
        w.await_job()
        self.assertFalse(list((Path(self.temp.name) / "cache").glob("*/sources/*.json")))

    def test_uncertain_launch_can_be_explicitly_dismissed_without_resubmit(self):
        w = self.wire_for("no-receipt")
        w.extract()
        job = w.await_job()
        self.assertTrue(job["canDismissRecovery"])
        self.assertEqual(len(w.runs), 1)
        dismissed = w.call("dismiss_job", {"jobId": job["id"]})
        self.assertFalse(dismissed["canDismissRecovery"])
        self.assertEqual(dismissed["state"], "cancelled")
        self.assertEqual(len(w.runs), 1)

    def test_restart_only_polls_existing_receipt(self):
        w = self.wire_for("running")
        w.extract()
        until = time.monotonic() + 4
        while not any(m == "host.agent.status" for m, _ in w.calls) and time.monotonic() < until:
            time.sleep(0.01)
        packets = w.runs[:]
        w.close(crash=True)
        w = self.wire_for()
        w.runs = packets
        w.await_job()
        self.assertEqual(len(w.runs), 1)
        self.assertFalse(any(m == "host.agent.run" for m, _ in w.calls))
        snap = w.call("snapshot", RANGE)
        self.assertTrue(any(n["state"] == "verified" for n in snap["nodes"]))

    def test_atlas_filters_stale_nodes_and_vault_switch(self):
        w = self.wire_for()
        snap = w.call("snapshot", RANGE)
        ident = snap["nodes"][0]["id"]
        atlas = {"version": "strata-atlas/1", "epoch": "test", "worldSize": 4096, "nodes": [{"id": ident, "title": "do not persist", "evidence": [{"quote": "do not persist"}], "x": 10, "y": 20, "radius": 1, "parentTopic": "t", "parentDomain": "d", "crowded": False}], "domains": [], "topics": [], "idf": {}, "diagnostics": {}}
        w.call("atlas.save", {"vaultKey": snap["vaultKey"], "atlas": atlas})
        saved = w.call("atlas.load", {"vaultKey": snap["vaultKey"]})["atlas"]
        self.assertNotIn("evidence", saved["nodes"][0])
        self.assertNotIn("title", saved["nodes"][0])
        w.files = []
        self.assertEqual(w.call("atlas.load", {"vaultKey": snap["vaultKey"]})["atlas"]["nodes"], [])
        w.root += "-other"
        with self.assertRaises(RuntimeError):
            w.call("atlas.save", {"vaultKey": snap["vaultKey"], "atlas": atlas})


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Development audit manifest only; never opens the writable index API.

python3 habitat-core/examples/export_audit_manifest.py VAULT OUTPUT_JSON
The output contains paths/hashes/origin, never source contents. The supported
input policy follows habitat/backend/capture.rs; raw mail is additionally
excluded from this developer audit. This is not a host-RPC capture test.
"""
import hashlib
import json
import os
import pathlib
import sqlite3
import sys

root = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2])
if output.resolve().is_relative_to(root):
    raise SystemExit("audit output must be outside the Vault")


def eligible(path):
    parts = pathlib.PurePosixPath(path).parts
    return (bool(path) and not path.startswith("/") and "\0" not in path
            and "\\" not in path and not path.startswith(".notemd/")
            and path not in ("USER.md", "MEMORY.md", "AGENTS.md", "CLAUDE.md")
            and not any(p in ("", ".", "..", ".git", ".credentials", ".local",
                              "node_modules", ".ssh", ".aws", "mail", "mails")
                        or p.startswith(".env") for p in parts))


def read(path):
    cursor = root
    for part in pathlib.PurePosixPath(path).parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError("symlink is outside the audit input policy")
    return cursor.read_bytes()


key = hashlib.sha256(str(root).encode()).hexdigest()[:16]
db = pathlib.Path.home() / "Library/Application Support/net.notemd.app/search" / key / "index.db"
connection = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
connection.execute("PRAGMA query_only=ON")
connection.execute("BEGIN")
meta = dict(connection.execute("SELECT key,value FROM meta"))
if meta.get("vault_root") != str(root) or meta.get("schema_version") != "7":
    raise SystemExit("index identity/schema mismatch")
inputs = {p: {"path": p, "hash": h, "origin": origin}
          for p, h, origin in connection.execute("SELECT path,content_hash,origin FROM files") if eligible(p)}
connection.rollback()
connection.close()
configs = {}
for path in (".notemd/settings.json", ".notemd/meetings.json"):
    if (root / path).exists():
        content = read(path)
        inputs[path] = {"path": path, "hash": hashlib.sha256(content).hexdigest(), "origin": "config"}
        configs[path] = json.loads(content)
meeting_root = configs.get(".notemd/meetings.json", {}).get("meetings_root", "ssot/meetings").strip("/")
excluded = [p.strip("/") for p in configs.get(".notemd/settings.json", {}).get("searchExcludeDirs", []) if p.strip("/")]
if not eligible(meeting_root):
    raise SystemExit("meeting root outside audit scope")


def allowed(path):
    return eligible(path) and not any(path == p or path.startswith(p + "/") for p in excluded)


knowledge = 0
if allowed(meeting_root):
    for directory, dirs, files in os.walk(root / meeting_root, followlinks=False):
        dirs[:] = [name for name in dirs if not (pathlib.Path(directory) / name).is_symlink()
                   and allowed((pathlib.Path(directory) / name).relative_to(root).as_posix())]
        if "knowledge.json" not in files:
            continue
        path = (pathlib.Path(directory) / "knowledge.json").relative_to(root).as_posix()
        if not allowed(path):
            continue
        content = read(path)
        inputs[path] = {"path": path, "hash": hashlib.sha256(content).hexdigest(), "origin": "derived"}
        knowledge += 1
output.write_text(json.dumps([inputs[p] for p in sorted(inputs)], ensure_ascii=False))
print(json.dumps({"inputs": len(inputs), "knowledgeDatasets": knowledge, "output": str(output)}))

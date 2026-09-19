#!/usr/bin/env python3
"""Create a deterministic, non-mutating inventory of selected transcript files."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

EXTENSIONS = {".md", ".srt", ".vtt"}


def inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument("--root", action="append", required=True, help="Vault-relative file or directory")
    parser.add_argument("--subject-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    vault = args.vault.resolve(strict=True)
    if not args.subject_id.startswith("human:") or len(args.subject_id) <= 6:
        parser.error("--subject-id must use human:<id>")
    files: dict[str, Path] = {}
    for raw in args.root:
        requested = (vault / raw).resolve(strict=True)
        if not inside(vault, requested):
            parser.error(f"root escapes Vault: {raw}")
        candidates = [requested] if requested.is_file() else requested.rglob("*")
        for candidate in candidates:
            if candidate.is_symlink() or not candidate.is_file() or candidate.suffix.lower() not in EXTENSIONS:
                continue
            resolved = candidate.resolve(strict=True)
            if not inside(vault, resolved):
                parser.error(f"file escapes Vault: {candidate}")
            relative = resolved.relative_to(vault).as_posix()
            files[relative] = resolved

    sources = []
    for index, (relative, path) in enumerate(sorted(files.items()), 1):
        data = path.read_bytes()
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            status, error = "failed", "source is not valid UTF-8"
        else:
            status, error = "pending", None
        item = {
            "id": f"src_{index:05d}", "canonical_source_id": relative,
            "resource": relative, "content_sha256": hashlib.sha256(data).hexdigest(),
            "size_bytes": len(data), "status": status,
        }
        if error:
            item["error"] = error
        sources.append(item)

    output = {"schema": "notemd.conversation-dictionary-inventory.v1", "subject_id": args.subject_id, "roots": args.root, "sources": sources}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "sources": len(sources)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

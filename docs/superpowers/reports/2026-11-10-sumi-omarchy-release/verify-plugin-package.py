#!/usr/bin/env python3
"""Freeze actual signed Linux plugin bytes; host asset receipt remains pending."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import zipfile
from pathlib import Path


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--build-root", required=True, type=Path)
    args = parser.parse_args()
    repository = args.repository.resolve()
    build = args.build_root.resolve()
    output = build / "output"
    assert subprocess.check_output(["git", "-C", str(repository), "rev-parse", "v6.1110.2^{commit}"], text=True).strip() == args.source
    def frozen(path):
        return subprocess.check_output(["git", "-C", str(repository), "show", args.source + ":" + path])
    manifest = json.loads(frozen("plugins-src/write/manifest.v2.json"))
    assert (manifest["id"], manifest["version"], manifest["engines"]["notemd"]) == ("notemd.sumi", "0.1.11", ">=6.1110.2")
    assert set(manifest["binary"]) == {"aarch64-apple-darwin", "x86_64-unknown-linux-gnu"}
    package = output / "notemd.sumi/0.1.11/x86_64-unknown-linux-gnu.notemdpkg"
    signature = Path(str(package) + ".minisig")
    key = re.search(r'PLUGIN_REGISTRY_PUBKEY: &str =\s*"([^"]+)"', frozen("src-tauri/src/plugin_runtime/market.rs").decode()).group(1)
    tool = repository / "tasks/omarchy-build/minisign-tool"
    env = os.environ.copy()
    env["LD_LIBRARY_PATH"] = str(tool / "usr/lib/x86_64-linux-gnu")
    result = subprocess.run([str(tool / "usr/bin/minisign"), "-Vm", str(package), "-P", key],
                            env=env, capture_output=True, text=True, check=True)
    (output / "minisign-verification.txt").write_text(result.stdout + result.stderr)
    with zipfile.ZipFile(package) as archive:
        items = [item for item in archive.infolist() if not item.is_dir()]
        names = [item.filename for item in items]
        assert len(names) == len(set(names))
        assert all(not name.startswith("/") and ".." not in Path(name).parts for name in names)
        files = {name: sha(archive.read(name)) for name in names}
        assert json.loads(archive.read("manifest.json")) == manifest
        binary = archive.read("bin/notemd-sumi")
        assert binary == (output / "notemd-sumi").read_bytes()
        assert binary[:7] == b"\x7fELF\x02\x01\x01" and int.from_bytes(binary[18:20], "little") == 62
        assert archive.getinfo("bin/notemd-sumi").external_attr >> 16 & 0o111
        sounds = {name: value for name, value in files.items() if name.startswith("resources/sounds/")}
        assert len(sounds) == 14 and not any(name.startswith("ui/sounds/") for name in names)
        for name, value in sounds.items():
            assert sha(frozen("plugins-src/write/" + name)) == value
        resources = {name: value for name, value in files.items() if name.startswith("ui/sumi/")}
        assert len(resources) == 10
        for name, value in resources.items():
            assert sha(frozen("plugins-src/write/resources/sumi/" + Path(name).name)) == value
        assert not any(Path(name).suffix.lower() in {".ttf", ".otf", ".woff", ".woff2", ".ttc", ".otc"} for name in names)
    versions = {tuple(map(int, value.split("."))) for value in re.findall(r"\bGLIBC_([0-9.]+)\b", (output / "elf-symbol-versions.txt").read_text())}
    assert versions and max(versions) <= (2, 36)
    dependencies = (output / "ldd-debian12.txt").read_text()
    assert "not found" not in dependencies and "undefined symbol" not in dependencies
    inputs = json.loads((build / "build-inputs.json").read_text())
    assert inputs["sourceCommit"] == args.source and inputs["tag"] == "v6.1110.2"
    for name, expected in inputs["archiveSha256"].items():
        assert sha((build / "input" / name).read_bytes()) == expected
    receipt = {"sourceCommit": args.source, "sourceRepository": str(repository), "tag": "v6.1110.2",
        "package": {"id": "notemd.sumi", "version": "0.1.11", "arch": "x86_64-unknown-linux-gnu",
                    "path": str(package), "sha256": sha(package.read_bytes()), "signatureSha256": sha(signature.read_bytes()),
                    "bytes": package.stat().st_size, "files": files},
        "verification": {"signatureValid": True, "elf": "ELF64 x86_64", "maximumGlibcVersion": ".".join(map(str, max(versions))),
                         "debian12DependenciesResolved": True, "soundFiles": sounds, "fontMetadataFiles": resources,
                         "noFontPayload": True, "buildInputs": inputs},
        "hostReceiptPending": True, "published": False}
    (output / "plugin-package-receipt.json").write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"package": str(package), "sha256": receipt["package"]["sha256"], "signatureValid": True,
                      "maximumGlibcVersion": receipt["verification"]["maximumGlibcVersion"], "files": len(files)}))


if __name__ == "__main__":
    main()

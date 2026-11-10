#!/usr/bin/env python3
"""Sumi 0.1.11 Linux publication using the existing Wrangler 3 Account Token flow.

Adapted from ../2026-11-09-sumi-0.1.7-plugin-release/publish-plugin.py.
Default mode is offline. No signing identities, tokens or tools are created.
The frozen receipt is supplied by the build owner, not invented by this script.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import time
import zipfile
from pathlib import Path

PLUGIN = "notemd.sumi"
VERSION = "0.1.11"
ARCH = "x86_64-unknown-linux-gnu"
HOST_TAG = "v6.1110.2"
MIN_HOST = ">=6.1110.2"
INDEX = "https://plugins.notemd.net/api/index.json"
DOWNLOAD = f"https://plugins.notemd.net/api/download/{PLUGIN}/{VERSION}/{ARCH}"
GITHUB = "https://api.github.com/repos/wizlijun/note.md"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def valid_sha(value, length=64):
    return isinstance(value, str) and re.fullmatch(f"[0-9a-f]{{{length}}}", value) and set(value) != {"0"}


def validate_receipt(value, selected_source):
    require(valid_sha(selected_source, 40), "An explicit final source SHA is required")
    require(value.get("sourceCommit") == selected_source, "Receipt does not match selected source")
    package = value.get("package", {})
    require((package.get("id"), package.get("version"), package.get("arch")) ==
            (PLUGIN, VERSION, ARCH), "Only Sumi 0.1.11 Linux x86_64 is in scope")
    require(valid_sha(package.get("sha256")) and valid_sha(package.get("signatureSha256")),
            "Frozen package and signature hashes are required")
    require(isinstance(package.get("bytes"), int) and package["bytes"] > 0, "Missing package length")
    require(isinstance(package.get("files"), dict) and package["files"], "Missing exact package inventory")
    require(all(valid_sha(sha) for sha in package["files"].values()), "Invalid package file hash")
    host = value.get("host", {})
    require(host.get("tag") == HOST_TAG and host.get("sourceCommit") == selected_source,
            "Host tag and exact feature source must be frozen together")
    assets = host.get("assets")
    require(isinstance(assets, list) and assets, "Frozen Linux host asset inventory is required")
    names = []
    for asset in assets:
        name = asset.get("name", "")
        require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.+-]+", name), "Unsafe host asset name")
        require(valid_sha(asset.get("sha256")) and isinstance(asset.get("bytes"), int)
                and asset["bytes"] > 0, "Host asset hash/length must be explicit")
        names.append(name)
    require(len(names) == len(set(names)), "Duplicate host asset names")
    require(any(name == "note.md_6.1110.2_amd64.deb" or
                (name.startswith("notemd-6.1110.2-") and name.endswith("-x86_64.pkg.tar.zst"))
                for name in names), "Inventory must contain an actual x86_64 Linux host package")
    return value


def merge_entry(live, entry):
    require(isinstance(live.get("plugins"), list), "Invalid registry index")
    require((entry.get("id"), entry.get("version")) == (PLUGIN, VERSION), "Unexpected registry entry")
    keys = [(item["id"], item["version"]) for item in live["plugins"]]
    require(len(keys) == len(set(keys)), "Duplicate existing registry identities")
    existing = [item for item in live["plugins"] if (item["id"], item["version"]) == (PLUGIN, VERSION)]
    require(not existing or existing == [entry], "Existing immutable registry entry differs")
    return {**live, "plugins": [*live["plugins"], *([] if existing else [entry])]}


def validate_public_release(release, host):
    require(release.get("tag_name") == host["tag"] and release.get("draft") is False
            and release.get("prerelease") is False and release.get("published_at"),
            "Compatible host is not a public stable release")
    assets = release.get("assets", [])
    require(len({item["name"] for item in assets}) == len(assets), "Duplicate public release assets")
    by_name = {item["name"]: item for item in assets}
    for expected in host["assets"]:
        actual = by_name.get(expected["name"], {})
        require(actual.get("size") == expected["bytes"] and actual.get("state") == "uploaded",
                "Public host asset missing or wrong length: " + expected["name"])
        # Full anonymous bytes are checked below even when GitHub omits digest.
        require(actual.get("digest") in (None, "sha256:" + expected["sha256"]),
                "Public host asset digest differs: " + expected["name"])


class Publisher:
    def __init__(self, args):
        self.receipt = validate_receipt(json.loads(args.receipt.read_text()), args.source)
        self.source = args.source
        self.repository = args.repository.resolve()
        self.tools_repository = args.tools_repository.resolve()
        self.output = args.output.resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.package = args.package.resolve()
        self.generated_index = args.generated_index.resolve()
        self.signature = Path(str(self.package) + ".minisig")
        self.wrangler = self.tools_repository / "plugins-registry/node_modules/.bin/wrangler"
        self.config = self.tools_repository / "plugins-registry/wrangler.toml"
        self.token_file = args.token_env_file
        self.entry = None
        self.public_key = None

    def save(self, name, value):
        (self.output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repository), *args])

    def verify_signature(self, package):
        subprocess.run(["minisign", "-Vm", str(package), "-P", self.public_key],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

    def check(self):
        require(self.git("rev-parse", HOST_TAG + "^{commit}").decode().strip() == self.source,
                "Local frozen host tag differs from receipt")
        manifest = json.loads(self.git("show", self.source + ":plugins-src/write/manifest.v2.json"))
        require((manifest["id"], manifest["version"], manifest["engines"]["notemd"]) ==
                (PLUGIN, VERSION, MIN_HOST), "Frozen source manifest identity differs")
        require(manifest.get("binary", {}).get(ARCH) == "bin/notemd-sumi", "Linux binary declaration missing")
        # A source manifest may retain macOS support; this entry advertises only
        # the target actually built, signed and verified in this receipt.
        key_source = self.git("show", self.source + ":src-tauri/src/plugin_runtime/market.rs").decode()
        match = re.search(r'PLUGIN_REGISTRY_PUBKEY: &str =\s*"([^"]+)"', key_source)
        require(match is not None, "Frozen registry verification key missing")
        self.public_key = match.group(1)
        row = self.receipt["package"]
        require(self.package.name == ARCH + ".notemdpkg", "Unexpected package basename")
        require(digest(self.package) == row["sha256"] and self.package.stat().st_size == row["bytes"],
                "Frozen package bytes differ")
        require(digest(self.signature) == row["signatureSha256"], "Frozen signature differs")
        self.verify_signature(self.package)
        with zipfile.ZipFile(self.package) as archive:
            infos = [item for item in archive.infolist() if not item.is_dir()]
            names = [item.filename for item in infos]
            require(len(names) == len(set(names)), "Duplicate package members")
            require(all(not name.startswith("/") and ".." not in Path(name).parts for name in names),
                    "Unsafe package member")
            files = {name: hashlib.sha256(archive.read(name)).hexdigest() for name in names}
            require(files == row["files"], "Frozen package inventory differs")
            require(json.loads(archive.read("manifest.json")) == manifest, "Packaged manifest differs from tag")
            binary = archive.read("bin/notemd-sumi")
            require(binary[:6] == b"\x7fELF\x02\x01" and int.from_bytes(binary[18:20], "little") == 62,
                    "Packaged binary is not Linux x86_64 ELF")
            require(archive.getinfo("bin/notemd-sumi").external_attr >> 16 & 0o111,
                    "Packaged binary is not executable")
            require(not any(name.startswith("ui/sounds/") for name in names), "Duplicate UI sounds")
            sounds = {name: sha for name, sha in files.items() if name.startswith("resources/sounds/")}
            require(len(sounds) == 14, "Incomplete sound inventory")
            for name, sha in sounds.items():
                require(hashlib.sha256(self.git("show", self.source + ":plugins-src/write/" + name)).hexdigest() == sha,
                        "Sound asset differs from frozen source")
        installed = json.loads((self.tools_repository / "plugins-registry/node_modules/wrangler/package.json").read_text())
        require(installed.get("name") == "wrangler" and installed.get("version") == "3.114.17"
                and self.wrangler.is_file(), "Use the existing repository Wrangler 3.114.17")
        self.entry = {"id": PLUGIN, "version": VERSION, "min_host": MIN_HOST, "archs": [ARCH],
                      "size": row["bytes"], "sha256": {ARCH: row["sha256"]},
                      "name": manifest["name"], "category": "experience",
                      "description": manifest.get("description"), "i18n": manifest.get("i18n"),
                      "icon_url": manifest.get("icon_url"), "changelog_url": manifest.get("changelog_url"),
                      "download": {ARCH: DOWNLOAD}}
        generated = json.loads(self.generated_index.read_text())
        matches = [item for item in generated["plugins"]
                   if (item.get("id"), item.get("version")) == (PLUGIN, VERSION)]
        require(matches == [self.entry], "Existing index generator output differs from frozen Linux package")
        self.save("plugin-frozen-entry.json", self.entry)
        self.save("plugin-offline-check.json", {"ok": True, "sourceCommit": self.source,
                  "packageSha256": row["sha256"], "networkWritesPerformed": False})

    def environment(self):
        env = os.environ.copy()
        # Only the established Account API Token is loaded; no shell evaluation,
        # OAuth login, key generation or token output is permitted here.
        if self.token_file:
            for line in self.token_file.read_text().splitlines():
                match = re.match(r"(?:export\s+)?CLOUDFLARE_API_TOKEN\s*=\s*(.*)", line)
                if match:
                    env["CLOUDFLARE_API_TOKEN"] = match.group(1).strip().strip("\"'")
        require(bool(env.get("CLOUDFLARE_API_TOKEN")), "Existing Account API Token required")
        env["WRANGLER_SEND_METRICS"] = "false"
        return env

    def wrangler_call(self, args):
        return subprocess.run([str(self.wrangler), *args, "--config", str(self.config)],
                              cwd=self.tools_repository / "plugins-registry", env=self.environment(),
                              capture_output=True, timeout=600, check=False)

    def fetch(self, url, target):
        result = subprocess.run(["curl", "--silent", "--show-error", "--location", "--retry", "2",
                                 "--connect-timeout", "15", "--max-time", "300", "-A", "note.md-release-audit",
                                 "--output", str(target), "--write-out", "%{http_code}", url],
                                capture_output=True, text=True, timeout=620)
        require(result.returncode == 0, "Anonymous public fetch failed: " + url)
        return int(result.stdout)

    def fetch_json(self, url, name):
        path = self.output / name
        require(self.fetch(url, path) == 200, "Public JSON unavailable: " + url)
        return json.loads(path.read_text())

    def read_kv(self, name):
        result = self.wrangler_call(["kv:key", "get", "index", "--binding", "INDEX"])
        require(result.returncode == 0, "KV read failed")
        value = json.loads(result.stdout)
        require(isinstance(value.get("plugins"), list), "Invalid KV registry index")
        self.save(name, value)
        return value

    def host_gate(self):
        host = self.receipt["host"]
        release = self.fetch_json(GITHUB + "/releases/tags/" + host["tag"], "plugin-host-release.json")
        validate_public_release(release, host)
        commit = self.fetch_json(GITHUB + "/commits/" + host["tag"], "plugin-host-tag.json")
        require(commit.get("sha") == host["sourceCommit"], "Public tag differs from frozen source")
        for asset in host["assets"]:
            path = self.output / ("host-public-" + asset["name"])
            url = "https://github.com/wizlijun/note.md/releases/download/" + host["tag"] + "/" + asset["name"]
            require(self.fetch(url, path) == 200, "Anonymous Linux host package unavailable")
            require(path.stat().st_size == asset["bytes"] and digest(path) == asset["sha256"],
                    "Anonymous Linux host bytes differ from frozen inventory")
        self.save("plugin-host-gate.json", {"ok": True, "tag": host["tag"],
                  "sourceCommit": host["sourceCommit"], "assets": host["assets"]})

    def object_state(self, suffix):
        source = self.signature if suffix else self.package
        target = self.output / ("object-check-" + source.name)
        status = self.fetch(DOWNLOAD + suffix, target)
        require(status in (200, 404), f"Object presence uncertain (HTTP {status}); do not write")
        require(status != 200 or target.read_bytes() == source.read_bytes(), "Immutable public object differs")
        return status

    def inspect(self):
        public = self.fetch_json(INDEX, "plugin-index-public-before.json")
        kv = self.read_kv("plugin-index-kv-before.json")
        merge_entry(public, self.entry)
        merge_entry(kv, self.entry)
        states = {suffix: self.object_state(suffix) for suffix in ("", ".minisig")}
        self.save("plugin-occupancy.json", {"readOnly": True, "objects": states,
                  "observationNotReservation": True})

    def verify_public_packages(self):
        records = []
        for mode in ("normal", "fresh"):
            folder = self.output / ("plugin-public-" + mode)
            folder.mkdir(exist_ok=True)
            for suffix in ("", ".minisig"):
                source = self.signature if suffix else self.package
                target = folder / source.name
                url = DOWNLOAD + suffix
                if mode == "fresh":
                    url += "?release=sumi-linux-" + str(time.time_ns())
                require(self.fetch(url, target) == 200, "Public package/signature unavailable")
                require(target.read_bytes() == source.read_bytes(), "Public package/signature differs")
                records.append({"mode": mode, "file": source.name, "sha256": digest(target)})
            self.verify_signature(folder / self.package.name)
        self.save("plugin-public-packages.json", {"ok": True, "signaturesValid": True, "objects": records})

    def stage(self):
        # Inspect both keys and index before the first R2 mutation.
        self.inspect()
        for suffix in ("", ".minisig"):
            source = self.signature if suffix else self.package
            for attempt in range(3):
                if self.object_state(suffix) == 200:
                    break
                try:
                    result = self.wrangler_call(["r2", "object", "put", f"notemd-plugins/{PLUGIN}/{VERSION}/{source.name}",
                                                "--file", str(source), "--content-type", "application/octet-stream"])
                    self.save(f"plugin-r2-attempt-{source.name}-{attempt}.json", {"exitCode": result.returncode})
                except subprocess.TimeoutExpired:
                    self.save(f"plugin-r2-attempt-{source.name}-{attempt}.json", {"timeout": True})
                # On either success or uncertainty, read back before retry.
                if self.object_state(suffix) == 200:
                    break
                time.sleep(5)
            else:
                raise RuntimeError("Object remains absent after bounded retries; index unchanged")
        self.verify_public_packages()

    def publish_index(self):
        self.host_gate()
        self.verify_public_packages()
        before = self.read_kv("plugin-index-before.json")
        candidate = merge_entry(before, self.entry)
        self.save("plugin-index-candidate.json", candidate)
        if candidate != before:
            require(self.read_kv("plugin-index-prepublish.json") == before, "Concurrent index update; rebase before retry")
            try:
                result = self.wrangler_call(["kv:key", "put", "index", "--path", str(self.output / "plugin-index-candidate.json"),
                                            "--binding", "INDEX"])
                self.save("plugin-index-write.json", {"exitCode": result.returncode})
            except subprocess.TimeoutExpired:
                self.save("plugin-index-write.json", {"timeout": True})
        # A failed/uncertain write is read back, never blindly repeated.
        require(self.read_kv("plugin-index-kv-final.json") == candidate, "KV differs; inspect before retry")
        for mode in ("normal", "fresh"):
            for attempt in range(36):
                url = INDEX if mode == "normal" else INDEX + "?release=sumi-linux-" + str(time.time_ns())
                target = self.output / ("plugin-index-public-" + mode + ".json")
                if self.fetch(url, target) == 200 and json.loads(target.read_text()) == candidate:
                    break
                if attempt == 35:
                    raise RuntimeError("Public index has not converged; do not rewrite")
                time.sleep(10)
        require(candidate["plugins"][:len(before["plugins"])] == before["plugins"], "Historical entries changed")
        self.save("plugin-publication.json", {"ok": True, "sourceCommit": self.source,
                  "historicalEntriesUnchanged": True, "compatibleLinuxHostPublic": True,
                  "publicNormalFreshAndKvEqual": True, "added": len(candidate["plugins"]) - len(before["plugins"])})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", nargs="?", default="check", choices=["check", "inspect", "stage", "publish-index"])
    for name in ("receipt", "repository", "tools-repository", "package", "generated-index", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--source", required=True, help="Exact final tag source SHA matching the frozen receipt")
    parser.add_argument("--token-env-file", type=Path, help="Existing env file; only CLOUDFLARE_API_TOKEN is read")
    args = parser.parse_args()
    publisher = Publisher(args)
    publisher.check()
    if args.mode != "check":
        getattr(publisher, args.mode.replace("-", "_"))()
    print(json.dumps({"mode": args.mode, "completed": True, "sourceCommit": args.source}))


if __name__ == "__main__":
    main()

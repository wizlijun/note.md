"""Offline publication guards. All network and external writes are simulated."""
import copy
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("sumi_publisher", HERE / "publish-plugin.py")
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)
SOURCE = p.SOURCE
PROFILE = p.PROFILES["sumi"]


def receipt():
    return {"sourceCommit": SOURCE,
            "package": {"id": PROFILE["id"], "version": PROFILE["version"], "arch": PROFILE["arch"],
                        "sha256": "b" * 64, "signatureSha256": "c" * 64, "bytes": 42,
                        "files": {"manifest.json": "d" * 64}},
            "host": {"tag": p.HOST_TAG, "sourceCommit": SOURCE,
                     "assets": [{"name": "note.md_6.1110.4_amd64.deb", "sha256": "e" * 64, "bytes": 50}]}}


def entry():
    return {"id": PROFILE["id"], "version": PROFILE["version"], "archs": [PROFILE["arch"]], "min_host": p.MIN_HOST}


class GuardTests(unittest.TestCase):
    def test_missing_or_wrong_freeze_inputs_rejected(self):
        self.assertEqual(p.validate_receipt(receipt(), SOURCE, PROFILE), receipt())
        changes = [lambda r: r.pop("host"), lambda r: r["host"].pop("assets"),
                   lambda r: r["host"].update(sourceCommit="f" * 40),
                   lambda r: r["host"].update(tag="v6.1110.1"),
                   lambda r: r["host"]["assets"][0].pop("sha256"),
                   lambda r: r["host"]["assets"][0].update(name="note.md-aarch64.app.tar.gz"),
                   lambda r: r["package"].update(arch="aarch64-apple-darwin"),
                   lambda r: r["package"].update(version="0.1.10")]
        for change in changes:
            with self.subTest(change=change):
                value = receipt()
                change(value)
                with self.assertRaises(RuntimeError):
                    p.validate_receipt(value, SOURCE, PROFILE)

    def test_append_preserves_history_and_unknown_root_fields(self):
        old = {"generated": "untouched", "plugins": [
            {"id": PROFILE["id"], "version": "0.1.10", "archs": ["aarch64-apple-darwin"], "sha256": {"mac": "old"}},
            {"id": "other.plugin", "version": "1.0", "unknown": {"nested": [1, 2]}}]}
        before = copy.deepcopy(old)
        merged = p.merge_entry(old, entry(), PROFILE)
        self.assertEqual(old, before)
        self.assertEqual(merged["plugins"][:-1], before["plugins"])
        self.assertEqual(merged["generated"], "untouched")
        self.assertEqual(p.merge_entry(merged, entry(), PROFILE), merged)

    def test_conflicting_or_duplicate_identity_rejected(self):
        for plugins in [[{**entry(), "min_host": ">=0.0.0"}], [entry(), entry()]]:
            with self.assertRaises(RuntimeError):
                p.merge_entry({"plugins": plugins}, entry(), PROFILE)

    def test_public_host_must_be_stable_and_assets_exact(self):
        host = receipt()["host"]
        release = {"tag_name": p.HOST_TAG, "draft": False, "prerelease": False, "published_at": "date",
                   "assets": [{"name": host["assets"][0]["name"], "state": "uploaded", "size": 50,
                               "digest": "sha256:" + "e" * 64}]}
        p.validate_public_release(release, host)
        for change in [lambda r: r.update(draft=True), lambda r: r.update(prerelease=True),
                       lambda r: r.update(assets=[]), lambda r: r["assets"][0].update(size=51),
                       lambda r: r["assets"][0].update(digest="sha256:" + "f" * 64)]:
            bad = copy.deepcopy(release)
            change(bad)
            with self.assertRaises(RuntimeError):
                p.validate_public_release(bad, host)

    def test_two_platform_manifest_emits_only_built_linux_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / (PROFILE["arch"] + ".notemdpkg")
            manifest = {"id": PROFILE["id"], "version": PROFILE["version"], "engines": {"notemd": p.MIN_HOST},
                        "binary": {PROFILE["arch"]: "bin/notemd-sumi", "aarch64-apple-darwin": "bin/notemd-sumi"},
                        "name": "Sumi Typewriter"}
            elf = b"\x7fELF\x02\x01" + b"\0" * 12 + b"\x3e\0"
            contents = {"manifest.json": json.dumps(manifest).encode(), "bin/notemd-sumi": elf, "ui/index.html": b"<html></html>"}
            contents.update({f"resources/sounds/{n}.wav": b"sound" for n in range(14)})
            with zipfile.ZipFile(package, "w") as archive:
                for name, data in contents.items():
                    info = zipfile.ZipInfo(name)
                    info.external_attr = (0o100755 if name == "bin/notemd-sumi" else 0o100644) << 16
                    archive.writestr(info, data)
            signature = Path(str(package) + ".minisig")
            signature.write_text("test signature only")
            frozen = receipt()
            frozen["package"].update(sha256=p.digest(package), signatureSha256=p.digest(signature),
                bytes=package.stat().st_size, files={name: hashlib.sha256(data).hexdigest() for name, data in contents.items()})
            receipt_file = root / "receipt.json"
            receipt_file.write_text(json.dumps(frozen))
            node = root / "plugins-registry/node_modules"
            (node / ".bin").mkdir(parents=True)
            (node / ".bin/wrangler").write_text("fixture")
            (node / "wrangler").mkdir()
            (node / "wrangler/package.json").write_text(json.dumps({"name": "wrangler", "version": "3.114.17"}))
            generated = {"id": PROFILE["id"], "version": PROFILE["version"], "min_host": p.MIN_HOST, "archs": [PROFILE["arch"]],
                         "size": package.stat().st_size, "sha256": {PROFILE["arch"]: p.digest(package)},
                         "name": "Sumi Typewriter", "category": "experience", "description": None,
                         "i18n": None, "icon_url": None, "changelog_url": None, "download": {PROFILE["arch"]: p.download(PROFILE)}}
            index = root / "index.json"
            index.write_text(json.dumps({"plugins": [generated]}))
            publisher = p.Publisher(SimpleNamespace(profile="sumi", receipt=receipt_file, source=SOURCE, repository=root,
                tools_repository=root, package=package, generated_index=index, output=root / "evidence", token_env_file=None))
            def git(*args):
                if args[0] == "rev-parse":
                    return (SOURCE + "\n").encode()
                if args[-1].endswith("manifest.v2.json"):
                    return json.dumps(manifest).encode()
                if args[-1].endswith("market.rs"):
                    return b'pub const PLUGIN_REGISTRY_PUBKEY: &str = "public-fixture";'
                return b"sound"
            with patch.object(publisher, "git", git), patch.object(publisher, "verify_signature"):
                publisher.check()
            self.assertEqual(publisher.entry["archs"], [PROFILE["arch"]])
            self.assertEqual(list(publisher.entry["download"]), [PROFILE["arch"]])
            self.assertIn("aarch64-apple-darwin", manifest["binary"])


class MutationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.publisher = p.Publisher.__new__(p.Publisher)
        self.publisher.output = Path(self.directory.name)
        self.publisher.source = SOURCE
        self.publisher.profile = PROFILE
        self.publisher.plugin = PROFILE["id"]
        self.publisher.version = PROFILE["version"]
        self.publisher.arch = PROFILE["arch"]
        self.publisher.download = p.download(PROFILE)
        self.publisher.entry = entry()
        self.publisher.host_gate = Mock()
        self.publisher.verify_public_packages = Mock()
        self.publisher.wrangler_call = Mock(return_value=SimpleNamespace(returncode=0))
        self.before = {"plugins": [{"id": PROFILE["id"], "version": "0.1.10", "archs": ["aarch64-apple-darwin"]}]}
        self.after = p.merge_entry(self.before, entry(), PROFILE)

    def public_index(self, url, path):
        path.write_text(json.dumps(self.after))
        return 200

    def test_no_writes_on_host_signature_or_concurrent_change(self):
        for failure in ("host", "signature", "concurrent"):
            with self.subTest(failure=failure):
                q = self.publisher
                q.host_gate = Mock(side_effect=RuntimeError("host") if failure == "host" else None)
                q.verify_public_packages = Mock(side_effect=RuntimeError("signature") if failure == "signature" else None)
                q.read_kv = Mock(side_effect=[self.before, {"plugins": []}])
                with self.assertRaises(RuntimeError):
                    q.publish_index()
                q.wrangler_call.assert_not_called()

    def test_order_preserves_old_entries_and_verifies_after_write(self):
        q = self.publisher
        calls = []
        q.host_gate.side_effect = lambda: calls.append("host")
        q.verify_public_packages.side_effect = lambda: calls.append("package")
        q.read_kv = Mock(side_effect=[self.before, self.before, self.after])
        q.fetch = self.public_index
        q.wrangler_call.side_effect = lambda args: calls.append("write") or SimpleNamespace(returncode=0)
        q.publish_index()
        self.assertEqual(calls, ["host", "package", "write"])
        self.assertEqual(json.loads((q.output / "plugin-index-candidate.json").read_text()), self.after)

    def test_uncertain_kv_write_reads_back_without_repeating(self):
        q = self.publisher
        q.read_kv = Mock(side_effect=[self.before, self.before, self.after])
        q.fetch = self.public_index
        q.wrangler_call.side_effect = subprocess.TimeoutExpired("wrangler", 600)
        q.publish_index()
        self.assertEqual(q.wrangler_call.call_count, 1)

    def test_r2_checks_both_objects_before_any_write(self):
        q = self.publisher
        q.inspect = Mock(side_effect=RuntimeError("signature key occupied by different bytes"))
        with self.assertRaises(RuntimeError):
            q.stage()
        q.wrangler_call.assert_not_called()

    def test_uncertain_r2_write_reads_back_before_retry(self):
        q = self.publisher
        q.package = q.output / (PROFILE["arch"] + ".notemdpkg")
        q.signature = Path(str(q.package) + ".minisig")
        q.inspect = Mock()
        q.object_state = Mock(side_effect=[404, 200, 200])
        q.wrangler_call.side_effect = subprocess.TimeoutExpired("wrangler", 600)
        q.stage()
        self.assertEqual(q.wrangler_call.call_count, 1)
        self.assertEqual(q.object_state.call_args_list[0].args, ("",))
        self.assertEqual(q.object_state.call_args_list[1].args, ("",))
        q.verify_public_packages.assert_called_once()

class ProfileTests(unittest.TestCase):
    def check_fixture(self, selected, *, extra=None, binary=False, wrong_index=False):
        profile = p.PROFILES[selected]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = {"id": profile["id"], "version": profile["version"],
                        "engines": {"notemd": p.MIN_HOST}, "name": selected}
            contents = {"ui/index.html": b"<html>fixture</html>"}
            if profile["native"]:
                manifest["binary"] = {profile["arch"]: "bin/notemd-sumi", "aarch64-apple-darwin": "bin/notemd-sumi"}
                contents["bin/notemd-sumi"] = b"\x7fELF\x02\x01" + b"\0" * 12 + b"\x3e\0"
                contents.update({f"resources/sounds/{n}.wav": b"sound" for n in range(14)})
            elif binary:
                manifest["binary"] = {"universal": "bin/forbidden"}
            if extra:
                contents[extra] = b"unexpected"
            contents["manifest.json"] = json.dumps(manifest).encode()
            package = root / (profile["arch"] + ".notemdpkg")
            with zipfile.ZipFile(package, "w") as archive:
                for name, data in contents.items():
                    info = zipfile.ZipInfo(name)
                    info.external_attr = (0o100755 if name == "bin/notemd-sumi" else 0o100644) << 16
                    archive.writestr(info, data)
            signature = Path(str(package) + ".minisig")
            signature.write_text("fixture only, not a signature")
            frozen = receipt()
            frozen["package"].update(id=profile["id"], version=profile["version"], arch=profile["arch"],
                sha256=p.digest(package), signatureSha256=p.digest(signature), bytes=package.stat().st_size,
                files={name: hashlib.sha256(data).hexdigest() for name, data in contents.items() if not name.endswith("/")})
            receipt_file = root / "receipt.json"
            receipt_file.write_text(json.dumps(frozen))
            node = root / "plugins-registry/node_modules"
            (node / ".bin").mkdir(parents=True)
            (node / ".bin/wrangler").write_text("offline fixture")
            (node / "wrangler").mkdir()
            (node / "wrangler/package.json").write_text(json.dumps({"name": "wrangler", "version": "3.114.17"}))
            expected = {"id": profile["id"], "version": profile["version"], "min_host": p.MIN_HOST,
                "archs": [profile["arch"]], "size": package.stat().st_size,
                "sha256": {profile["arch"]: p.digest(package)}, "name": selected, "category": profile["category"],
                "description": None, "i18n": None, "icon_url": None, "changelog_url": None,
                "download": {profile["arch"]: p.download(profile)}}
            index = root / "index.json"
            index.write_text(json.dumps({"plugins": [{**expected, **({"archs": ["any"]} if wrong_index else {})}]}))
            q = p.Publisher(SimpleNamespace(profile=selected, receipt=receipt_file, source=SOURCE, repository=root,
                tools_repository=root, package=package, generated_index=index, output=root / "evidence", token_env_file=None))
            def git(*args):
                if args[0] == "rev-parse": return SOURCE.encode()
                if args[-1].endswith("manifest.v2.json"): return json.dumps(manifest).encode()
                if args[-1].endswith("market.rs"): return b'PLUGIN_REGISTRY_PUBKEY: &str = "fixture-public";'
                return b"sound"
            with patch.object(q, "git", side_effect=git), patch.object(q, "verify_signature") as signature_check, \
                    patch.object(q, "wrangler_call", side_effect=AssertionError("offline check wrote remotely")):
                q.check()
                signature_check.assert_called_once_with(package)
            return q.entry

    def test_all_three_fixed_profiles_match_generated_packages_offline(self):
        for selected, profile in p.PROFILES.items():
            with self.subTest(profile=selected):
                result = self.check_fixture(selected)
                self.assertEqual(result["archs"], [profile["arch"]])
                self.assertEqual(result["download"], {profile["arch"]: p.download(profile)})

    def test_ui_only_rejects_binary_declarations_and_native_payloads(self):
        for selected in ("next", "idea"):
            for change in ({"binary": True}, {"extra": "bin/forbidden"}, {"extra": "bin/"}, {"extra": "resources/native.so"}):
                with self.subTest(profile=selected, change=change), self.assertRaises(RuntimeError):
                    self.check_fixture(selected, **change)

    def test_generated_any_key_cannot_replace_real_universal_contract(self):
        for selected in ("next", "idea"):
            with self.subTest(profile=selected), self.assertRaises(RuntimeError):
                self.check_fixture(selected, wrong_index=True)

    def test_three_serial_merges_preserve_every_earlier_entry_and_root_metadata(self):
        before = {"schema": {"unknown": [1, 2]}, "plugins": [
            {"id": "notemd.sumi", "version": "0.1.10", "archs": ["aarch64-apple-darwin"]},
            {"id": "notemd.sumi", "version": "0.1.11", "archs": ["x86_64-unknown-linux-gnu"]},
            {"id": "notemd.next", "version": "1.13.2", "archs": ["universal"]},
            {"id": "notemd.idea-spark", "version": "1.3.7", "archs": ["universal"]}]}
        current = copy.deepcopy(before)
        for profile in p.PROFILES.values():
            previous = copy.deepcopy(current)
            added = {"id": profile["id"], "version": profile["version"], "archs": [profile["arch"]]}
            current = p.merge_entry(current, added, profile)
            self.assertEqual(current["plugins"][:-1], previous["plugins"])
            self.assertEqual(p.merge_entry(current, added, profile), current)
        self.assertEqual(current["plugins"][:4], before["plugins"])
        self.assertEqual(current["schema"], before["schema"])
        self.assertEqual(len(current["plugins"]), 7)

    def test_wrong_frozen_source_and_cross_profile_receipts_fail(self):
        with self.assertRaises(RuntimeError): p.validate_receipt(receipt(), "a" * 40, PROFILE)
        for selected in ("next", "idea"):
            with self.assertRaises(RuntimeError): p.validate_receipt(receipt(), SOURCE, p.PROFILES[selected])

    def test_public_object_with_different_bytes_or_uncertain_http_never_overwrites(self):
        for status, content in [(200, b"other"), (403, b"error"), (500, b"error")]:
            with tempfile.TemporaryDirectory() as temporary:
                q = p.Publisher.__new__(p.Publisher)
                q.output = Path(temporary)
                q.package = q.output / "universal.notemdpkg"
                q.package.write_bytes(b"expected")
                q.download = p.download(p.PROFILES["next"])
                def fetch(url, target): target.write_bytes(content); return status
                q.fetch = fetch
                with self.assertRaises(RuntimeError): q.object_state("")

class PublicHostGateTests(unittest.TestCase):
    def test_public_tag_and_anonymous_asset_bytes_are_both_required(self):
        for failure in (None, "tag", "asset", "http"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                q = p.Publisher.__new__(p.Publisher)
                q.output = Path(temporary)
                q.receipt = receipt()
                expected = b"host-package" * 5
                asset = q.receipt["host"]["assets"][0]
                asset.update(bytes=len(expected), sha256=hashlib.sha256(expected).hexdigest())
                release = {"tag_name": p.HOST_TAG, "draft": False, "prerelease": False,
                    "published_at": "2026-11-10T00:00:00Z", "assets": [
                        {"name": asset["name"], "state": "uploaded", "size": len(expected)}]}
                q.fetch_json = Mock(side_effect=[release, {"sha": "a" * 40 if failure == "tag" else SOURCE}])
                def fetch(url, target):
                    self.assertEqual(url, "https://github.com/wizlijun/note.md/releases/download/" + p.HOST_TAG + "/" + asset["name"])
                    target.write_bytes(b"wrong" if failure == "asset" else expected)
                    return 404 if failure == "http" else 200
                q.fetch = fetch
                q.wrangler_call = Mock(side_effect=AssertionError("host gate must be read-only"))
                if failure:
                    with self.assertRaises(RuntimeError): q.host_gate()
                else:
                    q.host_gate()
                    self.assertTrue(json.loads((q.output / "plugin-host-gate.json").read_text())["ok"])
                q.wrangler_call.assert_not_called()

    def test_r2_retry_keeps_identical_object_key_and_reads_before_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            q = p.Publisher.__new__(p.Publisher)
            q.output = Path(temporary)
            q.plugin, q.version = "notemd.next", "1.13.3"
            q.package = q.output / "universal.notemdpkg"
            q.signature = Path(str(q.package) + ".minisig")
            q.inspect = Mock()
            q.object_state = Mock(side_effect=[404, 404, 404, 200, 200])
            q.verify_public_packages = Mock()
            q.wrangler_call = Mock(side_effect=[SimpleNamespace(returncode=1), SimpleNamespace(returncode=0)])
            with patch.object(p.time, "sleep"):
                q.stage()
            self.assertEqual(q.wrangler_call.call_count, 2)
            self.assertEqual(q.wrangler_call.call_args_list[0], q.wrangler_call.call_args_list[1])
            self.assertIn("notemd-plugins/notemd.next/1.13.3/universal.notemdpkg", q.wrangler_call.call_args.args[0])
            q.verify_public_packages.assert_called_once()


if __name__ == "__main__":
    unittest.main()

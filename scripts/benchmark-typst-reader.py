#!/usr/bin/env python3
"""Benchmark the real native plugin protocol with an isolated, disposable cache.

Example:
  python3 scripts/benchmark-typst-reader.py --binary /tmp/notemd-typst-before \
    --source '/vault/books/Example/book.typeset.md' --vault /vault \
    --timeout 120 --output /tmp/typst-before.json

Times are seconds from the cold render request unless named *_rpc_seconds.
RSS is sampled every 100 ms (KiB), so brief peaks may be missed. Source text,
rendered pages and stderr contents are never included in the JSON report.
"""

import argparse
import hashlib
import json
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time


class RpcError(Exception):
    pass


class Client:
    def __init__(self, binary):
        self.process = subprocess.Popen(
            [str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.responses = queue.Queue()
        self.serial = 0
        self.peak_rss_kib = 0
        self.stderr_bytes = 0
        self.stderr_error_lines = 0
        self.stop = threading.Event()
        self.threads = [
            threading.Thread(target=self.read_stdout, daemon=True),
            threading.Thread(target=self.read_stderr, daemon=True),
            threading.Thread(target=self.sample_memory, daemon=True),
        ]
        for thread in self.threads:
            thread.start()

    def read_stdout(self):
        for line in self.process.stdout:
            try:
                self.responses.put(json.loads(line))
            except json.JSONDecodeError:
                pass
        self.responses.put(None)

    def read_stderr(self):
        for line in self.process.stderr:
            self.stderr_bytes += len(line.encode())
            if re.search(r"error|panic|failed", line, re.IGNORECASE):
                self.stderr_error_lines += 1

    def sample_memory(self):
        while not self.stop.is_set():
            try:
                result = subprocess.run(
                    ["ps", "-o", "rss=", "-p", str(self.process.pid)],
                    capture_output=True, text=True, timeout=1,
                )
                self.peak_rss_kib = max(self.peak_rss_kib, int(result.stdout.strip() or 0))
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
            self.stop.wait(0.1)

    def rpc(self, method, params, deadline):
        if time.monotonic() >= deadline:
            raise TimeoutError(method)
        self.serial += 1
        request_id = self.serial
        self.process.stdin.write(json.dumps({
            "jsonrpc": "2.0", "id": request_id, "method": method, "params": params,
        }, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        while True:
            try:
                response = self.responses.get(timeout=max(0.001, deadline - time.monotonic()))
            except queue.Empty:
                raise TimeoutError(method) from None
            if response is None:
                raise RpcError("plugin exited before replying")
            if response.get("id") == request_id:
                if response.get("error"):
                    # Diagnostic messages can contain excerpts from the book.
                    raise RpcError("RPC error code " + str(response["error"].get("code")))
                return response.get("result")

    def ui(self, method, params, deadline):
        return self.rpc("ui.request", {"method": method, "params": params}, deadline)

    def close(self):
        shutdown = "already_exited"
        if self.process.poll() is None:
            try:
                self.rpc("$deactivate", {}, time.monotonic() + 1)
                self.process.wait(timeout=1)
                shutdown = "deactivated"
            except (TimeoutError, RpcError, BrokenPipeError, subprocess.TimeoutExpired):
                self.process.terminate()
                shutdown = "terminated"
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                    shutdown = "killed"
        self.stop.set()
        for thread in self.threads:
            thread.join(timeout=2)
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            pipe.close()
        return shutdown


def handles(result):
    """Support legacy cache-key sessions and asynchronous render-id sessions."""
    return {key: result[key] for key in ("render_id", "cache_key") if result.get(key)}


def benchmark(args):
    binary = args.binary.resolve()
    source = args.source.resolve()
    vault = args.vault.resolve()
    content = source.read_text()
    data = {
        "binary": str(binary), "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "source": str(source), "source_bytes": len(content.encode()),
        "source_sha256": hashlib.sha256(content.encode()).hexdigest(),
        "timeout_seconds": args.timeout, "first_page_only": args.first_page_only,
        "status": "running", "prepare_seconds": None, "first_page_seconds": None,
        "full_seconds": None, "hot_rpc_seconds": None, "hot_seconds": None, "hot_hit": None,
        "pages": 0, "page_rpc_while_busy_seconds": [], "stderr_error_lines": 0,
    }
    request = {"uri": str(source), "content": content, "vault_root": str(vault)}
    with tempfile.TemporaryDirectory(prefix="typst-benchmark-") as directory:
        client = Client(binary)
        started = time.monotonic()
        deadline = started + args.timeout
        stage = "initialize"
        try:
            client.rpc("$initialize", {
                "protocol_version": 2, "host_version": "6.921.2", "locale": "en",
                "theme": "light", "plugin_root": str(binary.parent), "data_dir": directory,
            }, deadline)
            started = time.monotonic()
            deadline = started + args.timeout
            stage = "prepare"
            result = client.ui("render", request, deadline)
            data["prepare_seconds"] = time.monotonic() - started
            known_handles = handles(result)
            last_probe = 0.0
            while True:
                known_handles.update(handles(result))
                if result.get("stage") in ("error", "cancelled"):
                    raise RpcError("renderer entered terminal " + result["stage"] + " state")
                data["pages"] = result.get("page_count", 0)
                if data["pages"] and data["first_page_seconds"] is None:
                    stage = "first_page"
                    page = client.ui("page", {"cache_key": known_handles["cache_key"], "page": 0}, deadline)
                    if not page.get("svg"):
                        raise RpcError("first page response has no SVG")
                    data["first_page_seconds"] = time.monotonic() - started
                    data["first_page_svg_bytes"] = len(page["svg"].encode())
                    if args.first_page_only:
                        data["status"] = "first_page_ready"
                        break
                if result.get("complete"):
                    data["full_seconds"] = time.monotonic() - started
                    stage = "verify_pages"
                    data["verified_pages"] = {}
                    for index in sorted({0, data["pages"] // 2, data["pages"] - 1}):
                        page = client.ui("page", {"cache_key": known_handles["cache_key"], "page": index}, deadline)
                        if not page.get("svg", "").startswith("<svg"):
                            raise RpcError("completed page response has no SVG")
                        data["verified_pages"][str(index)] = len(page["svg"].encode())
                    stage = "hot_render"
                    hot_start = time.monotonic()
                    hot = client.ui("render", request, deadline)
                    data["hot_rpc_seconds"] = time.monotonic() - hot_start
                    hot_handles = handles(hot)
                    while not hot.get("complete"):
                        hot_handles.update(handles(hot))
                        if hot.get("stage") in ("error", "cancelled"):
                            raise RpcError("hot renderer entered terminal " + hot["stage"] + " state")
                        if time.monotonic() >= deadline:
                            raise TimeoutError(stage)
                        time.sleep(min(0.05, max(0, deadline - time.monotonic())))
                        hot = client.ui("render-next", hot_handles, deadline)
                    data["hot_seconds"] = time.monotonic() - hot_start
                    data["hot_hit"] = hot.get("hit", False)
                    data["hot_complete"] = hot.get("complete", False)
                    if hot.get("page_count") != data["pages"] or hot.get("cache_key") != result.get("cache_key"):
                        raise RpcError("hot cache differs from cold render")
                    data["status"] = "complete"
                    break
                if result.get("busy") and data["pages"] and time.monotonic() - last_probe >= 1:
                    stage = "page_while_busy"
                    probe_start = time.monotonic()
                    page = client.ui("page", {"cache_key": known_handles["cache_key"], "page": 0}, deadline)
                    if not page.get("svg"):
                        raise RpcError("busy page response has no SVG")
                    data["page_rpc_while_busy_seconds"].append(time.monotonic() - probe_start)
                    last_probe = time.monotonic()
                stage = "render_next"
                if time.monotonic() >= deadline:
                    raise TimeoutError(stage)
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
                result = client.ui("render-next", known_handles, deadline)
        except TimeoutError:
            data.update(status="timeout", timeout_stage=stage)
        except (RpcError, BrokenPipeError, OSError) as error:
            data.update(status="error", error_stage=stage, error=str(error))
        finally:
            data["elapsed_seconds"] = time.monotonic() - started
            data["shutdown"] = client.close()
            data["peak_rss_kib"] = client.peak_rss_kib
            data["stderr_bytes"] = client.stderr_bytes
            data["stderr_error_lines"] = client.stderr_error_lines
            data["exit_code"] = client.process.returncode
            data["temporary_caches_after_shutdown"] = sum(
                1 for path in Path(directory).rglob(".*.tmp-*") if path.is_dir()
            )
    probes = data.pop("page_rpc_while_busy_seconds")
    data["page_rpc_while_busy"] = {
        "samples": len(probes), "max_seconds": max(probes) if probes else None,
        "mean_seconds": sum(probes) / len(probes) if probes else None,
    }
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--first-page-only", action="store_true")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    result = benchmark(args)
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    args.output.write_text(encoded)
    print(encoded, end="")
    return 1 if result["status"] == "error" else 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Starts a shipped FundaCAD binary as its MCP server and builds a box with it.

    python3 scripts/bundle-smoke.py [--expect 6000] [--timeout 180] -- <program> [args...]

The program is whatever starts the stdio server: `fundacad --mcp`, an
AppImage with `--appimage-extract-and-run --mcp`, `flatpak run dev.fundacad.app
--mcp`, or a workspace `fundacad-mcp`. Exit 0 when the built volume matches.
Standard library only.
"""

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time


class Failure(Exception):
    pass


class Session:
    def __init__(self, argv, env, log_path, timeout):
        self.timeout = timeout
        self.log = open(log_path, "wb")
        self.proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, env=env
        )
        self.lines = queue.Queue()
        self.next_id = 0
        self.timed_out = False
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for raw in self.proc.stdout:
            self.lines.put(raw)
        self.lines.put(None)

    def send(self, msg):
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode())
            self.proc.stdin.flush()
        except OSError as e:
            raise Failure(f"the server closed its stdin: {e}")

    def rpc(self, method, params):
        self.next_id += 1
        want = self.next_id
        self.send({"jsonrpc": "2.0", "id": want, "method": method, "params": params})
        deadline = time.monotonic() + self.timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                self.timed_out = True
                raise Failure(f"{method}: no reply in {self.timeout:.0f} s")
            try:
                raw = self.lines.get(timeout=left)
            except queue.Empty:
                continue
            if raw is None:
                raise Failure(f"{method}: the server exited (code {self.proc.poll()}) before replying")
            try:
                msg = json.loads(raw)
            except ValueError:
                # Note: anything on stdout that is not JSON-RPC breaks a real
                # MCP host, so it is a failure here too, not noise to skip.
                raise Failure(f"{method}: a line on stdout is not JSON-RPC: {raw[:200]!r}")
            if msg.get("id") == want:
                if "error" in msg:
                    raise Failure(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def call(self, name, args):
        result = self.rpc("tools/call", {"name": name, "arguments": args})
        text = "".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        if result.get("isError"):
            raise Failure(f"{name} failed: {text[:2000]}")
        return text

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            # A server that already missed a deadline gets no second wait.
            return self.proc.wait(timeout=0.5 if self.timed_out else 20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            return None
        finally:
            self.log.close()


def volume_of(text):
    m = re.search(r"\bvol(?:ume)?\b[^0-9-]*(-?[0-9][0-9,]*(?:\.[0-9]+)?)", text, re.IGNORECASE)
    return float(m.group(1).replace(",", "")) if m else None


def smoke(argv, expect, timeout, work):
    env = dict(os.environ)
    env.setdefault("FUNDACAD_MCP_MODE", "standalone")
    # A path that never exists, so a FundaCAD the developer has open is never
    # found and attached to.
    env.setdefault("FUNDACAD_SESSION_FILE", os.path.join(work, "no-app-session.json"))
    env.setdefault("FUNDACAD_BLOB_DIR", os.path.join(work, "blobs"))
    env.setdefault("XDG_CACHE_HOME", os.path.join(work, "cache"))
    if os.path.isfile(argv[0]):
        # Note: CreateProcess does not reliably find a relative path written
        # with forward slashes, which is how a bash step names the exe.
        argv = [os.path.abspath(argv[0]), *argv[1:]]
    log_path = os.path.join(work, "server.log")
    s = Session(argv, env, log_path, timeout)
    replies = {}
    try:
        started = time.monotonic()
        init = s.rpc("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "bundle-smoke", "version": "1"},
        })
        s.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        print(f"initialize: {init.get('serverInfo')} in {time.monotonic() - started:.1f} s")
        replies["doc_new"] = s.call("doc_new", {})
        replies["feature_add"] = s.call("feature_add", {"feature": {
            "id": "bx1", "type": "box", "length": 30, "width": 20, "height": 10}})
        t = time.monotonic()
        replies["build"] = s.call("build", {})
        print(f"build in {time.monotonic() - t:.1f} s")
        got = volume_of(replies["build"])
        if got is None:
            replies["inspect"] = s.call("inspect", {})
            got = volume_of(replies["inspect"])
        if got is None:
            raise Failure("no volume in the build or inspect reply")
        if abs(got - expect) > 1e-6 * max(1.0, abs(expect)):
            raise Failure(f"volume {got}, expected {expect}")
        print(f"volume {got} == {expect}")
        return replies
    finally:
        code = s.close()
        print(f"server exit code {code}")
        with open(os.path.join(work, "replies.json"), "w") as f:
            json.dump(replies, f, indent=1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--expect", type=float, default=6000.0)
    ap.add_argument("--timeout", type=float, default=180.0, help="seconds per request")
    ap.add_argument("--work", help="directory for the server log and replies (default a temp dir)")
    ap.add_argument("argv", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    argv = a.argv[1:] if a.argv[:1] == ["--"] else a.argv
    if not argv:
        ap.error("name the program that starts the MCP server after --")
    work = a.work or tempfile.mkdtemp(prefix="fundacad-smoke-")
    os.makedirs(work, exist_ok=True)
    try:
        smoke(argv, a.expect, a.timeout, work)
    except (Failure, OSError) as e:
        print(f"::error::bundle smoke: {e}")
        log = os.path.join(work, "server.log")
        if os.path.exists(log):
            with open(log, "rb") as f:
                tail = f.read()[-4000:].decode("utf-8", "replace")
            print("--- server stderr (tail) ---\n" + tail)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

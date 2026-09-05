"""Three processes, one document.

Everything else about the live session is tested with the other side stubbed
out: sidecar/tests/test_live_session.py holds the rules with no socket, and
tests/live/liveSession.test.ts holds the window's loop with no engine. Both
would still pass if the two halves had agreed on different field names, or if
discovery never found a running app at all.

So this one stubs nothing that carries a message. It starts a real sidecar,
writes a real session file, runs a host loop that does what
src/live/liveSession.ts does — publish, collect, apply, raise the revision — and
drives mcp/server.py over its actual stdio protocol.

The controls are the point, and each is a way this could pass while being
useless:

  * with no session file, the agent must work on a PRIVATE document. Without
    this, an "attached" result proves nothing: a server that ignored the whole
    mechanism and always spawned its own engine would look identical as long as
    nobody checked whose document it was reading.
  * an edit against a stale revision must be refused. This is the rule that
    stops an agent overwriting what a person did while it was thinking.
  * a window sharing read-only must refuse the edit BY NAME. A refusal that
    arrived as a timeout would be indistinguishable from a hung app.

Run:  cd sidecar && uv run python ../mcp/tests/test_live_session.py
"""

import _bootstrap  # noqa: F401
import _run

import asyncio
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

import websockets

from winjob import kill_tree

HERE = os.path.dirname(os.path.abspath(__file__))
MCP = os.path.dirname(HERE)
ROOT = os.path.dirname(MCP)
SIDECAR = os.path.join(ROOT, "sidecar")

#: A port of its own. The app's 8765 may be in use by a real session on the
#: machine this runs on, and joining THAT would be a test that edits someone's
#: open document.
PORT = 8798

#: Long enough for a cold OCP import on a slow filesystem.
START_TIMEOUT = 120.0


def doc(n, tag=""):
    return {"version": 9, "parameters": {},
            "features": [{"id": f"f{i}", "type": "box", "length": 10 + i,
                          "width": 10, "height": 10, "name": tag}
                         for i in range(n)]}


class Host:
    """What src/live/liveSession.ts does, in the fewest lines that keep its
    rules: publish and collect in one call, apply through the document, raise
    the revision on every change, and remember what was applied."""

    def __init__(self, ws):
        self.ws = ws
        self.rev = 1
        self.doc = doc(1, "from-the-app")
        self.applied = []
        self.can_edit = True
        self._id = 0

    async def call(self, op, **payload):
        self._id += 1
        await self.ws.send(json.dumps({"id": f"h{self._id}", "op": op, **payload}))
        while True:
            msg = json.loads(await asyncio.wait_for(self.ws.recv(), 60))
            if msg.get("status"):
                continue
            return msg

    async def tick(self):
        reply = await self.call(
            "session_host", document=self.doc, revision=self.rev, title="part.funda",
            status={"canEdit": self.can_edit, "applied": self.applied, "building": False})
        res = reply.get("result") or {}
        for p in res.get("proposals") or []:
            if not self.can_edit:
                continue
            self.doc = p["document"]
            self.rev += 1  # what loadDocument -> onDocChange does in the app
            self.applied = (self.applied + [p["id"]])[-16:]
        return res

    async def pump(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            await self.tick()
            await asyncio.sleep(0.05)


class Mcp:
    """mcp/server.py over its real stdio protocol, not its coroutines."""

    def __init__(self, env):
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(MCP, "server.py")], cwd=SIDECAR, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1)
        self._id = 0
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "test", "version": "0"}})

    def rpc(self, method, params=None):
        self._id += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self._id,
                                          "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("the MCP server exited:\n" + self.proc.stderr.read())
            msg = json.loads(line)
            if msg.get("id") == self._id:
                return msg

    def tool(self, name, **args):
        res = self.rpc("tools/call", {"name": name, "arguments": args}).get("result") or {}
        txt = "\n".join(b.get("text", "") for b in (res.get("content") or []))
        return res.get("isError", False), txt

    def close(self):
        for step in (lambda: self.proc.stdin.close(),
                     lambda: self.proc.wait(timeout=20)):
            try:
                step()
            except Exception:
                self.proc.kill()
        kill_tree(self.proc.pid)


class Engine:
    """A real sidecar on a port of its own, and the session file that advertises
    it. The file lives in a temporary directory and the MCP server is pointed at
    it by environment variable, so no test ever writes into the app data
    directory a real session would use."""

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="funda-live-e2e-")
        self.token = secrets.token_urlsafe(24)
        self.session_path = os.path.join(self.tmp, "session.json")

        env = dict(os.environ)
        env["FUNDACAD_SIDECAR_PORT"] = str(PORT)
        env["FUNDACAD_SIDECAR_TOKEN"] = self.token
        for legacy in ("SINDRI_SIDECAR_PORT", "SINDRI_SIDECAR_TOKEN"):
            env.pop(legacy, None)

        self.proc = subprocess.Popen([sys.executable, "server.py"], cwd=SIDECAR, env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True)
        deadline = time.time() + START_TIMEOUT
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line and self.proc.poll() is not None:
                raise RuntimeError("the sidecar exited:\n" + self.proc.stdout.read())
            if line.startswith("LISTENING"):
                break
        else:
            raise RuntimeError(f"the sidecar did not listen within {START_TIMEOUT:.0f}s")

        self.advertise()
        return self

    def advertise(self):
        with open(self.session_path, "w", encoding="utf-8") as fh:
            json.dump({"port": PORT, "token": self.token, "pid": self.proc.pid}, fh)

    def hide(self):
        """Stop advertising, exactly as a closing app does."""
        os.remove(self.session_path)

    def mcp_env(self, mode="auto", advertised=True):
        """The environment an MCP host would give the server.

        No token in it, deliberately. An explicit token takes the override path,
        which would attach without exercising discovery at all — the thing this
        file exists to test."""
        env = dict(os.environ)
        env["FUNDACAD_MCP_MODE"] = mode
        if advertised:
            env["FUNDACAD_SESSION_FILE"] = self.session_path
        else:
            env["FUNDACAD_SESSION_FILE"] = os.path.join(self.tmp, "nothing-here.json")
        for legacy in ("FUNDACAD_SIDECAR_TOKEN", "FUNDACAD_SIDECAR_PORT",
                       "SINDRI_SIDECAR_TOKEN", "SINDRI_SIDECAR_PORT"):
            env.pop(legacy, None)
        return env

    def url(self):
        return f"ws://127.0.0.1:{PORT}?token={self.token}"

    def __exit__(self, *exc):
        # terminate() first so the sidecar's own shutdown runs where it can;
        # kill_tree is the Windows backstop for the worker pool underneath it.
        for step in (self.proc.terminate, lambda: self.proc.wait(timeout=20)):
            try:
                step()
            except Exception:
                self.proc.kill()
        kill_tree(self.proc.pid)
        shutil.rmtree(self.tmp, ignore_errors=True)


def _run_async(coro):
    return asyncio.run(coro)


def test_an_agent_reads_and_edits_the_document_the_app_has_open():
    async def body():
        with Engine() as eng:
            async with websockets.connect(eng.url(), max_size=None,
                                          ping_interval=None) as ws:
                host = Host(ws)
                await host.tick()

                mcp = Mcp(eng.mcp_env())
                try:
                    err, out = mcp.tool("doc_get")
                    assert not err, out
                    assert "from-the-app" in out, f"the agent did not read the app's document: {out[:200]}"

                    # The tool call blocks until the app adopts the edit, and the
                    # app only adopts on its own publish loop — so the loop has
                    # to be running while the call is in flight. That is what the
                    # app does; here it means a thread.
                    loop = asyncio.get_running_loop()
                    fut = loop.run_in_executor(None, lambda: mcp.tool(
                        "feature_add",
                        feature={"id": "hole1", "type": "cylinder", "radius": 3,
                                 "height": 40, "operation": "cut",
                                 "name": "from-the-agent"}))
                    await host.pump(10.0)
                    err, out = await fut

                    assert not err, out
                    assert "applied in FundaCAD" in out, out
                    names = [f.get("name") for f in host.doc["features"]]
                    assert "from-the-agent" in names, f"the edit never reached the app: {names}"
                    assert "from-the-app" in names, f"the edit replaced the app's own work: {names}"
                    assert host.rev == 2, f"the app did not raise the revision: {host.rev}"
                finally:
                    mcp.close()
        print("ok  an agent read the open document and its edit landed in it")

    _run_async(body())


def test_an_edit_against_a_stale_revision_is_refused():
    """Driven at the wire rather than through a tool, because the MCP path
    re-reads before every call and so can never itself be stale — which is the
    design working, and is exactly why the refusal underneath it has to be
    proven separately."""
    async def body():
        with Engine() as eng:
            async with websockets.connect(eng.url(), max_size=None,
                                          ping_interval=None) as ws:
                host = Host(ws)
                await host.tick()
                host.doc = doc(4, "the-user-moved-it")
                host.rev += 1
                await host.tick()

                reply = await host.call("session_propose", document=doc(9, "stale"),
                                        baseRevision=1, name="a slow agent")
                res = reply.get("result") or {}
                assert res.get("ok") is False and res.get("reason") == "stale", res
                assert str(host.rev) in res.get("message", ""), res

                await host.tick()
                names = [f.get("name") for f in host.doc["features"]]
                assert "stale" not in names, f"a stale edit was applied anyway: {names}"

                # The control: the SAME edit against the current revision goes
                # through, or "stale" would just be a word for "no".
                ok = await host.call("session_propose", document=doc(9, "fresh"),
                                     baseRevision=host.rev, name="a slow agent")
                assert (ok.get("result") or {}).get("ok") is True, ok
        print("ok  an edit written against an older revision is refused, a current one is not")

    _run_async(body())


def test_a_read_only_window_refuses_by_name_rather_than_by_timeout():
    async def body():
        with Engine() as eng:
            async with websockets.connect(eng.url(), max_size=None,
                                          ping_interval=None) as ws:
                host = Host(ws)
                host.can_edit = False
                await host.tick()

                mcp = Mcp(eng.mcp_env())
                try:
                    loop = asyncio.get_running_loop()
                    fut = loop.run_in_executor(None, lambda: mcp.tool(
                        "feature_add", feature={"id": "s1", "type": "sphere", "radius": 4}))
                    await host.pump(5.0)
                    err, out = await fut
                    assert err, f"a read-only window accepted an edit: {out}"
                    assert "read-only" in out.lower(), out
                    assert "did not apply" not in out, f"refused as a timeout: {out}"
                    assert len(host.doc["features"]) == 1, host.doc["features"]
                finally:
                    mcp.close()
        print("ok  a read-only window refuses an edit by name, not by timing out")

    _run_async(body())


def test_with_no_app_advertised_the_agent_works_on_its_own_copy():
    """The control for the whole file. Without it, every assertion above could be
    satisfied by a server that ignored discovery entirely."""
    async def body():
        with Engine() as eng:
            async with websockets.connect(eng.url(), max_size=None,
                                          ping_interval=None) as ws:
                host = Host(ws)
                await host.tick()

                mcp = Mcp(eng.mcp_env(advertised=False))
                try:
                    err, out = mcp.tool("doc_get")
                    assert not err, out
                    assert "from-the-app" not in out, f"it found a session it was not told about: {out[:200]}"
                    assert '"features": []' in out.replace("\n", " ") or '"features":[]' in out, out[:200]
                finally:
                    mcp.close()
        print("ok  with nothing advertised, the agent starts its own engine and its own document")

    _run_async(body())


def test_attach_mode_refuses_to_start_rather_than_working_on_a_copy():
    """`attach` exists for a host configured to work on the open document and
    nothing else. Falling back quietly there would look like the edits are being
    ignored, which is the failure that is hardest to diagnose from the outside."""
    async def body():
        with Engine() as eng:
            proc = subprocess.Popen(
                [sys.executable, os.path.join(MCP, "server.py")], cwd=SIDECAR,
                env=eng.mcp_env(mode="attach", advertised=False),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True)
            try:
                _out, err = proc.communicate(timeout=60)
            except subprocess.TimeoutExpired:
                proc.kill()
                raise AssertionError("attach mode neither started nor refused")
            assert proc.returncode != 0, "attach mode started with no app to attach to"
            assert "no FundaCAD window is running" in err, err[-600:]
        print("ok  attach mode refuses to start rather than silently using a copy")

    _run_async(body())


if __name__ == "__main__":
    _run.run(dict(globals()), "live session (end to end)")

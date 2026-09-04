"""The line to the geometry engine, and the engine's own lifetime.

Everything the MCP server can say about a model, it learns by asking the same
sidecar the app asks. That is deliberate: a gap an agent hits here is a gap a
user hits in the viewport, which is the only reason driving the sidecar is
worth more than calling build123d directly from this process.

The sidecar's port and token are fixed by convention (127.0.0.1:8765, the token
the Rust shell mints), so a second client cannot simply join the running app's:
it does not know the token. Both are overridable by environment variable
though, so this spawns its OWN sidecar on its OWN port with its OWN minted
token. Two consequences worth stating:

  * it never competes with the app for the single serialised worker, and
  * it never touches the document the user has open. An agent working through
    this is working on ITS copy, and hands back a file.

One connection, reopened on demand. The sidecar serialises heavy ops anyway, so
there is nothing to gain from more, and a single socket makes cancellation and
shutdown one thing each.
"""

import asyncio
import contextlib
import json
import os
import secrets
import socket
import sys

import websockets

from winjob import ProcessJob, kill_tree

#: How long to wait for the spawned sidecar to print LISTENING. A cold start
#: imports OCP, which is seconds on a warm filesystem and much worse on a cold
#: one; well past either, and a hang here is reported rather than waited on.
START_TIMEOUT = 120.0

#: Ceiling on one request. A rebuild of a heavy document is minutes in the worst
#: case and the sidecar has its own stall supervision underneath this, so this
#: exists only so a lost reply cannot wedge the agent forever.
CALL_TIMEOUT = 600.0


def _free_port():
    """A port nothing is on, right now.

    Inherently a race — something else can take it between this close and the
    sidecar's bind — but the sidecar reports a bind failure by name, so the race
    is loud rather than silent."""
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])
    finally:
        s.close()


def sidecar_dir():
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sidecar")


class SidecarLink:
    """Spawn (or attach to) one sidecar, and speak to it.

    Attaching is the escape hatch for development: with SINDRI_SIDECAR_TOKEN set
    in the environment this talks to whatever is already on SINDRI_SIDECAR_PORT
    instead of starting anything. That is how the probe scripts in this repo
    already work, and it makes a debugging session one env var rather than a
    code change."""

    def __init__(self, python=None, port=None, token=None):
        self.python = python or sys.executable
        self.attached = bool(token)
        self.token = token or secrets.token_urlsafe(32)
        self.port = int(port) if port else (8765 if self.attached else _free_port())
        self.proc = None
        self.ws = None
        self._next_id = 0
        self._lock = asyncio.Lock()
        # Held for the life of this object. On Windows it is what makes the
        # sidecar and its worker pool die with THIS process however this process
        # dies — an MCP host kills its servers outright, and a sidecar that
        # outlives the kill takes its OCCT worker with it. See winjob.py.
        self._job = ProcessJob()

    @classmethod
    def from_env(cls):
        tok = os.environ.get("SINDRI_SIDECAR_TOKEN")
        return cls(python=os.environ.get("FUNDACAD_SIDECAR_PYTHON"),
                   port=os.environ.get("SINDRI_SIDECAR_PORT"),
                   token=tok)

    async def start(self):
        if self.attached or self.proc is not None:
            return
        env = dict(os.environ)
        env["SINDRI_SIDECAR_PORT"] = str(self.port)
        env["SINDRI_SIDECAR_TOKEN"] = self.token
        self.proc = await asyncio.create_subprocess_exec(
            self.python, "server.py", cwd=sidecar_dir(), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        # Adopted BEFORE the readiness wait, so the pool it spawns during
        # start-up is inside the job too. The sidecar's own die-with-parent
        # covers Linux and macOS and says so; on Windows it relies on the app's
        # Rust shell putting it in a job, which is a thing only the app does.
        self._job.adopt(self.proc.pid)
        # Wait for the readiness line rather than polling the port: the sidecar
        # prints LISTENING only once it is actually serving, and a port that is
        # merely bound would let the first request race the accept loop.
        try:
            while True:
                line = await asyncio.wait_for(self.proc.stdout.readline(), START_TIMEOUT)
                if not line:
                    err = (await self.proc.stderr.read()).decode("utf-8", "replace")
                    raise RuntimeError(f"sidecar exited before it was ready:\n{err.strip()}")
                if line.startswith(b"LISTENING"):
                    return
        except asyncio.TimeoutError:
            await self.stop()
            raise RuntimeError(f"sidecar did not start within {START_TIMEOUT:.0f}s")

    async def stop(self):
        if self.ws is not None:
            with contextlib.suppress(Exception):
                await self.ws.close()
            self.ws = None
        if self.proc is not None:
            with contextlib.suppress(ProcessLookupError):
                self.proc.terminate()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.proc.wait(), 10)
            if self.proc.returncode is None:
                with contextlib.suppress(Exception):
                    self.proc.kill()
            # terminate() is TerminateProcess on Windows and runs no cleanup, so
            # the sidecar never reaps its own worker pool. Sweep the tree; the
            # job object above covers the case where this code never runs at all.
            kill_tree(self.proc.pid)
            # Close the transport explicitly. Left open, the proactor loop on
            # Windows finalises it during interpreter shutdown, by which time
            # the pipes are gone, and every run ends in pages of "I/O operation
            # on closed pipe" from __del__ — on STDERR, which for an MCP server
            # is the log the user reads when something is wrong.
            transport = getattr(self.proc, "_transport", None)
            if transport is not None:
                with contextlib.suppress(Exception):
                    transport.close()
            self.proc = None
            await asyncio.sleep(0)  # let the loop actually run the close
        self._job.close()

    async def _connect(self):
        if self.ws is not None:
            return self.ws
        await self.start()
        self.ws = await websockets.connect(
            f"ws://127.0.0.1:{self.port}?token={self.token}", max_size=None,
            ping_interval=None,
        )
        return self.ws

    async def call(self, op, **payload):
        """One request, one reply. Progress frames are dropped: they carry a
        percentage for a progress bar nobody here is drawing.

        Serialised on a lock because the ids are only unique per connection and
        replies are matched positionally by this simple client, not routed by id
        the way the frontend's does. One agent asking one question at a time is
        the whole traffic pattern, so the simpler thing is the right one."""
        async with self._lock:
            self._next_id += 1
            req_id = str(self._next_id)
            for attempt in (0, 1):
                try:
                    ws = await self._connect()
                    await ws.send(json.dumps({"id": req_id, "op": op, **payload}))
                    return await asyncio.wait_for(self._await_reply(ws, req_id), CALL_TIMEOUT)
                except (websockets.ConnectionClosed, ConnectionError):
                    # The worker can be killed out from under a socket (a stall
                    # reap, an OCCT crash). One silent reconnect, then the error
                    # is the caller's to see.
                    self.ws = None
                    if attempt:
                        raise

    async def _await_reply(self, ws, req_id):
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("status"):
                continue  # building/importing progress
            if msg.get("id") not in (req_id, None):
                continue
            return msg

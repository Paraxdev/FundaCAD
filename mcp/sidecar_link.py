"""The line to the geometry engine, and the engine's own lifetime.

Everything the MCP server can say about a model, it learns by asking the same
sidecar the app asks. That is deliberate: a gap an agent hits here is a gap a
user hits in the viewport, which is the only reason driving the sidecar is
worth more than calling build123d directly from this process.

There are two ways to have an engine, and which one is in force decides what an
agent can reach:

  * STANDALONE — spawn one, on a free port, with a token minted here. It never
    competes with a running app for the worker and it cannot see the document
    the user has open. An agent working this way works on its own copy and hands
    back a file.
  * ATTACHED — join the engine a running FundaCAD already has, by reading the
    port and token it publishes (app_session.py). The agent then shares the
    user's engine AND, through the session ops, the document on their screen.

`mode_from_env` picks between them. The default is "attach if an app is open,
otherwise spawn", because the question an agent is usually asked is about the
part in front of the person asking.

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

import app_session
from winjob import ProcessJob, kill_tree

#: The environment-variable names, current first. The sidecar reads the same
#: three spellings through sidecar/appenv.py; this is the small mirror of it that
#: keeps mcp/ from importing across into the sidecar package for four lines.
_PREFIX = "FUNDACAD_"
_LEGACY_PREFIXES = ("SINDRI_", "SINDRICAD_")


def _env(suffix, default=None):
    for prefix in (_PREFIX,) + _LEGACY_PREFIXES:
        val = os.environ.get(prefix + suffix)
        if val is not None:
            return val
    return default


def _apply_env(env, suffix, value):
    env[_PREFIX + suffix] = value
    for prefix in _LEGACY_PREFIXES:
        env.pop(prefix + suffix, None)
    return env

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


#: What to do about a running app, from FUNDACAD_MCP_MODE.
#:
#: "auto"       attach to a running FundaCAD if there is one, else spawn.
#: "attach"     attach, or refuse to start. For a host configured to work on the
#:              open document and nothing else, where quietly falling back to a
#:              private copy would look like the edits are being ignored.
#: "standalone" never attach, even with an app open. The old behaviour, kept
#:              because "do not touch what I have open" is a real requirement.
MODES = ("auto", "attach", "standalone")
DEFAULT_MODE = "auto"


def mode_from_env(env=None):
    """The configured mode, and it is deliberately forgiving about spelling.

    An unrecognised value falls back to the default rather than refusing to
    start: this is read at startup inside an MCP host, where a raised exception
    reaches the user as "the server exited" with the reason in a log they may
    never open. The value is echoed on stderr, which is the log they DO see.
    """
    env = os.environ if env is None else env
    raw = (env.get("FUNDACAD_MCP_MODE") or "").strip().lower()
    return raw if raw in MODES else DEFAULT_MODE


class SidecarLink:
    """Spawn (or attach to) one sidecar, and speak to it.

    Constructed with a token, it ATTACHES: it dials that port and starts
    nothing. `for_mode` is how the server chooses; the environment variables are
    the escape hatch that came first and still works, and is how the probe
    scripts in this repository drive a session they can see."""

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
        """A link configured by environment variables alone: the explicit
        override. Knows nothing about a running app — see `for_mode`."""
        tok = _env("SIDECAR_TOKEN")
        return cls(python=os.environ.get("FUNDACAD_SIDECAR_PYTHON"),
                   port=_env("SIDECAR_PORT"),
                   token=tok)

    @classmethod
    async def for_mode(cls, mode=None, log=None):
        """The link this mode asks for, and what it found.

        Returns `(link, app)` where `app` is the running app's `{port, token,
        pid}` when attached and None when not, so the caller can say which of the
        two worlds it is in without inferring it from `link.attached` — that flag
        is also set by the environment override, which is a different thing.

        An explicit token in the environment wins over everything here. Someone
        who set it is pointing this at a specific engine on purpose, and a
        discovery step that overrode them would make a debugging session
        unexplainable.
        """
        mode = mode or mode_from_env()
        say = log or (lambda *_a: None)

        if _env("SIDECAR_TOKEN"):
            say("[mcp] attaching to the engine named in the environment")
            return cls.from_env(), None

        if mode != "standalone":
            app = await app_session.find_running_app()
            if app is not None:
                say(f"[mcp] FundaCAD is open (pid {app.get('pid')}) — "
                    f"attaching to its engine on port {app['port']}")
                return cls(port=app["port"], token=app["token"]), app
            if mode == "attach":
                # Loud, and by request: this mode exists for a host that is meant
                # to work on the open document, where silently working on a
                # private copy would look like the edits are being ignored.
                raise RuntimeError(
                    "FUNDACAD_MCP_MODE=attach, but no FundaCAD window is running "
                    "(no live session file, or the engine it names is gone). "
                    "Open FundaCAD, or use FUNDACAD_MCP_MODE=auto to work on a "
                    "private copy when it is closed."
                )
            say("[mcp] no FundaCAD window is open — starting a private engine")
        else:
            say("[mcp] standalone by configuration — starting a private engine")
        return cls(), None

    async def start(self):
        if self.attached or self.proc is not None:
            return
        env = dict(os.environ)
        # Written under the current names only, and the retired spellings cleared
        # with them: a child handed two names that disagree would pick whichever
        # its own lookup order preferred, which is not a thing to leave to chance
        # when one of them is the auth token.
        _apply_env(env, "SIDECAR_PORT", str(self.port))
        _apply_env(env, "SIDECAR_TOKEN", self.token)
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

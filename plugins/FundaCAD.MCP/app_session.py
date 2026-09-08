"""Is FundaCAD open, and how do I reach it?

The app drops a small file naming its engine's port and token while it runs (see
src-tauri/src/session_file.rs). This reads it, and then does the only thing that
actually settles the question: dials that port and presents that token.

The file is a HINT and nothing more. It is removed on a clean exit and not on a
kill, so a stale one is ordinary — after a crash, after a power cut, after a
`taskkill`. Trusting it would make "the app is open" mean "the app was open once
on this machine", which is exactly the wrong answer to give an agent about to
edit a document. Dialling costs one connect on loopback.

Nothing here writes. Deciding what to do with the answer belongs to the caller.
"""

import asyncio
import json
import os
import sys

#: The bundle identifier from src-tauri/tauri.conf.json. The app data directory
#: is derived from it by Tauri, and re-derived here — the two must agree, so if
#: the identifier ever changes, this constant changes with it and the test below
#: is what says so.
APP_IDENTIFIER = "dev.fundacad.app"

#: Written by session_file.rs. Named there too; change one, change both.
SESSION_FILE = "session.json"

#: How long to wait for the app's engine to answer. Loopback and already
#: listening, so this is a "the file is stale" timeout, not a slow-network one.
PROBE_TIMEOUT = 4.0

#: Point the discovery at a different file. For a test or a probe that wants a
#: session of its own: the alternative is writing into the real app data
#: directory, where a file left behind by a failed run is exactly the stale hint
#: this module is built to survive — but it would survive it by making every
#: later probe pay a connect timeout for nothing.
SESSION_FILE_ENV = "FUNDACAD_SESSION_FILE"


def app_data_dir(identifier=APP_IDENTIFIER):
    """The directory Tauri's `app_data_dir()` resolves to, without Tauri.

    Tauri joins the bundle identifier onto the platform data directory. Each
    branch below is that platform's data directory; getting one wrong means
    never finding a running app on that platform, silently, which is why the
    reasoning is written down rather than left to a library.
    """
    if sys.platform == "win32":
        # FOLDERID_RoamingAppData. Tauri uses the roaming one, not Local.
        base = os.environ.get("APPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Roaming")
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(
            os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, identifier)


def read_session_file(path=None):
    """`{"port": int, "token": str, "pid": int}`, or None.

    Every failure is None and none of them are exceptional: no file (no app has
    run), unreadable (someone else's), unparseable (a half-written file we lost
    the rename race with, or an older format). The caller's next move is the same
    for all of them, and an exception here would make "FundaCAD is not open" look
    like a bug in the tool that asked.
    """
    path = path or os.environ.get(SESSION_FILE_ENV) or os.path.join(
        app_data_dir(), SESSION_FILE)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    port, token = data.get("port"), data.get("token")
    if not isinstance(port, int) or not (0 < port < 65536):
        return None
    if not isinstance(token, str) or not token:
        return None
    return {"port": port, "token": token, "pid": data.get("pid")}


async def probe(info, timeout=PROBE_TIMEOUT):
    """Does something answer on that port, with that token, and is it ours?

    `ping` rather than a bare connect: the token is checked during the handshake
    (an unauthorised connection is closed with 1008), but a successful connect
    only proves SOMETHING accepted it. One round trip proves the thing on the
    other end speaks this protocol, which is what the caller is about to rely on.
    """
    import websockets

    url = f"ws://127.0.0.1:{info['port']}?token={info['token']}"
    try:
        async with asyncio.timeout(timeout):
            async with websockets.connect(url, max_size=None, ping_interval=None) as ws:
                await ws.send(json.dumps({"id": "probe", "op": "ping"}))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("status"):
                        continue
                    return bool((msg.get("result") or {}).get("pong"))
    except Exception:
        # Refused, timed out, closed on the handshake (a stale token), or
        # answered something else. All of them mean the same thing to the caller.
        return False


async def find_running_app(path=None, timeout=PROBE_TIMEOUT):
    """The running app's `{port, token, pid}`, or None.

    The two steps are separate above and joined here because the file alone is
    never enough to act on and the probe alone has nowhere to dial.
    """
    info = read_session_file(path)
    if info is None:
        return None
    return info if await probe(info, timeout) else None


def find_running_app_sync(path=None, timeout=PROBE_TIMEOUT):
    """For a caller with no event loop of its own (a script, a test).

    `asyncio.run` refuses to nest, so a caller that already has a loop gets that
    refusal rather than a deadlock — which is the right way round, since the
    async form is right there."""
    return asyncio.run(find_running_app(path, timeout))

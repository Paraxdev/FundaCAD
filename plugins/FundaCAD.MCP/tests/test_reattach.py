"""Does the server notice FundaCAD opening after it started?

`attach` asks "is the app open?" exactly once, at start-up, and start-up is not
a moment the user controls: an MCP host launches its servers when the HOST
launches, not when a conversation begins. So the question was asked before the
person had any reason to have opened the app, and answering no meant a private
engine for the rest of the host's session. Opening the app afterwards changed
nothing, which reads as the connector refusing to use the app that is right
there in front of them.

So the question gets asked again. Every test here is one of the ways that could
go wrong, and the controls matter more than the happy path: re-probing is a
behaviour that REPLACES the document in hand, so the cases where it must not
happen are the ones that make it safe to have at all.

Nothing here starts an engine or an app. The probe, the link and the live
session are all stubbed, because what is under test is the DECISION, and a test
that needed a running app could not check the case where there isn't one.

Run: uv run python plugins/FundaCAD.MCP/tests/test_reattach.py
"""

import _bootstrap  # noqa: F401
import _run

import asyncio

import app_session
import server as S
from live_link import NoAppOpen


class FakeLink:
    """Stands in for both an attached and a spawned SidecarLink."""

    def __init__(self, port=None, token=None):
        self.port = port
        self.token = token
        self.stopped = False

    async def stop(self):
        self.stopped = True


class FakeLive:
    """A live session whose `pull` is whatever the test wants it to be."""

    doc = {"features": [{"id": "f1", "type": "sketch"}], "parameters": {}}
    raises = None

    def __init__(self, link, name="an assistant"):
        self.link = link
        self.title = "the user's part"

    async def pull(self):
        if FakeLive.raises is not None:
            raise FakeLive.raises
        return dict(FakeLive.doc)


class patched:
    """Swap the module-level names `_adopt_running_app` reaches for, and put
    them back. `app` is the session the probe will claim to find, or None."""

    def __init__(self, app, mode="auto"):
        self.app = app
        self.mode = mode

    def __enter__(self):
        self.saved = (app_session.find_running_app, S.SidecarLink, S.LiveLink,
                      S.mode_from_env)
        self.probes = []

        async def find(*a, **k):
            self.probes.append(1)
            return self.app

        app_session.find_running_app = find
        S.SidecarLink = FakeLink
        S.LiveLink = FakeLive
        S.mode_from_env = lambda *a, **k: self.mode
        return self

    def __exit__(self, *exc):
        (app_session.find_running_app, S.SidecarLink, S.LiveLink,
         S.mode_from_env) = self.saved
        FakeLive.raises = None


APP = {"port": 9931, "token": "t0k", "pid": 4242}


def fresh():
    """A server as it is a moment after start-up with no app open: private, and
    nothing built in it yet."""
    srv = S.Server.__new__(S.Server)
    srv.doc = {"features": [], "parameters": {}}
    srv.link = FakeLink()
    srv.live = None
    srv.private_edits = False
    srv._probed_at = 0.0
    srv.mesh = []
    srv.built_for = None
    return srv


def test_the_app_opening_later_is_noticed():
    srv = fresh()
    with patched(APP):
        asyncio.run(srv._adopt_running_app())
    assert srv.live is not None, "still private after the app appeared"
    assert srv.doc["features"][0]["id"] == "f1", srv.doc
    assert srv.link.port == 9931, srv.link.port


def test_the_private_engine_is_let_go_of():
    # It holds an OCCT worker pool nothing will ask for again, and this process
    # is the only thing keeping it alive.
    srv = fresh()
    private = srv.link
    with patched(APP):
        asyncio.run(srv._adopt_running_app())
    assert private.stopped, "the private engine was left running"


def test_nothing_happens_when_no_app_is_open():
    # The control for everything above: the ordinary case is that the probe
    # finds nothing, and it must cost the caller nothing but a look.
    srv = fresh()
    with patched(None):
        asyncio.run(srv._adopt_running_app())
    assert srv.live is None
    assert srv.doc["features"] == []


def test_work_already_done_here_is_not_thrown_away():
    # THE control. Adopting replaces the document, so a server that has built
    # something privately must stay where it is: a user who opens the app to
    # look at something else has not asked for the agent's work to be discarded.
    srv = fresh()
    srv.private_edits = True
    with patched(APP) as p:
        asyncio.run(srv._adopt_running_app())
    assert srv.live is None, "adopted over work already done"
    assert not p.probes, "probed at all, when the answer could not be acted on"


def test_standalone_is_left_alone():
    # Configured to stay private on purpose. Going looking would make the
    # setting mean nothing.
    srv = fresh()
    with patched(APP, mode="standalone") as p:
        asyncio.run(srv._adopt_running_app())
    assert srv.live is None
    assert not p.probes


def test_a_window_that_is_not_sharing_leaves_a_working_session():
    # The engine is the app's but live editing is off in its settings. Half a
    # switch is worse than none: the server must not end up with a live session
    # it cannot pull from, nor with its private engine already stopped.
    srv = fresh()
    private = srv.link
    FakeLive.raises = NoAppOpen("no window is sharing a document")
    with patched(APP):
        asyncio.run(srv._adopt_running_app())
    assert srv.live is None, "kept a live session that cannot be read"
    assert srv.link is private, "swapped the link anyway"
    assert not private.stopped, "stopped the engine it fell back to"


def test_a_closed_app_is_not_re_probed_on_every_call():
    # A probe is a file read when there is no session file, and a connect that
    # waits out its timeout when there is a STALE one. The second is the case
    # this bounds: without it, every tool call in a session pays that timeout.
    srv = fresh()
    with patched(None) as p:
        for _ in range(20):
            asyncio.run(srv._adopt_running_app())
        assert len(p.probes) == 1, p.probes
        srv._probed_at -= S.Server.REPROBE_SECONDS + 1  # time passes
        asyncio.run(srv._adopt_running_app())
        assert len(p.probes) == 2, p.probes


def test_an_attached_server_stops_asking():
    srv = fresh()
    srv.live = FakeLive(FakeLink())
    with patched(APP) as p:
        asyncio.run(srv._adopt_running_app())
    assert not p.probes, "kept probing after it was already attached"


if __name__ == "__main__":
    _run.run(globals(), "re-attach")

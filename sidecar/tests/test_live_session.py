"""The rules that let an agent edit the document a person has open.

The dangerous shape here is not a crash, it is a silent divergence: two writers
and a document that ends up neither one's. So the asymmetry — one host who owns
the document, guests who can only propose — is the thing under test, and each
rule has a control that must fail if the rule were dropped.

The clock is injected, so the lease tests are exact rather than a sleep.

Run:  uv run python tests/test_live_session.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

import live_session
from live_session import LiveSession

PASS = "  ok"

APP = "app"
AGENT = "agent"
OTHER = "other"


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _session():
    c = Clock()
    return LiveSession(clock=c), c


def _doc(n):
    return {"parameters": {}, "features": [{"id": f"f{i}", "type": "box"} for i in range(n)]}


def test_nothing_is_shared_until_an_app_shares_it():
    """The default, and it has to be the safe one: an agent that finds no host
    must be told so, not handed the last document some other window had."""
    s, _ = _session()
    st = s.state(AGENT)
    assert st["attached"] is False, st
    assert st["document"] is None, "a document was readable with no app hosting it"
    r = s.propose(AGENT, _doc(1), 0)
    assert r["ok"] is False and r["reason"] == "no-host", r
    print(PASS, "with no host there is nothing to read and nothing to edit")


def test_a_guest_reads_exactly_what_the_app_published():
    s, _ = _session()
    s.publish(APP, _doc(3), 7, title="spool.funda", status={"errors": []})
    st = s.state(AGENT)
    assert st["attached"] is True
    assert st["revision"] == 7 and st["title"] == "spool.funda"
    assert len(st["document"]["features"]) == 3
    print(PASS, "a guest sees the host's document, revision and title")


def test_a_guest_cannot_install_a_document_only_offer_one():
    """The rule the whole module exists for. A proposal must not change what the
    next reader sees — only the host's own publish may do that."""
    s, _ = _session()
    s.publish(APP, _doc(3), 7)
    r = s.propose(AGENT, _doc(99), 7, note="add a hole")
    assert r["ok"] is True and r["proposal"], r

    st = s.state(OTHER)
    assert len(st["document"]["features"]) == 3, "a proposal reached the shared document"
    assert st["revision"] == 7, "a guest moved the revision"
    print(PASS, "a proposal is offered, not installed")


def test_the_host_collects_proposals_when_it_publishes():
    """Publish and collect are one call because they are one loop on the app's
    side. The proposal has to arrive exactly once, or the app would apply the
    same edit twice and the user would get two holes for one request."""
    s, _ = _session()
    s.publish(APP, _doc(3), 7)
    s.propose(AGENT, _doc(4), 7, note="add a hole")

    got = s.publish(APP, _doc(3), 7)
    assert len(got["proposals"]) == 1, got
    p = got["proposals"][0]
    assert p["note"] == "add a hole" and len(p["document"]["features"]) == 4

    again = s.publish(APP, _doc(4), 8)
    assert again["proposals"] == [], "a collected proposal came back a second time"
    print(PASS, "the host collects each proposal exactly once")


def test_an_edit_written_against_an_older_document_is_refused():
    """Staleness, and it is the difference between a tool and a hazard. An agent
    that read a part with eight holes and asked for one of them to be widened
    must not have that applied to a part someone has since changed underneath
    it — the selector it wrote may now address a different face."""
    s, _ = _session()
    s.publish(APP, _doc(3), 7)
    s.publish(APP, _doc(5), 8)  # the user did something

    r = s.propose(AGENT, _doc(4), 7)
    assert r["ok"] is False and r["reason"] == "stale", r
    assert r["revision"] == 8, "the refusal must say what to re-read"
    assert "8" in r["message"]

    # ...and the control: current is accepted, or "stale" would just mean "no".
    assert s.propose(AGENT, _doc(4), 8)["ok"] is True
    print(PASS, "an edit against an older revision is refused, a current one is not")


def test_a_backlog_is_refused_rather_than_grown():
    """An app that has stopped collecting is an app that is gone or wedged.
    Queueing forever would hold every one of those documents in memory and
    report success to an agent whose work is going nowhere."""
    s, _ = _session()
    s.publish(APP, _doc(1), 1)
    for i in range(live_session.MAX_PENDING):
        assert s.propose(AGENT, _doc(2), 1)["ok"] is True, f"refused at {i}"
    r = s.propose(AGENT, _doc(2), 1)
    assert r["ok"] is False and r["reason"] == "backlog", r
    print(PASS, f"the queue stops at {live_session.MAX_PENDING} and says why")


def test_a_guest_stops_counting_as_present_once_its_lease_runs_out():
    s, c = _session()
    s.publish(APP, _doc(1), 1)
    s.state(AGENT, name="an assistant")
    assert s.guest_names() == ["an assistant"]

    c.t += live_session.GUEST_TTL - 1
    assert s.guest_names() == ["an assistant"], "a working guest was dropped"

    c.t += 2
    assert s.guest_names() == [], "an absent guest is still counted"
    print(PASS, "a guest's lease is refreshed by working and expires by not")


def test_an_expired_guest_takes_its_unread_proposals_with_it():
    """Otherwise an agent that died mid-thought would have its half-finished edit
    applied to the user's document minutes later, by an app that had no way to
    know the asker was gone."""
    s, c = _session()
    s.publish(APP, _doc(1), 1)
    s.propose(AGENT, _doc(2), 1, name="an assistant")
    c.t += live_session.GUEST_TTL + 1

    got = s.publish(APP, _doc(1), 1)
    assert got["proposals"] == [], "a dead guest's edit was still delivered"
    print(PASS, "an expired guest's pending edits go with it")


def test_leaving_withdraws_what_was_not_yet_applied():
    s, _ = _session()
    s.publish(APP, _doc(1), 1)
    s.propose(AGENT, _doc(2), 1)
    s.propose(OTHER, _doc(3), 1)
    s.leave(AGENT)

    got = s.publish(APP, _doc(1), 1)
    assert len(got["proposals"]) == 1, got
    assert got["proposals"][0]["guest"] == OTHER, "the wrong guest's edit was withdrawn"
    print(PASS, "leaving withdraws only that guest's pending edits")


def test_a_new_host_takes_over_and_the_old_traffic_is_dropped():
    """A second window, or the same one after a reconnect. Refusing would pin the
    session to a socket that is gone with no way back but restarting the engine;
    carrying the proposals over would apply an edit written against a document
    the new host may never have had."""
    s, _ = _session()
    s.publish(APP, _doc(3), 7)
    s.propose(AGENT, _doc(4), 7)

    got = s.publish("app2", _doc(9), 1)
    assert got["proposals"] == [], "an edit for the old host reached the new one"
    assert s.state()["revision"] == 1
    print(PASS, "a new host takes over and inherits no pending edits")


def test_only_the_host_can_end_the_session():
    """A guest calling release would be a guest closing the user's session, which
    is a thing no guest may do."""
    s, _ = _session()
    s.publish(APP, _doc(3), 7)
    r = s.release(AGENT)
    assert r["ok"] is False, r
    assert s.state()["attached"] is True, "a guest ended the host's session"

    assert s.release(APP)["ok"] is True
    st = s.state()
    assert st["attached"] is False and st["document"] is None, st
    print(PASS, "only the host ends the session, and it takes the document with it")


def test_a_note_from_a_guest_cannot_be_unbounded():
    """It is shown to the user, so it is untrusted text the UI has to survive."""
    s, _ = _session()
    s.publish(APP, _doc(1), 1)
    s.propose(AGENT, _doc(2), 1, note="x" * 10_000)
    note = s.publish(APP, _doc(1), 1)["proposals"][0]["note"]
    assert len(note) == live_session.MAX_NOTE, len(note)
    print(PASS, f"a guest's note is capped at {live_session.MAX_NOTE} characters")


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            print(f"FAIL {name}")
            failed += 1
    print("live session:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

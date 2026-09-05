"""One document, an app and an agent both working on it.

Until now an outside program could drive the geometry engine but never the
document: the engine is stateless, every rebuild carries the whole document with
it, and the document itself lives in the frontend. So `mcp/` started an engine of
its own and worked on a copy, and handing the work back meant saving a file and
opening it. That is safe, and it is the wrong shape for the thing an agent is
most often asked to do, which is change the part on the screen.

This is the meeting point. It holds ONE document and the rule for who may
replace it:

  * exactly one HOST — the running app. It owns the document. It publishes what
    it has, and it is the only thing that may raise the revision.
  * any number of GUESTS — an MCP server, a probe script. A guest reads the
    document and PROPOSES a replacement. It cannot install one.

That asymmetry is the whole design. A guest that could write directly would be
editing a document the app has in memory and is about to overwrite, and the two
would diverge with nothing to say which was right. Proposing instead means the
app applies the change through its own document store, so it is one undo step,
it goes through the same validation as a human edit, and the user watches it
happen.

Nothing here is async and nothing here touches a socket. It is a state machine
with the clock injected, so every rule below can be asserted without a server, a
websocket or a sleep — see tests/test_live_session.py.

STALENESS. A proposal names the revision it was written against. If the document
has moved on, the proposal is refused rather than applied: an agent that read a
part with eight holes and asks for one of them to be 3mm wider must not have
that applied to a part someone has since rebuilt. The guest re-reads and decides
again, which is the same thing a person does.
"""

import time

#: How long a guest is counted as present after its last call. It is refreshed by
#: every read and every proposal, so an agent that is working keeps its lease
#: without doing anything special. Long enough to span a slow tool call, short
#: enough that the app stops polling quickly once nobody is there.
GUEST_TTL = 45.0

#: Proposals waiting for the host to collect them. Small on purpose: the host
#: collects on every publish, so a queue this deep means the app is not running
#: its side at all, and holding thousands of documents in memory would be the
#: only visible symptom.
MAX_PENDING = 8

#: Cap on a note a guest attaches to a proposal. It is shown to the user, so it
#: is untrusted text with a length the UI has to survive.
MAX_NOTE = 400


class LiveSession:
    """The shared state. One instance per server process."""

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self.reset()

    def reset(self):
        self.host_id = None
        self.document = None
        self.revision = 0
        self.title = None
        self.status = {}
        self._host_seen = 0.0
        self._guests = {}      # id -> (name, last_seen)
        self._pending = []     # proposals the host has not collected
        self._next_proposal = 0

    # --- the host ----------------------------------------------------------

    def publish(self, host_id, document, revision, title=None, status=None):
        """The app says what it has, and collects whatever guests have asked for.

        Publish and collect are ONE call because they are one loop on the app's
        side, and splitting them would double the traffic of the idle case — an
        app with live mode on and nobody attached, which is the common case — for
        no gain in either.

        A second app taking the host role is allowed and is the right answer: the
        previous one has either exited or lost its socket, and refusing would
        leave the session pinned to a window that is gone with no way to recover
        but restarting the engine. The proposals in flight are dropped with it,
        since they were written against a document the new host may not have.
        """
        if self.host_id != host_id:
            self.host_id = host_id
            self._pending = []
        self.document = document
        self.revision = int(revision)
        self.title = title
        self.status = status or {}
        self._host_seen = self._clock()
        # Expire first, THEN take. The other order collects a dead guest's
        # proposal on its way out and hands the user an edit from an agent that
        # is no longer there to be asked about it.
        guests = self.guest_names()
        taken, self._pending = self._pending, []
        return {
            "ok": True,
            "guests": guests,
            "proposals": taken,
        }

    def release(self, host_id):
        """The app is closing, or the user turned live mode off. Everything goes:
        a document with no host is not a document anyone may act on, and leaving
        the last one readable would let an agent measure a part nobody has open.
        """
        if self.host_id != host_id:
            return {"ok": False, "reason": "not the host"}
        self.reset()
        return {"ok": True}

    # --- guests ------------------------------------------------------------

    def state(self, guest_id=None, name=None):
        """What a guest sees. Also its heartbeat, which is why the guest id is an
        argument to a read: an agent that is only looking is still present, and
        the app wants to know that so it can say so."""
        if guest_id is not None:
            self._touch(guest_id, name)
        return {
            "attached": self.host_id is not None,
            "revision": self.revision,
            "title": self.title,
            "status": self.status,
            "document": self.document,
            "guests": self.guest_names(),
        }

    def propose(self, guest_id, document, base_revision, note=None, name=None):
        """A guest asks for the document to be replaced.

        Returns the proposal id to watch for, or a refusal that says which of the
        three things went wrong — no app, a stale base, or a queue nobody is
        draining. Three distinguishable answers rather than one `False`, because
        the guest's next move differs for each: give up, re-read, or wait.
        """
        self._touch(guest_id, name)
        if self.host_id is None:
            return {"ok": False, "reason": "no-host",
                    "message": "no FundaCAD window is sharing a document"}
        if int(base_revision) != self.revision:
            return {"ok": False, "reason": "stale", "revision": self.revision,
                    "message": ("the document moved on while that edit was being "
                                f"written (revision {base_revision} -> {self.revision}); "
                                "read it again and re-apply")}
        if len(self._pending) >= MAX_PENDING:
            return {"ok": False, "reason": "backlog",
                    "message": "the app has not collected the last edits yet"}
        self._next_proposal += 1
        pid = f"p{self._next_proposal}"
        self._pending.append({
            "id": pid,
            "guest": guest_id,
            "name": name or guest_id,
            "note": (str(note)[:MAX_NOTE] if note else None),
            "baseRevision": int(base_revision),
            "document": document,
            "at": self._clock(),
        })
        return {"ok": True, "proposal": pid, "revision": self.revision}

    def leave(self, guest_id):
        self._guests.pop(guest_id, None)
        self._pending = [p for p in self._pending if p["guest"] != guest_id]
        return {"ok": True}

    # --- shared ------------------------------------------------------------

    def guest_names(self):
        """Who is attached, right now. Expiry happens HERE rather than on a timer
        because there is no timer in a state machine, and a lease that is only
        checked when someone asks is a lease that can never be wrong at the
        moment it is read."""
        now = self._clock()
        for gid in [g for g, (_n, seen) in self._guests.items() if now - seen > GUEST_TTL]:
            self._guests.pop(gid, None)
            self._pending = [p for p in self._pending if p["guest"] != gid]
        return sorted(name for name, _seen in self._guests.values())

    def _touch(self, guest_id, name=None):
        prev = self._guests.get(guest_id)
        self._guests[guest_id] = (name or (prev[0] if prev else guest_id), self._clock())

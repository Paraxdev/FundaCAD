"""The agent's side of a live session: read the open document, offer an edit.

`live_session.py` in the sidecar holds the rules. This is the half that lives
with the agent, and it exists to make one awkward thing invisible to the tools:
a guest may not write the document, only propose a replacement that the app
applies. Every mutating tool would otherwise have to know that.

So the shape is a mirror. Before a tool runs, `pull` replaces the local document
with the app's and remembers the revision it came from. After a tool that
changed it, `push` offers the result against that revision and waits for the app
to adopt it. Between those two the tools carry on doing exactly what they did
when the document was private, which is why none of them mention any of this.

WAITING IS THE POINT. `push` does not return until the app has adopted the edit
or refused it. An agent that fired and forgot would report "added the hole" and
then read a document without one on its next call, and would have no way to tell
that from the app having rejected it — the two look identical from here.

STALENESS IS NOT AN ERROR, it is a race that has a correct answer. The user moved
the model while the agent was writing; the answer is to read again and re-apply,
and `push` does exactly that, once. Once and not forever: a second failure means
something is changing faster than an agent can work, and looping would hold the
tool open indefinitely while quietly clobbering whatever the person is doing.
"""

import asyncio
import time

#: How long to wait for the app to adopt a proposal. The app collects on its own
#: publish loop, so this is measured in polls, not in build time — it does not
#: cover the rebuild the app does afterwards, which the agent sees as the next
#: `build` being quick because the answer is already cached.
ADOPT_TIMEOUT = 30.0

#: How often to ask. Loopback and a dict lookup on the other end; the cost is the
#: message, not the work.
POLL_INTERVAL = 0.15


class NoAppOpen(RuntimeError):
    """There is no window sharing a document. Distinct from a transport failure:
    the caller's answer to a user is different, and so is what it should do
    next."""


class LiveLink:
    """One agent's view of the document a running app has open."""

    def __init__(self, link, name="an assistant"):
        self.link = link
        #: Shown to the user in the app, beside the indicator that says someone
        #: is attached. It is why it is a readable phrase and not a uuid.
        self.name = name
        #: The revision the local document was pulled from. `None` means nothing
        #: has been pulled yet, which is not the same as revision 0.
        self.base = None
        self.title = None
        self.status = {}

    async def state(self):
        reply = await self.link.call("session_state", name=self.name)
        return (reply.get("result") or {}) if reply.get("ok") else {}

    async def pull(self):
        """The app's document, and the revision it is at.

        Raises rather than returning None when no app is hosting: every caller
        would otherwise have to write the same three lines, and forgetting them
        would mean an agent editing `None`.
        """
        st = await self.state()
        if not st.get("attached"):
            raise NoAppOpen(
                "no FundaCAD window is sharing a document — open one, or turn on "
                "live editing in its settings"
            )
        self.base = st.get("revision", 0)
        self.title = st.get("title")
        self.status = st.get("status") or {}
        return st.get("document")

    async def push(self, document, note=None, on_stale=None):
        """Offer `document` and wait for the app to take it.

        `on_stale` is called with the app's current document when the base has
        moved, and must return the document to try again with — that is the
        caller's chance to re-apply its edit to what is actually there rather
        than to what it read a moment ago. Without one, a stale push is reported
        as a refusal instead of being retried, which is the honest thing to do
        when nobody has said how to redo the work.

        Returns the revision the app landed on.
        """
        if self.base is None:
            await self.pull()
        if self.status.get("canEdit") is False:
            # The window is sharing read-only. Said here rather than discovered
            # by offering an edit and waiting out the adoption timeout, because
            # the two look identical from this side and only one of them has an
            # answer the user can act on.
            raise ReadOnlySession(
                "that FundaCAD window is sharing its document read-only — set "
                "live editing to \"Read and edit\" in its preferences to let an "
                "assistant change it"
            )

        for attempt in (0, 1):
            reply = await self.link.call(
                "session_propose", document=document, baseRevision=self.base,
                note=note, name=self.name)
            res = (reply.get("result") or {}) if reply.get("ok") else {}
            if not reply.get("ok"):
                raise RuntimeError((reply.get("error") or {}).get("message") or
                                   "the engine refused the edit")
            if res.get("ok"):
                return await self._await_adoption(res["proposal"])

            reason = res.get("reason")
            if reason == "no-host":
                raise NoAppOpen(res.get("message") or "no FundaCAD window is open")
            if reason == "stale" and on_stale is not None and attempt == 0:
                current = await self.pull()
                document = on_stale(current)
                continue
            if reason == "stale":
                # Its own type, because the caller's answer to it is different
                # from every other refusal: re-read and decide again, rather than
                # report a failure. Reached when there was no `on_stale` to do
                # that automatically, or when doing it once was not enough.
                raise StaleEdit(res.get("message") or "the document moved on")
            raise RuntimeError(res.get("message") or f"the edit was refused ({reason})")

        # Unreachable while the loop above either returns or raises; kept so a
        # future third branch cannot fall out of the bottom returning None.
        raise RuntimeError("the edit was refused twice")

    async def _await_adoption(self, proposal_id):
        """Block until the app has actually taken THIS edit.

        The app publishes the ids of the proposals it applied, and that is the
        acknowledgement. Neither of the two things that look like one will do:

          * "the revision moved" is not it — the revision moves for the user's
            own edits too, so a person nudging a face while this waits would read
            as this edit landing.
          * "the published document equals what I offered" is not it either. The
            app migrates and normalises a document on the way in and adds
            `version`, `suppressed` and the visibility overlays on the way back
            out, so the two are never byte-identical even when the edit was taken
            exactly as written. That comparison reported every edit as a lost
            race, which is how this ended up being an id.
        """
        deadline = time.monotonic() + ADOPT_TIMEOUT
        while time.monotonic() < deadline:
            await asyncio.sleep(POLL_INTERVAL)
            st = await self.state()
            if not st.get("attached"):
                raise NoAppOpen("the FundaCAD window closed before the edit was applied")
            status = st.get("status") or {}
            if proposal_id in (status.get("applied") or []):
                self.base = st.get("revision", 0)
                self.title = st.get("title")
                self.status = status
                return self.base
        raise TimeoutError(
            f"the FundaCAD window did not apply the edit within {ADOPT_TIMEOUT:.0f}s — "
            "it may be busy, or live editing may be turned off in its settings"
        )

    async def leave(self):
        """Give up the lease so the app stops showing an assistant attached."""
        try:
            await self.link.call("session_leave")
        except Exception:
            # On the way out. A lease left behind expires on its own.
            pass


class StaleEdit(RuntimeError):
    """The document moved while the edit was in flight."""


class ReadOnlySession(RuntimeError):
    """The window is sharing, but not accepting edits."""

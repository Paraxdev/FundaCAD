"""A rejected connection has to give its slot back.

Every connection is counted per source IP and refused past MAX_CONNS_PER_IP.
The counter was incremented before the auth check and decremented in the
handler's `finally`, but `finally` began by cancelling the pending-task set,
and that set was only bound AFTER the auth check. So an unauthorized connection
closed the socket, returned, and raised UnboundLocalError out of its own
cleanup, which skipped the decrement below it.

The result was a sidecar that quietly bricked itself. Eight bad handshakes from
one address, a dev server started before its token was known, a page reloaded a
few times with a stale token, a client retrying, and from then on EVERY
connection from that address was refused with "too many connections", including
correct ones, for the life of the process. On the other end it looked like a
viewport that simply never built anything, with the sidecar still listening and
still logging happily.

So the property is: reject however many connections you like, and a good one
still gets in afterwards.

Run:  uv run python test_conn_limit.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import asyncio
import json
import sys
import traceback

import websockets

import server
from server import handle, HOST, PORT, MAX_CONNS_PER_IP

server._TOKEN = "conn-limit-token"
GOOD = f"ws://{HOST}:{PORT}?token=conn-limit-token"
BAD = f"ws://{HOST}:{PORT}?token=wrong"


async def _serve():
    return await websockets.serve(handle, HOST, PORT)


async def _rejected(url):
    """Connect and expect to be closed. Returns the close code."""
    try:
        async with websockets.connect(url) as ws:
            await ws.recv()  # server closes rather than answering
        return None
    except websockets.exceptions.ConnectionClosed as ex:
        return ex.code
    except websockets.exceptions.InvalidStatus as ex:
        return getattr(ex.response, "status_code", "http")


async def _echo_ok(url):
    """A real request over a good connection, so 'got in' means got in."""
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"id": 1, "op": "ping"}))
        return json.loads(await asyncio.wait_for(ws.recv(), timeout=10))


async def main():
    srv = await _serve()
    try:
        # Twice the cap, so a leak of one slot per rejection is certain to
        # exhaust it rather than merely being possible.
        for i in range(MAX_CONNS_PER_IP * 2):
            code = await _rejected(BAD)
            assert code == 1008, f"rejection {i} closed with {code}, expected 1008"

        # The client sees the close before the server's own finally has run, so
        # give the loop a turn, otherwise the last rejection is still "open"
        # and the count is legitimately 1.
        await asyncio.sleep(0.2)
        assert not server._ip_conns, (
            f"rejected connections left slots behind: {dict(server._ip_conns)}. "
            f"Every further client from this address is now refused with "
            f"'too many connections'."
        )

        reply = await _echo_ok(GOOD)
        assert reply.get("ok") is not False, f"a valid connection was refused: {reply}"
        print(f"{MAX_CONNS_PER_IP * 2} rejections, then a good connection still works OK")

        # ...and the same for a connection that authenticates and then simply
        # goes away, which is the ordinary case and shares the same cleanup.
        for _ in range(MAX_CONNS_PER_IP * 2):
            async with websockets.connect(GOOD):
                pass
        await asyncio.sleep(0.2)  # the server's finally runs after our close
        assert not server._ip_conns, (
            f"closed connections left slots behind: {dict(server._ip_conns)}"
        )
        print("clean disconnects give their slots back too OK")
    finally:
        srv.close()
        await srv.wait_closed()


if __name__ == "__main__":
    try:
        asyncio.run(main())
        print("\nconnection-limit tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)

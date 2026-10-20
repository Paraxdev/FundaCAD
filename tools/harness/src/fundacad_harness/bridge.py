"""Calls into the page driver (src/harness/driver.ts)."""

from __future__ import annotations

from typing import Any

from .errors import KINDS, DriverMismatch, HarnessError

DRIVER_API = 1

_CALL = "([m, a]) => window.__harness.call(m, a)"
_API = "() => (window.__harness ? window.__harness.api : null)"


def check_api(api: Any) -> None:
    if api is None:
        raise DriverMismatch("this page has no harness driver, it needs a dev build with src/harness opened with ?harness=1")
    if api != DRIVER_API:
        raise DriverMismatch(f"the page driver speaks api {api}, this package needs {DRIVER_API}")


def unwrap(reply: Any) -> Any:
    if not isinstance(reply, dict) or "ok" not in reply:
        raise HarnessError(f"the page driver gave an unexpected reply: {reply!r}"[:300])
    if reply["ok"]:
        return reply.get("value")
    err = reply.get("error") or {}
    cls = KINDS.get(err.get("kind", ""), HarnessError)
    raise cls(err.get("message", "the page driver failed"), err.get("candidates") or [])


class Bridge:
    def __init__(self, page):
        self.page = page

    def api(self) -> Any:
        return self.page.evaluate(_API)

    def call(self, method: str, **args: Any) -> Any:
        return unwrap(self.page.evaluate(_CALL, [method, args]))

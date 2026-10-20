import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.errors import HarnessError

REPO = Path(__file__).resolve().parents[4]


class LogBridge:
    """The page's log as the driver keeps it: ids only grow, readouts take `since`."""

    def __init__(self):
        self.log: list[dict] = []
        self.calls: list[tuple[str, dict]] = []

    def add(self, level, text):
        self.log.append({"seq": len(self.log) + 1, "level": level, "text": text, "at": 0})

    def call(self, method, **args):
        self.calls.append((method, args))
        since = args.get("since", 0)
        newer = [r for r in self.log if r["seq"] > since]
        if method == "seq":
            return self.log[-1]["seq"] if self.log else 0
        if method == "messages":
            return {"seq": self.log[-1]["seq"] if self.log else since, "rows": newer}
        if method == "status":
            errs = [r["text"] for r in newer if r["level"] == "error"]
            return {"mode": "selection", "recent": newer[-1] if newer else None, "error": errs[-1] if errs else None}
        if method == "lastError":
            errs = [r["text"] for r in newer if r["level"] == "error"]
            return errs[-1] if errs else None
        if method == "screen":
            return {"lines": []}
        raise AssertionError(method)


def session(bridge, on_key=None):
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    s.bridge = bridge
    s.page = types.SimpleNamespace(keyboard=types.SimpleNamespace(press=on_key or (lambda k: None)))
    s.settle = lambda *a, **k: "settled"
    return s


def test_a_wait_does_not_take_a_message_from_before_the_step(tmp_path):
    b = LogBridge()
    s = session(b)
    b.add("info", "Saved a.funda")
    s.press("Enter")
    with pytest.raises(HarnessError, match="did not show"):
        s.wait_for("saved", timeout=0.2)
    s.page.keyboard.press = lambda k: b.add("info", "Saved b.funda")
    s.press("Enter")
    assert s.wait_for("saved", timeout=0.2) == 'message "Saved b.funda"'
    s.close()


def test_a_step_says_what_the_app_said_while_it_ran(tmp_path):
    b = LogBridge()
    b.add("error", "an import from before")
    s = session(b, on_key=lambda k: b.add("info", "Create or import a body first"))
    line = str(s.press("Enter"))
    assert 'said info "Create or import a body first"' in line
    assert "an import from before" not in line
    assert s.last_error() == "none"
    assert "recent: info" in s.status()
    s.close()


def test_a_refused_lookup_does_not_keep_the_work_folder():
    b = LogBridge()
    s = session(b)

    def missing(method, **args):
        if method == "locate":
            from fundacad_harness.errors import NotFound
            raise NotFound("no visible control")
        return LogBridge.call(b, method, **args)

    b.call = missing
    with pytest.raises(HarnessError):
        s.click("Nope")
    work = s.work
    s.close()
    assert not work.exists()

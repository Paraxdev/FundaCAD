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


def test_a_step_names_an_error_once_and_not_as_a_message(tmp_path):
    b = LogBridge()
    s = session(b, on_key=lambda k: b.add("error", "Extrude failed"))
    line = str(s.press("Enter"))
    assert line.endswith(", error: Extrude failed")
    assert "said" not in line
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


def test_a_reload_is_taken_again_a_while_after_the_last_one():
    clock = [0.0]
    s = session(LogBridge())
    s._clock = lambda: clock[0]
    s._wait_driver = lambda: None
    s.dismiss_start = lambda: "none"
    s._navs += 1
    s._ensure_page()
    clock[0] = 31
    s._navs += 1
    s._ensure_page()
    clock[0] = 35
    s._navs += 1
    with pytest.raises(HarnessError, match="reloaded twice in 30 s"):
        s._ensure_page()
    s.close()


def test_the_step_after_a_reload_says_the_document_is_new():
    s = session(LogBridge())
    s._wait_driver = lambda: None
    s.dismiss_start = lambda: "none"
    s._navs += 1
    assert str(s.press("Enter")).startswith("pressed Enter, the page reloaded before this step, a browser tab keeps no document")
    assert "reloaded" not in str(s.press("Enter"))
    assert any("reloaded" in w for w in s.warnings)
    s.close()


def test_a_reload_in_the_middle_of_a_step_is_named():
    s = session(LogBridge())

    def reload(k):
        s._navs += 1
        raise RuntimeError("Page.evaluate: Execution context was destroyed")

    s.page.keyboard.press = reload
    with pytest.raises(HarnessError, match="press stopped, the page reloaded while it ran"):
        s.press("Enter")
    s.close()


def test_a_wait_looks_only_at_labels_new_since_the_step():
    b = LogBridge()
    asked = []
    plain = b.call

    def call(method, **args):
        if method == "screen":
            asked.append(args)
            return {"lines": [[0, "action:x", "button", "Export done", []]] if args.get("fresh") and len(asked) > 1 else []}
        return plain(method, **args)

    b.call = call
    s = session(b)
    s.press("Enter")
    assert s.wait_for("export", timeout=1) == 'on screen "Export done"'
    assert all(a.get("fresh") for a in asked)
    s.close()

import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.errors import SettleTimeout

REPO = Path(__file__).resolve().parents[4]


class Bridge:
    def __init__(self):
        self.settles: list[int] = []
        self.busy = False

    def call(self, method, **args):
        if method == "seq":
            return 0
        if method == "messages":
            return {"seq": 0, "rows": []}
        if method == "status":
            return {"mode": "model"}
        if method == "history":
            return {"count": 1}
        if method == "bodies":
            return [{"id": "body1"}]
        if method == "settle":
            self.settles.append(args["timeoutMs"])
            if self.busy and args["timeoutMs"] < 100_000:
                raise SettleTimeout(f"not settled after {args['timeoutMs'] // 1000} s: socket open")
            self.busy = False
            return {"ms": 1}
        raise AssertionError(method)


def session(**kw):
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False, **kw)
    s.bridge = Bridge()
    s.page = types.SimpleNamespace()
    s._drop_on_canvas = lambda full: setattr(s.bridge, "busy", True)
    return s


def test_a_settle_timeout_says_the_work_may_go_on_and_names_the_option():
    s = session()
    s.bridge.busy = True
    with pytest.raises(SettleTimeout, match=r"not settled after 60 s: socket open\. The app may still be working.*settle_timeout \(now 60 s\)"):
        s.settle()
    s.close()


def test_an_import_waits_longer_than_an_ordinary_step():
    s = session()
    assert str(s.import_file(REPO / "tools/harness/fixtures/plate.json")).startswith("dropped plate.json, 1 body now")
    assert s.bridge.settles[0] == 300_000
    s.close()


def test_an_import_with_settle_false_returns_at_once():
    s = session()
    step = str(s.import_file(REPO / "tools/harness/fixtures/plate.json", settle=False))
    assert step.startswith("dropped plate.json, the import runs on")
    assert s.bridge.settles == []
    s.close()


def test_the_settle_limit_caps_every_wait():
    s = session()
    s.settle_limit = 20
    with pytest.raises(SettleTimeout, match="not settled after 20 s"):
        s.import_file(REPO / "tools/harness/fixtures/plate.json")
    s.close()


def test_a_recording_keeps_a_longer_settle_timeout(tmp_path):
    s = session(settle_timeout=150, record=tmp_path / "rec.py")
    assert "Session(settle_timeout=150)" in s.recorder.source()
    s.close()


def test_undo_with_settle_false_only_clicks():
    s = session()
    s._click_control = lambda ref, *a: {"ref": ref, "label": "Undo"}
    assert str(s.undo(settle=False)).startswith("clicked #undo-btn, mode model")
    assert s.bridge.settles == []
    s.close()


class TimeoutError(Exception):
    pass


def _click_times_out(on_top: bool):
    s = session()
    loc = types.SimpleNamespace(click=lambda **k: (_ for _ in ()).throw(TimeoutError()), evaluate=lambda js: on_top)
    s._locator = lambda target: ({"ref": "#undo-btn", "label": "Undo"}, loc)
    return s


def test_a_click_a_busy_page_did_not_take_says_the_page_was_busy():
    from fundacad_harness.errors import Occluded
    s = _click_times_out(True)
    with pytest.raises(Occluded, match="nothing is over it, the page was busy"):
        s._click_control("#undo-btn")
    s = _click_times_out(False)
    with pytest.raises(Occluded, match="something is over it"):
        s._click_control("#undo-btn")
    s.close()

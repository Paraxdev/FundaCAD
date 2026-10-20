import base64
import io
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from fundacad_harness import steps
from fundacad_harness.errors import NotFound
from fundacad_harness.serve import Server

REPO = Path(__file__).resolve().parents[4]
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


class StubSession:
    def __init__(self, tmp, **kw):
        self.kw = kw
        self.closed = False
        self.start_screen = "home"
        self.calls = []
        self.tmp = tmp
        self.page = type("P", (), {"evaluate": lambda _s, _js, args: args[0]})()

    def status(self):
        return "mode model | tool none"

    def click(self, target, **kw):
        if target == "Nowhere":
            raise NotFound('no visible control "Nowhere"')
        self.calls.append(("click", target, kw))
        return f"clicked {target}"

    def press(self, *keys, **kw):
        self.calls.append(("press", keys, kw))
        return "pressed " + " ".join(keys)

    def drag(self, from_, to, **kw):
        self.calls.append(("drag", from_, to))
        return "dragged"

    def history(self):
        return "history 0 features, at end"

    def screen(self, region=None):
        return f"screen {region}"

    def last_error(self):
        return "none"

    def page_errors(self):
        return []

    def screenshot(self, target=None):
        p = self.tmp / "shot.png"
        p.write_bytes(PNG)
        return str(p)

    def close(self):
        self.closed = True
        return "stopped browser, engine, vite"


def talk(tmp, *reqs):
    made = []

    def make(**kw):
        made.append(StubSession(tmp, **kw))
        return made[-1]

    out = io.StringIO()
    lines = [r if isinstance(r, str) else json.dumps(r) for r in reqs]
    Server(make).loop(io.StringIO("\n".join(lines) + "\n"), out)
    return [json.loads(x) for x in out.getvalue().splitlines()], made


def test_open_do_read_shot_close(tmp_path):
    replies, made = talk(
        tmp_path,
        {"id": 1, "call": "open", "args": {"viewport": "800x600"}},
        {"id": 2, "call": "do", "args": {"steps": [
            {"do": "click", "target": "Extrude"},
            {"do": "press", "keys": "Enter"},
            {"do": "drag", "from": [0, 0], "to": [10, 5], "settle": False},
        ]}},
        {"id": 3, "call": "read", "args": {"what": ["history", "screen"], "region": "items"}},
        {"id": 4, "call": "shot", "args": {"max_px": 5000}},
        {"id": 5, "call": "close"},
    )
    assert [r["id"] for r in replies] == [1, 2, 3, 4, 5]
    assert all(r["ok"] for r in replies)
    assert "private copy" in replies[0]["text"] and made[0].kw["viewport"] == (800, 600)
    assert replies[1]["text"].splitlines()[:3] == ["1. clicked Extrude", "2. pressed Enter", "3. dragged"]
    assert made[0].calls[2] == ("drag", (0, 0), (10, 5))
    assert replies[2]["text"] == "history 0 features, at end\n\nscreen items"
    assert base64.b64decode(replies[3]["png"]) == PNG and "1600 px" in replies[3]["text"]
    assert "also at" not in replies[3]["text"] and not (tmp_path / "shot.png").exists(), "a clean close removes it"
    assert replies[4]["text"].startswith("stopped") and made[0].closed


def test_a_failing_step_stops_there_and_reports_the_status(tmp_path):
    replies, made = talk(
        tmp_path,
        {"id": 1, "call": "open"},
        {"id": 2, "call": "do", "args": {"steps": [
            {"do": "click", "target": "Nowhere"}, {"do": "press", "keys": "Enter"}]}},
    )
    assert replies[1]["ok"] is False
    assert replies[1]["text"].startswith('1. failed: no visible control "Nowhere"')
    assert "mode model" in replies[1]["text"]
    assert made[0].calls == []
    assert made[0].closed, "the loop closes the session when its input ends"


def test_bad_lines_are_answered_not_fatal(tmp_path):
    replies, _ = talk(
        tmp_path,
        "{not json",
        {"id": 2, "call": "read"},
        {"id": 3, "call": "fly"},
        {"id": 4, "call": "open", "args": {"colour": "red"}},
        {"id": 5, "call": "open"},
        {"id": 6, "call": "do", "args": {"steps": [{"do": "click"}]}},
        {"id": 7, "call": "do", "args": {"steps": [{"do": "teleport"}]}},
    )
    assert [r["ok"] for r in replies] == [False, False, False, False, True, False, False]
    assert "not a JSON line" in replies[0]["text"]
    assert "ui_open first" in replies[1]["text"]
    assert "unknown call" in replies[2]["text"]
    assert "colour" in replies[3]["text"]
    assert "click needs target" in replies[5]["text"]
    assert 'unknown verb "teleport"' in replies[6]["text"]


def test_step_keys_are_checked_by_name():
    assert steps.check({"do": "type", "target": "D", "text": "4", "enter": True}) == (
        "type", {"target": "D", "text": "4", "enter": True})
    with pytest.raises(Exception, match="type does not take speed"):
        steps.check({"do": "type", "target": "D", "text": "4", "speed": 2})
    with pytest.raises(Exception, match="wait_for does not take settle"):
        steps.check({"do": "wait_for", "text": "x", "settle": False})


def test_every_verb_is_a_session_action():
    from fundacad_harness import Session
    for verb in steps.VERBS:
        assert getattr(Session, verb, None) is not None, verb


def test_serve_writes_only_protocol_lines_to_stdout():
    p = subprocess.run([sys.executable, "-m", "fundacad_harness", "serve"], input='{"id": 1, "call": "close"}\nnope\n',
                       capture_output=True, text=True, timeout=60)
    lines = p.stdout.splitlines()
    assert [json.loads(x)["id"] for x in lines] == [1, None]


def test_the_mcp_ui_do_description_lists_every_verb():
    text = (REPO / "crates/fundacad-mcp/src/tools.rs").read_text(encoding="utf-8")
    text = text.split("pub fn ui_do()", 1)[1].split("pub fn ", 1)[0]
    missing = [v for v in steps.VERBS if not re.search(rf"\b{v}\b", text)]
    assert not missing, f"tools.rs ui_do does not mention {missing}"


def test_a_long_do_stops_starting_steps_before_the_relay_gives_up(tmp_path):
    ticks = iter(range(0, 1000, 50))
    s = StubSession(tmp_path)
    s.settle_timeout = 60
    server = Server(lambda **kw: s, clock=lambda: next(ticks))
    server.open()
    ok, text = server.do([{"do": "press", "keys": "Enter"}] * 5)
    assert ok is False
    assert text.splitlines()[:3] == [
        "1. pressed Enter", "2. pressed Enter",
        "stopped before step 3 after 150 s, send steps 3 to 5 in a new ui_do",
    ]
    assert s.settle_timeout == 60, "the session's own settle time comes back after the call"


def test_a_wait_in_a_do_is_capped():
    with pytest.raises(Exception, match="up to 60 s"):
        steps.check({"do": "wait_for", "text": "x", "timeout": 200})


def test_a_wait_started_late_in_a_do_ends_by_the_settle_limit(tmp_path):
    ticks = iter([0, 0, 100, 119, 119])
    s = StubSession(tmp_path)
    waits = []
    s.wait_for = lambda text, timeout=10, **kw: waits.append(timeout) or f"saw {text}"
    server = Server(lambda **kw: s, clock=lambda: next(ticks))
    server.open()
    ok, text = server.do([{"do": "wait_for", "text": "a", "timeout": 60}, {"do": "wait_for", "text": "b", "timeout": 60}, {"do": "wait_for", "text": "c", "timeout": 60}, {"do": "wait_for", "text": "d"}])
    assert ok is True, text
    assert waits == [60, 50, 31, 10]

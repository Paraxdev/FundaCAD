"""Guide mode end to end: fundacad-mcp attached to a harness window over its live
session runs a three step fillet guide on a box through guide_highlight,
guide_wait and guide_clear, and a Stop pressed in the window reaches the tools."""

import json
import os
import subprocess
import threading
import time
from pathlib import Path

import pytest

from fundacad_harness.launch import find_repo

pytestmark = pytest.mark.browser

BLOCK = "tools/harness/fixtures/block.json"
EXE = "fundacad-mcp.exe" if os.name == "nt" else "fundacad-mcp"


def mcp_exe() -> Path:
    roots = [Path(os.environ["CARGO_TARGET_DIR"])] if os.environ.get("CARGO_TARGET_DIR") else []
    roots.append(find_repo() / "target")
    for root in roots:
        for profile in ("debug", "release"):
            if (root / profile / EXE).is_file():
                return root / profile / EXE
    pytest.skip("build fundacad-mcp first (cargo build -p fundacad-mcp)")


class Mcp:
    """Just enough of an MCP client over stdio: initialize, then tools/call."""

    def __init__(self, session_file: Path, log: Path):
        env = dict(os.environ, FUNDACAD_MCP_MODE="attach", FUNDACAD_SESSION_FILE=str(session_file), FUNDACAD_MCP_SHADOW="0")
        self.err = open(log, "w", encoding="utf-8")
        self.p = subprocess.Popen([str(mcp_exe())], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err, env=env, text=True, encoding="utf-8")
        self.n = 0
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "guide-e2e", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send(self, msg: dict) -> None:
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def rpc(self, method: str, params: dict) -> dict:
        self.n += 1
        self.send({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(f"fundacad-mcp exited, see {self.err.name}")
            msg = json.loads(line)
            if msg.get("id") == self.n:
                return msg

    def call(self, name: str, **args) -> tuple[bool, str]:
        res = self.rpc("tools/call", {"name": name, "arguments": args})["result"]
        return bool(res.get("isError")), "\n".join(c.get("text", "") for c in res["content"])

    def close(self) -> None:
        try:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()
            self.p.wait()
        self.err.close()


def in_thread(fn):
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("v", fn()))
    t.start()
    return t, out


def until(cond, seconds: float = 3.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        v = cond()
        if v:
            return v
        time.sleep(0.1)
    return cond()


@pytest.fixture
def guided(session, tmp_path):
    session.press("Escape")
    session.new_document()
    session.open_file(BLOCK)
    session.view("iso")
    sf = tmp_path / "session.json"
    sf.write_text(json.dumps({"port": session.engine_port, "token": session.token, "pid": os.getpid()}))
    mcp = Mcp(sf, tmp_path / "mcp.log")
    try:
        yield session, mcp
    finally:
        mcp.call("guide_clear")
        mcp.close()


def test_a_three_step_fillet_guide_on_a_box(guided):
    s, mcp = guided

    err, out = mcp.call("guide_highlight", ui="pick:fillet", caption="Open Fillet in Modify", step=1, of=3)
    assert not err, out
    assert "family:cat:MODIFY" in out
    g = s.guide(raw=True)
    assert g["on"] == "family:cat:MODIFY" and g["ring"], g
    assert g["count"] == "Step 1 of 3" and g["caption"] == "Open Fillet in Modify"
    s.click("family:cat:MODIFY")
    assert until(lambda: (s.guide(raw=True) or {}).get("on") == "pick:fillet"), s.guide(raw=True)
    t, got = in_thread(lambda: mcp.call("guide_wait", until="tool", tool="fillet", timeout_s=20))
    time.sleep(0.6)
    s.click("pick:fillet")
    t.join(25)
    assert got["v"] == (False, "tool started: Fillet / Chamfer"), got

    err, out = mcp.call("guide_highlight", model="between top front", caption="Pick the top front edge", step=2, of=3)
    assert not err, out
    assert until(lambda: (s.guide(raw=True) or {}).get("outline")), s.guide(raw=True)
    t, got = in_thread(lambda: mcp.call("guide_wait", until=["selection", "value"], timeout_s=20))
    time.sleep(0.6)
    s.pick_edge("between top front", via="edge")
    t.join(25)
    assert not got["v"][0] and got["v"][1].startswith(("selection: 1 edge", "value")), got

    err, out = mcp.call("guide_highlight", ui="field:radius", caption="Type 3 and press Enter", step=3, of=3)
    assert not err and out == "step 3 of 3 is up on field:radius", out
    t, got = in_thread(lambda: mcp.call("guide_wait", until=["value", "feature"], timeout_s=20))
    time.sleep(0.6)
    s.type("field:radius", "3", enter=True)
    t.join(25)
    assert got["v"][1] in ("value typed: radius = 3",) or got["v"][1].startswith("feature added:"), got

    err, out = mcp.call("guide_clear")
    assert (err, out) == (False, "the guide is cleared")
    assert until(lambda: s.guide(raw=True) is None)


def test_stop_in_the_window_clears_and_tells_the_assistant(guided):
    s, mcp = guided
    err, out = mcp.call("guide_highlight", ui="#browser", caption="Here are the bodies", step=2, of=3)
    assert not err, out
    t, got = in_thread(lambda: mcp.call("guide_wait", until="next", timeout_s=20))
    time.sleep(0.6)
    s.click("#guide-stop")
    t.join(25)
    assert got["v"] == (False, "the user stopped the guide at step 2 of 3, everything is cleared"), got
    assert until(lambda: s.guide(raw=True) is None)


def test_next_in_the_window_answers_the_wait(guided):
    s, mcp = guided
    mcp.call("guide_highlight", ui="#browser", caption="Here are the bodies", step=1, of=2)
    t, got = in_thread(lambda: mcp.call("guide_wait", until="next", timeout_s=20))
    time.sleep(0.6)
    s.click("#guide-next")
    t.join(25)
    assert got["v"] == (False, "Next pressed"), got


def frame_ms(s) -> float:
    return s.page.evaluate(
        "() => new Promise((r) => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t))); })"
    )


def test_a_wait_open_after_next_keeps_the_window_responsive(guided):
    s, mcp = guided
    mcp.call("guide_highlight", ui="#browser", caption="Here are the bodies", step=1, of=2)
    t, got = in_thread(lambda: mcp.call("guide_wait", until="tool", timeout_s=4))
    time.sleep(0.6)
    s.click("#guide-next")
    worst = max(frame_ms(s) for _ in range(20))
    t.join(10)
    assert worst < 500, f"a frame took {worst:.0f} ms"
    assert got["v"] == (False, "nothing happened in 4 s, and no step is on screen"), got


def test_a_wait_with_no_step_keeps_the_window_responsive(guided):
    s, mcp = guided
    t, got = in_thread(lambda: mcp.call("guide_wait", until="tool", timeout_s=3))
    time.sleep(0.6)
    worst = max(frame_ms(s) for _ in range(20))
    t.join(10)
    assert worst < 500, f"a frame took {worst:.0f} ms"
    assert got["v"] == (False, "nothing happened in 3 s, and no step is on screen"), got

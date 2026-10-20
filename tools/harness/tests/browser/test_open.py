import os
import subprocess

import pytest

from fundacad_harness import Session

pytestmark = [pytest.mark.browser, pytest.mark.smoke]


def alive(pid: int) -> bool:
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_open_shows_the_app_and_close_stops_everything():
    s = Session(keep=False)
    try:
        assert s.start_screen in ("home", "welcome")
        assert s.call("startScreen") == "none"
        tree = s.screen()
        assert "toolrail mode=model" in tree
        assert "action:sketch" in tree
        assert s.status().startswith("mode model | tool none")
        assert s.history() == "history 0 features, at end"
        assert s.page_errors() == []
        assert len(s.pids()) == 2
        pids = s.pids()
    finally:
        s.close()
    assert not [p for p in pids if alive(p)]
    assert not s.work.exists()

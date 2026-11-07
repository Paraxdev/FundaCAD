import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.errors import HarnessError

REPO = Path(__file__).resolve().parents[4]


class TimeoutError(Exception):
    """Named as Playwright's is, which is not the builtin one."""


class StartBridge:
    def __init__(self):
        self.screen = "home"

    def call(self, method, **args):
        if method == "startScreen":
            return self.screen
        if method == "stageInert":
            return self.screen != "none"
        raise AssertionError(method)


def session(bridge, click, keys):
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    s.bridge = bridge
    close = types.SimpleNamespace(count=lambda: 1, click=click)
    s.page = types.SimpleNamespace(
        locator=lambda sel: types.SimpleNamespace(first=close),
        keyboard=types.SimpleNamespace(press=keys.append),
    )
    s._wait_for = lambda cond, timeout: Session._wait_for(cond, 0.2)
    return s


def busy(timeout):
    raise TimeoutError(f"Locator.click: Timeout {timeout}ms exceeded.")


def test_a_close_click_the_busy_page_never_took_falls_back_to_escape():
    b, keys = StartBridge(), []
    s = session(b, busy, keys)
    s.page.keyboard.press = lambda k: (keys.append(k), setattr(b, "screen", "none"))
    assert s.dismiss_start() == "home"
    assert keys == ["Escape"]
    s.close()


def test_a_start_screen_neither_the_click_nor_escape_closes_still_fails():
    s = session(StartBridge(), busy, [])
    with pytest.raises(HarnessError, match="the home screen did not close"):
        s.dismiss_start()
    s.close()


def test_a_click_error_that_is_no_timeout_is_not_swallowed():
    def broken(timeout):
        raise RuntimeError("the page closed")

    s = session(StartBridge(), broken, [])
    with pytest.raises(RuntimeError, match="the page closed"):
        s.dismiss_start()
    s.close()

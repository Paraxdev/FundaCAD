import pytest

from fundacad_harness import a11y
from fundacad_harness.errors import DriverMismatch, HarnessError, Occluded, SettleTimeout


class Page:
    """Logs every step, and fails a screen's show, leave or a reset with the errors queued for it."""

    def __init__(self, shows=None, leaves=(), resets=None):
        self.log: list[str] = []
        self.shows = {k: list(v) for k, v in (shows or {}).items()}
        self.leaves = set(leaves)
        self.resets = list(resets or [])


def flows(*screens):
    out = []
    for name, base in screens:

        def show(p, name=name):
            p.log.append(f"show {name}")
            if p.shows.get(name):
                raise p.shows[name].pop(0)

        def leave(p, name=name):
            p.log.append(f"leave {name}")
            if name in p.leaves:
                raise HarnessError(f"{name} stayed open")

        out.append((name, show, leave, base))
    return out


def scan(p, name):
    p.log.append(f"scan {name}")
    return [name]


def reset(p, base):
    p.log.append(f"reset {base}")
    if p.resets:
        raise p.resets.pop(0)


FOUR = flows(("a", "blank"), ("b", "blank"), ("c", "fixture"), ("d", "fixture"))


def test_a_walk_with_nothing_broken_never_resets():
    p = Page()
    assert a11y.walk(p, FOUR, scan, reset) == {"a": ["a"], "b": ["b"], "c": ["c"], "d": ["d"]}
    assert p.log == [
        "show a", "scan a", "leave a",
        "show b", "scan b", "leave b",
        "show c", "scan c", "leave c",
        "show d", "scan d", "leave d",
    ]  # fmt: skip


def test_a_broken_screen_fails_alone_and_the_next_starts_from_a_fresh_page_at_its_base():
    p = Page(shows={"b": [HarnessError("no Box with a lid on Home")]})
    assert a11y.walk(p, FOUR, scan, reset) == {
        "a": ["a"],
        "b": "HarnessError: no Box with a lid on Home",
        "c": ["c"],
        "d": ["d"],
    }
    assert p.log == [
        "show a", "scan a", "leave a",
        "show b",
        "reset fixture", "show c", "scan c", "leave c",
        "show d", "scan d", "leave d",
    ]  # fmt: skip


def playwright_timeout():
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeout
    except ImportError:
        return pytest.param(None, marks=pytest.mark.skip(reason="playwright is not installed"))
    return PlaywrightTimeout("Locator.click: Timeout 5000ms exceeded")


BUSY = [
    Occluded("menu:File did not take the click, page was busy"),
    SettleTimeout("60 s"),
    playwright_timeout(),
    DriverMismatch("this page has no harness driver, right after vite rebuilt its dependencies"),
]


@pytest.mark.parametrize("busy", BUSY)
def test_a_busy_screen_is_shown_again_from_a_fresh_page_at_its_base(busy):
    p = Page(shows={"c": [busy]})
    assert a11y.walk(p, FOUR, scan, reset) == {"a": ["a"], "b": ["b"], "c": ["c"], "d": ["d"]}
    assert p.log == [
        "show a", "scan a", "leave a",
        "show b", "scan b", "leave b",
        "show c", "reset fixture", "show c", "scan c", "leave c",
        "show d", "scan d", "leave d",
    ]  # fmt: skip


def test_a_screen_busy_on_every_try_fails_after_one_retry():
    p = Page(shows={"b": [Occluded("first"), Occluded("second"), Occluded("third")]})
    assert a11y.walk(p, FOUR, scan, reset) == {"a": ["a"], "b": "Occluded: second", "c": ["c"], "d": ["d"]}
    assert p.log == [
        "show a", "scan a", "leave a",
        "show b", "reset blank", "show b",
        "reset fixture", "show c", "scan c", "leave c",
        "show d", "scan d", "leave d",
    ]  # fmt: skip


def test_a_screen_that_does_not_close_hands_the_next_a_fresh_page():
    p = Page(leaves={"a"})
    assert a11y.walk(p, FOUR, scan, reset) == {"a": ["a"], "b": ["b"], "c": ["c"], "d": ["d"]}
    assert p.log == [
        "show a", "scan a", "leave a",
        "reset blank", "show b", "scan b", "leave b",
        "show c", "scan c", "leave c",
        "show d", "scan d", "leave d",
    ]  # fmt: skip


@pytest.mark.parametrize("busy", BUSY)
def test_a_reset_that_was_busy_is_tried_again(busy):
    p = Page(shows={"b": [HarnessError("broken")]}, resets=[busy])
    assert a11y.walk(p, FOUR, scan, reset) == {"a": ["a"], "b": "HarnessError: broken", "c": ["c"], "d": ["d"]}
    assert p.log == [
        "show a", "scan a", "leave a",
        "show b",
        "reset fixture", "reset fixture", "show c", "scan c", "leave c",
        "show d", "scan d", "leave d",
    ]  # fmt: skip


def test_a_reset_that_breaks_fails_its_screen_and_the_next_one_resets_again():
    p = Page(shows={"b": [HarnessError("broken")]}, resets=[HarnessError("the app did not get ready")])
    assert a11y.walk(p, FOUR, scan, reset) == {
        "a": ["a"],
        "b": "HarnessError: broken",
        "c": "HarnessError: the app did not get ready",
        "d": ["d"],
    }
    assert p.log == [
        "show a", "scan a", "leave a",
        "show b",
        "reset fixture",
        "reset fixture", "show d", "scan d", "leave d",
    ]  # fmt: skip


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def timed(clock, seconds):
    def slow_reset(p, base):
        clock.t += seconds
        reset(p, base)

    return slow_reset


def test_once_the_resets_have_used_up_their_budget_a_screen_that_needs_one_is_not_run():
    clock = Clock()
    p = Page(shows={"a": [HarnessError("a broke")], "b": [Occluded("b busy"), Occluded("b busy again")]})
    assert a11y.walk(p, FOUR, scan, timed(clock, 100), reset_budget=150, clock=clock) == {
        "a": "HarnessError: a broke",
        "b": "Occluded: b busy again",
        "c": "not run, the resets before it took 200 s of a 150 s budget",
        "d": "not run, the resets before it took 200 s of a 150 s budget",
    }
    assert p.log == ["show a", "reset blank", "show b", "reset blank", "show b"]


def test_a_busy_screen_is_not_retried_past_the_reset_budget_and_keeps_its_error():
    clock = Clock()
    p = Page(shows={"b": [Occluded("b busy")]}, leaves={"a"})
    assert a11y.walk(p, FOUR, scan, timed(clock, 100), reset_budget=50, clock=clock) == {
        "a": ["a"],
        "b": "Occluded: b busy",
        "c": "not run, the resets before it took 100 s of a 50 s budget",
        "d": "not run, the resets before it took 100 s of a 50 s budget",
    }
    assert p.log == ["show a", "scan a", "leave a", "reset blank", "show b"]


def test_a_screen_whose_last_try_failed_reports_that_error_for_both_axe_and_aria():
    walked = {
        "a": {"axe": [{"id": "region"}], "aria": {"a": "", "negative": "no dialog named No such dialog"}},
        "b": "HarnessError: show broke",
    }
    assert a11y.verdicts(walked) == (
        {"a": [{"id": "region"}], "b": "HarnessError: show broke"},
        {"a": "", "negative": "no dialog named No such dialog", "b": "HarnessError: show broke"},
    )


class LoadingPage:
    """Commits a reload at once and fires its load events later than any goto timeout, like vite on a busy machine."""

    def __init__(self, log):
        self.log = log
        self.keyboard = self
        self.handlers = []

    def on(self, event, fn):
        self.handlers.append((event, fn))

    def remove_listener(self, event, fn):
        self.handlers.remove((event, fn))

    def goto(self, url, wait_until="load", timeout=30_000):
        if wait_until != "commit":
            raise TimeoutError(f"Page.goto: Timeout {timeout}ms exceeded")
        self.log.append(f"goto {url}, listening for {[e for e, _ in self.handlers]}")

    def press(self, key):
        self.log.append(f"press {key}")


class Reloading:
    url = "http://127.0.0.1:5173/?harness=1"

    def __init__(self):
        self.log: list[str] = []
        self.page = LoadingPage(self.log)
        self.bridge = self
        self._navs, self._seen_navs = 3, 1

    def call(self, name):
        return "none"

    def _wait_driver(self):
        self.log.append("wait for the driver")

    def dismiss_start(self):
        self.log.append("dismiss the start screen")

    def settle(self):
        self.log.append("settle")


def test_a_fresh_page_waits_for_the_driver_and_not_for_the_page_load_events():
    s = Reloading()
    a11y.fresh_page(s, lambda s: s.log.append("bring it to its base"))
    assert s.log == [
        "goto http://127.0.0.1:5173/?harness=1, listening for ['dialog']",
        "wait for the driver",
        "dismiss the start screen",
        "bring it to its base",
        "settle",
    ]
    assert (s._seen_navs, s.page.handlers) == (3, [])

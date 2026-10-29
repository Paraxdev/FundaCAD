import pytest

from fundacad_harness import a11y
from fundacad_harness.errors import HarnessError, Occluded, SettleTimeout


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


BUSY = [
    Occluded("menu:File did not take the click, page was busy"),
    SettleTimeout("60 s"),
    pytest.importorskip("playwright.sync_api").TimeoutError("Locator.click: Timeout 5000ms exceeded"),
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

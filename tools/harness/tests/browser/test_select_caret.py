"""The Select caret holds still while its trigger is hovered and turns a quarter about its own centre while the list
is open, on the Items kind filter where it used to slide away on hover and vanish on a click."""

import pytest

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

TRIGGER = "#browser-filter"

# The turn and offset of the caret's computed transform, and where its centre sits from the trigger's right edge
# and middle in the laid out page.
CARET = """(t) => {
  const c = t.querySelector(".select-caret");
  if (!c) return null;
  const m = new DOMMatrix(getComputedStyle(c).transform);
  const r = c.getBoundingClientRect();
  const b = t.getBoundingClientRect();
  const n = (v) => Math.round(v) + 0;
  return {
    open: t.getAttribute("aria-expanded") === "true",
    turn: n((Math.atan2(m.b, m.a) * 180) / Math.PI),
    shift: [n(m.e), n(m.f)],
    fromRight: n(b.right - (r.left + r.right) / 2),
    fromMiddle: n((r.top + r.bottom) / 2 - (b.top + b.bottom) / 2),
  };
}"""

# Two frames for the new state's transitions to start, then wait them out.
SETTLE = """() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => Promise.race([
  Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {}))),
  new Promise((r) => setTimeout(r, 3000)),
]))"""


def caret(s):
    s.page.evaluate(SETTLE)
    return s.page.locator(TRIGGER).evaluate(CARET)


def away(s):
    size = s.page.viewport_size
    s.page.mouse.move(size["width"] / 2, size["height"] / 2)


def test_the_caret_holds_still_on_hover_and_turns_down_about_its_centre_while_open(session):
    s = session
    trigger = s.page.locator(TRIGGER)
    trigger.wait_for(state="visible", timeout=30_000)
    away(s)
    states = {"closed": caret(s)}
    trigger.hover()
    states["hovered"] = caret(s)
    trigger.click()
    states["open, still hovered"] = caret(s)
    s.page.keyboard.press("Escape")
    away(s)
    states["closed again"] = caret(s)

    rest = {"open": False, "turn": 0, "shift": [0, 0], "fromRight": 14, "fromMiddle": 0}
    assert states == {
        "closed": rest,
        "hovered": rest,
        "open, still hovered": {**rest, "open": True, "turn": 90},
        "closed again": rest,
    }

"""The frame rate chip hides while no stretch of its row between the floating cards fits it, rather than sit half
under one of them, and comes back once a stretch does."""

import pytest

from fundacad_harness.layout import overlapping

pytestmark = [pytest.mark.browser]

CHIP = "#viewport .fps"
CARDS = "#chip-left, #chip-right"

# A card in each column whose ends come within 20 px of the chip's middle, so the stretch between them, less the
# float gap on each side, is narrower than the chip.
CLOSE_IN = """() => {
  const chip = document.querySelector('#viewport .fps').getBoundingClientRect();
  const mid = (chip.left + chip.right) / 2;
  const put = (col, id, left, right) => {
    const c = document.createElement('div');
    c.id = id;
    c.style.cssText = `position:fixed;left:${left}px;width:${right - left}px;top:${chip.top - 40}px;` +
      `height:${chip.height + 80}px;background:#888`;
    document.querySelector(`#float-layer ${col}`).append(c);
  };
  put('.float-left-stack', 'chip-left', 0, mid - 20);
  put('.float-right', 'chip-right', mid + 20, innerWidth);
}"""

SEEN = "() => document.querySelector('#viewport .fps').checkVisibility({ visibilityProperty: true })"


def nudge(s):
    """A window resize, so the chip measures its row again."""
    size = s.page.viewport_size
    s.page.set_viewport_size({"width": size["width"], "height": size["height"] - 1})
    s.page.wait_for_timeout(100)
    s.page.set_viewport_size(size)
    s.page.wait_for_timeout(300)


def test_the_chip_hides_without_room_and_comes_back_with_it(session):
    s = session
    s.press("Escape")
    s.open_file("tools/harness/fixtures/plate.json")
    s.settle()
    assert s.page.evaluate(SEEN)
    s.page.evaluate(CLOSE_IN)
    try:
        nudge(s)
        assert overlapping(s.page, CHIP, CARDS) == []
        assert not s.page.evaluate(SEEN)
        s.page.evaluate("() => document.getElementById('chip-right').remove()")
        nudge(s)
        assert s.page.evaluate(SEEN)
        assert overlapping(s.page, CHIP, CARDS) == []
    finally:
        s.page.evaluate("() => document.querySelectorAll('#chip-left, #chip-right').forEach((c) => c.remove())")
        nudge(s)

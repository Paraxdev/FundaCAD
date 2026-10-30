import json

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import overlapping
from fundacad_harness.screens import close_settings, open_settings, out_dir, settled

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

SIZES = (100, 150, 200)
WINDOW = (1366, 768)
# The tool's hint card and the frame rate chip along the bottom middle of the view, and the cards beside them.
PROMPT = "#viewport .prompt"
CHIP = "#viewport .fps"
LEFT = "#float-layer .float-left-stack > *, #float-layer .tool-rail button"
RIGHT = "#viewcontrols .float-group, #viewcontrols button, #float-layer .float-right > :not(#viewcontrols)"
BAIT = """() => {
  const r = document.querySelector('#viewport .fps').getBoundingClientRect();
  const b = document.createElement('div');
  b.id = 'overlap-bait';
  b.style.cssText = `position:fixed;left:${r.left + 4}px;top:${r.top + 4}px;width:40px;height:40px;z-index:99`;
  document.body.append(b);
}"""


def armed(s: Session) -> None:
    """Rectangle armed in a sketch, so the hint card is up beside the sketch palette."""
    s.page.keyboard.press("r")
    s.settle()
    settled(s)
    s.page.locator("#viewport .prompt:not(.hidden)").wait_for()
    # The cards place themselves a frame or two after a resize.
    s.page.wait_for_timeout(400)


@pytest.fixture(scope="module")
def rows():
    """Each size in its own session laid out as setZoom does, as in test_size.py."""
    out = out_dir()
    found: dict[str, list[str]] = {}
    for pct in SIZES:
        z = pct / 100
        s = Session(viewport=(round(WINDOW[0] / z), round(WINDOW[1] / z)), scale=z)
        try:
            s.open_file("tools/harness/fixtures/whole_sketch_extrude.json")
            s.view("fit")
            s.panel("history")
            s.click("feature:s", double=True)
            s.settle()
            for comfortable in (False, True):
                if comfortable:
                    open_settings(s, "Accessibility")
                    s.page.locator("#prefs-comfortable-text").click()
                    settled(s)
                    close_settings(s)
                armed(s)
                name = f"{pct} {'comfortable' if comfortable else 'plain'}"
                # Where the span between the columns is under its minimum width the hint card goes under the right
                # column on purpose (promptInsets), so the right side is checked for the chip alone.
                found[name] = overlapping(s.page, CHIP, f"{PROMPT}, {LEFT}, {RIGHT}") + overlapping(s.page, PROMPT, LEFT)
                try:
                    s.screenshot(out / f"bottom_row_{name.replace(' ', '_')}.png")
                except Exception as e:
                    found.setdefault("shots missed", []).append(f"{name}: {str(e).splitlines()[0]}")
            if pct == SIZES[0]:
                s.page.evaluate(BAIT)
                found["bait"] = overlapping(s.page, CHIP, "#overlap-bait")
        finally:
            s.close()
    (out / "bottom_row.json").write_text(json.dumps(found, indent=1), encoding="utf-8")
    return found


def test_the_check_finds_a_box_over_the_chip(rows):
    assert len(rows["bait"]) == 1 and "#overlap-bait" in rows["bait"][0], rows["bait"]


@pytest.mark.parametrize("comfortable", ["plain", "comfortable"])
@pytest.mark.parametrize("pct", SIZES)
def test_the_hint_card_and_frame_rate_chip_clear_each_other_and_the_rails(rows, pct, comfortable):
    name = f"{pct} {comfortable}"
    assert name in rows, f"the walk never reached {name}"
    assert rows[name] == [], f"{name}, shot in {out_dir()}:\n" + "\n".join(rows[name])

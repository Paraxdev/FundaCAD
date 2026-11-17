"""The Stress weak spot's readout stays in the part of the view no panel or card covers, in German, whose readout is long
enough to run under the Stress panel from a spot beside it, in the light and the dark theme."""

import pytest

from fundacad_harness import Session
from fundacad_harness.screens import out_dir, settled

pytestmark = [pytest.mark.browser]

BLOCK = "tools/harness/fixtures/block.json"
THEMES = {"light": "solarized-light", "dark": "fundacad"}
RUN_WAIT_MS = 240000

# The readout and every panel or card on its line, in window pixels.
READ = """() => {
  const box = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const pin = document.querySelector('.stress-weak-pin');
  const label = pin.getBoundingClientRect();
  const covers = [...document.querySelectorAll('#float-layer .float-left-stack > *, #float-layer .tool-rail, #float-layer .float-right > *, .measure-panel')]
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width && r.height && r.top < label.bottom && r.bottom > label.top);
  return {
    text: pin.textContent,
    label: box(label),
    panel: box(document.querySelector('.stress-panel').getBoundingClientRect()),
    covers: covers.map(box),
    window: innerWidth,
  };
}"""


@pytest.fixture(scope="module")
def shown():
    found = {}
    s = Session(viewport=(1400, 950))
    try:
        s.open_file(BLOCK)
        s.view("iso")
        for name in ("History", "Items"):
            s.panel(name, open=False)
        s.command("stress")
        s.page.get_by_role("button", name="Close Stress").wait_for()
        s.pick_face("front")
        s.page.locator(".stress-set-support").first.click()
        s.settle()
        s.pick_face("top")
        s.page.locator(".stress-set-load").first.click()
        s.settle()
        s.page.locator(".stress-force input").first.fill("100")
        s.page.keyboard.press("Enter")
        s.settle()
        s.page.evaluate("async () => (await import('/src/i18n/index.ts')).setLanguage('de')")
        settled(s)
        s.page.locator(".stress-run").click()
        s.page.locator(".stress-results").wait_for(timeout=RUN_WAIT_MS)
        s.page.locator(".stress-weak-pin").wait_for(timeout=RUN_WAIT_MS)
        for theme, id_ in THEMES.items():
            s.page.evaluate("async (t) => (await import('/src/ui/theme.ts')).setTheme(t)", id_)
            settled(s)
            found[theme] = s.page.evaluate(READ)
            s.page.screenshot(path=str(out_dir() / f"stress_weak_label_de_{theme}.png"))
    finally:
        s.close()
    return found


@pytest.mark.parametrize("theme", list(THEMES))
def test_the_weak_spot_readout_stays_clear_of_every_panel_and_card_in_german(shown, theme):
    got = shown[theme]
    label = got["label"]
    assert got["text"].startswith("Schwächste Stelle"), got
    # The panel shares the readout's line, so it could hide it.
    assert got["panel"]["t"] < label["b"] and got["panel"]["b"] > label["t"], got
    assert label["l"] >= 0 and label["r"] <= got["window"], got
    for c in got["covers"]:
        assert label["r"] <= c["l"] + 1 or label["l"] >= c["r"] - 1, got

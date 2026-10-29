import json

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import clipped_controls, cueless_scrollers, focus_stop, tab_walk
from fundacad_harness.screens import again, close_settings, open_example, open_settings, out_dir, show_home

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

# The two windows Tauri allows at 200 percent, laid out as setZoom does: 1280 by 800 and the 800 by 600 minimum.
LAYOUTS = {"640x400": (640, 400), "400x300": (400, 300)}
SCREENS = ("empty_workspace", "home", "example", "file_menu", "settings")
LONG_NAME = "Bracket assembly revision seven for the workshop final.funda"
FOLDED = ('"Model Workspace"', '"Render Workspace"')

BAIT = """() => {
  const wrap = document.createElement('div');
  wrap.id = 'reach-bait';
  wrap.innerHTML = '<button id="reach-under" style="position:fixed;z-index:2147483646;left:60px;top:60px;width:60px;height:24px">Under</button>'
    + '<div id="reach-over" style="position:fixed;z-index:2147483647;left:50px;top:50px;width:90px;height:50px;background:red"></div>'
    + '<div><div id="reach-hidden" style="position:fixed;left:200px;top:60px;width:60px;height:40px;overflow:auto;'
    + 'scrollbar-width:none"><div style="height:200px"></div></div></div>';
  document.body.append(wrap);
  document.getElementById('reach-under').focus();
}"""


def bait(s: Session) -> dict:
    """The walk's check on a covered control and the cue check on a hidden scrollbar, so neither passes vacuously."""
    s.page.evaluate(BAIT)
    seen = {"covered": focus_stop(s.page), "cueless": [c for c in cueless_scrollers(s.page) if "reach-hidden" in c]}
    s.page.evaluate("() => document.getElementById('reach-bait').remove()")
    return seen


def check(s: Session, found: dict, name: str, key: str = "Tab") -> None:
    s.page.wait_for_timeout(300)
    entry = {"static": clipped_controls(s.page), "cueless": cueless_scrollers(s.page)}
    if key == "Tab":
        s.page.evaluate("() => document.activeElement && document.activeElement.blur()")
    stops = tab_walk(s.page, key=key)
    entry["stops"] = [st["name"] for st in stops]
    entry["walk"] = [f"{st['name']}: {st['why']}" for st in stops if st["why"]]
    found[name] = entry
    try:
        s.screenshot(out_dir() / f"reach_{name.replace(' ', '_')}.png")
    except Exception as e:
        entry["shot"] = str(e).splitlines()[0]


@pytest.fixture(scope="module")
def reach():
    found: dict = {}
    state: dict = {}
    for lay, vp in LAYOUTS.items():
        s = Session(viewport=vp, scale=2)
        try:
            if not state:
                state.update(bait(s))
            check(s, found, f"{lay} empty_workspace")
            show_home(s)
            check(s, found, f"{lay} home")
            s.page.keyboard.press("Escape")
            s.settle()
            open_example(s)
            s.page.evaluate(f"() => {{ document.querySelector('#docname .docname-text').textContent = {LONG_NAME!r}; }}")
            check(s, found, f"{lay} example")
            again(s, lambda: s.page.locator("#menubar .menu-btn", has_text="File").click())
            s.page.locator(".ui-menu").wait_for()
            check(s, found, f"{lay} file_menu", key="ArrowDown")
            s.page.keyboard.press("Escape")
            open_settings(s, "Accessibility")
            check(s, found, f"{lay} settings")
            close_settings(s)
        finally:
            s.close()
    (out_dir() / "reach.json").write_text(json.dumps({"found": found, "state": state}, indent=1), encoding="utf-8")
    return {"found": found, "state": state}


def test_the_checks_find_a_covered_control_and_a_scroller_with_no_cue(reach):
    assert "covered by div#reach-over" in (reach["state"]["covered"] or {}).get("why", ""), reach["state"]
    assert len(reach["state"]["cueless"]) == 1, reach["state"]


@pytest.mark.parametrize("lay", sorted(LAYOUTS))
@pytest.mark.parametrize("screen", SCREENS)
def test_every_control_in_the_walk_is_whole_and_on_top(reach, lay, screen):
    name = f"{lay} {screen}"
    assert name in reach["found"], f"the walk never reached {name}"
    got = reach["found"][name]
    problems = got["static"] + got["cueless"] + got["walk"]
    assert got["stops"], f"{name}: the walk found no stop"
    assert problems == [], f"{name}, shot in {out_dir()}:\n" + "\n".join(problems)


def test_the_file_menu_holds_the_workspace_toggle_only_when_the_title_bar_folds(reach):
    def folded(lay):
        return [f for f in FOLDED if any(f in st for st in reach["found"][f"{lay} file_menu"]["stops"])]

    assert folded("400x300") == list(FOLDED)
    assert folded("640x400") == []

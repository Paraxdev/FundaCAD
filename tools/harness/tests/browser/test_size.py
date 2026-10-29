import json

import pytest

from fundacad_harness import Session
from fundacad_harness.a11y import fresh_page
from fundacad_harness.layout import clipped_controls
from fundacad_harness.screens import (
    THEMES,
    close_settings,
    open_example,
    open_settings,
    out_dir,
    pick,
    set_theme,
    settled,
    show_home,
)

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

SIZES = (100, 150)
WINDOW = (1366, 768)


def setting_path(s: Session) -> dict:
    """Interface size picked in Settings zooms the page, a reload keeps it and Ctrl+0 puts it back."""
    seen: dict = {}
    s.page.evaluate(
        "() => { const box = document.createElement('div'); box.id = 'size-bait';"
        " box.style.cssText = 'position:fixed;left:40px;top:40px;width:30px;height:20px;overflow:hidden';"
        " box.innerHTML = '<button style=\"width:120px;height:20px\">Bait</button>';"
        " document.body.append(box); }"
    )
    seen["bait"] = [line for line in clipped_controls(s.page) if '"Bait"' in line]
    s.page.evaluate("() => document.getElementById('size-bait').remove()")
    open_settings(s, "Accessibility")
    pick(s, "#prefs-interface-size", "150%")
    seen["zoom"] = s.page.evaluate("() => document.documentElement.style.zoom")
    fresh_page(s, lambda _s: None)
    s.settle()
    settled(s)
    seen["zoom_after_reload"] = s.page.evaluate("() => document.documentElement.style.zoom")
    s.page.keyboard.press("Control+0")
    seen["zoom_after_reset"] = s.page.evaluate("() => document.documentElement.style.zoom")
    return seen


@pytest.fixture(scope="module")
def walk():
    """Each size in its own session, as Tauri's setZoom shows it: a CSS viewport of the window over the size, at a
    device scale of the size. CSS zoom on the root, the path outside Tauri, also scales vh, so it cannot stand in."""
    out = out_dir()
    found: dict[str, list[str]] = {}
    state: dict = {}

    def check(s: Session, name: str) -> None:
        found[name] = clipped_controls(s.page)
        try:
            s.screenshot(out / f"{name.replace(' ', '_')}.png")
        except Exception as e:
            # A shot only helps read a failure, SwiftShader under load can take past its 30 s.
            state.setdefault("shots_missed", []).append(f"{name}: {str(e).splitlines()[0]}")

    for pct in SIZES:
        z = pct / 100
        s = Session(viewport=(round(WINDOW[0] / z), round(WINDOW[1] / z)), scale=z)
        try:
            if pct == 100:
                state.update(setting_path(s))
            for theme in THEMES:
                set_theme(s, theme)
                check(s, f"{theme} {pct} settings")
                close_settings(s)
                check(s, f"{theme} {pct} empty_workspace")
                show_home(s)
                check(s, f"{theme} {pct} home")
                s.page.keyboard.press("Escape")
                s.settle()
            open_example(s)
            for theme in THEMES:
                set_theme(s, theme)
                close_settings(s)
                check(s, f"{theme} {pct} example")
        finally:
            s.close()
    (out / "clipped.json").write_text(json.dumps({"found": found, "state": state}, indent=1), encoding="utf-8")
    return {"found": found, "state": state}


def test_the_check_finds_a_control_its_box_cuts(walk):
    assert len(walk["state"].get("bait", [])) == 1, walk["state"]


@pytest.mark.parametrize("theme", sorted(THEMES))
@pytest.mark.parametrize("pct", SIZES)
@pytest.mark.parametrize("screen", ["empty_workspace", "home", "example", "settings"])
def test_every_control_is_whole_on_screen(walk, theme, pct, screen):
    name = f"{theme} {pct} {screen}"
    assert name in walk["found"], f"the walk never reached {name}"
    assert walk["found"][name] == [], f"{name}, shot in {out_dir()}:\n" + "\n".join(walk["found"][name])


def test_the_interface_size_zooms_the_page_and_survives_a_reload(walk):
    assert walk["state"]["zoom"] == "1.5"
    assert walk["state"]["zoom_after_reload"] == "1.5"
    assert walk["state"]["zoom_after_reset"] == ""

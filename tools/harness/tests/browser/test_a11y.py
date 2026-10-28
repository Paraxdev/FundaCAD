import json
import os
import re
import tempfile
import warnings
from pathlib import Path

import pytest
from playwright.sync_api import expect

from fundacad_harness import Session
from fundacad_harness.a11y import (
    axe_violations,
    counts,
    lowered_baseline,
    over_baseline,
    read_baseline,
    under_baseline,
    write_baseline,
)

pytestmark = [pytest.mark.browser, pytest.mark.smoke, pytest.mark.a11y]

BASELINE = Path(__file__).with_name("axe_baseline.json")
ALLOWED = read_baseline(BASELINE)
ARIA_DIR = Path(__file__).with_name("aria")
ARIA = {"empty_workspace": "shell.yml", "home": "home.yml", "settings": "settings.yml"}
# A template naming a node the page lacks must fail, so the templates can never match vacuously.
ARIA_NEGATIVE = ("empty_workspace", '- dialog "No such dialog"')


def out_dir() -> Path:
    out = Path(os.environ.get("FUNDACAD_A11Y_OUT") or Path(tempfile.gettempdir()) / "fundacad-a11y")
    out.mkdir(parents=True, exist_ok=True)
    return out


def _settled(s: Session) -> None:
    # Panels and dialogs fade in, and axe reads a half faded node as low contrast.
    s.page.wait_for_timeout(400)


def show_empty_workspace(s):
    s.settle()


def show_home(s):
    s.menu("File/Home")
    s.page.locator('.home-example:has-text("Box with a lid")').wait_for()


def show_example(s):
    s.page.evaluate(
        "() => { window.__a11yOpened = false;"
        " const off = window.store.onOpen(() => { window.__a11yOpened = true; off(); }); }"
    )
    s.page.click('.home-example:has-text("Box with a lid")')
    s.page.wait_for_function(
        "() => window.__a11yOpened && window.store.document.features.length > 0", timeout=60000, polling=100
    )
    s.settle()


def show_sketch(s):
    s.tool("Sketch")


def show_extrude(s):
    s.open_file("tools/harness/fixtures/whole_sketch_extrude.json")
    s.view("fit")
    s.click("feature:e", double=True)
    s.settle()


def show_settings(s):
    s.panel("settings")
    s.page.get_by_role("dialog", name="Preferences").wait_for()


def show_render(s):
    s.page.click('[data-workspace="render"]')
    s.page.locator("#renderdock").wait_for()


def show_stress(s):
    s.command("stress")
    s.page.get_by_role("button", name="Close Stress").wait_for()


def show_palette(s):
    s.page.keyboard.press("Control+F")
    s.page.locator(".cmdk-list").wait_for()


def show_confirm(s):
    s.press("Escape")
    s.click("feature:e2")
    s.press("Delete")
    s.page.keyboard.press("Control+N")
    s.page.get_by_role("dialog", name=re.compile("^Discard unsaved changes")).wait_for()


def aria_mismatch(s: Session, template: str, timeout: float = 5000) -> str:
    try:
        expect(s.page.locator("body")).to_match_aria_snapshot(template, timeout=timeout)
    except AssertionError as e:
        return str(e) or "the aria tree does not match"
    return ""


def escape_twice(s):
    s.page.keyboard.press("Escape")
    s.page.keyboard.press("Escape")


def leave_settings(s):
    s.panel("settings", open=False)


def leave_render(s):
    s.page.click('[data-workspace="model"]')
    s.page.locator("#renderdock").wait_for(state="detached")


def escape(s):
    s.page.keyboard.press("Escape")


def stay(s):
    pass


FLOWS = (
    ("empty_workspace", show_empty_workspace, stay),
    ("home", show_home, stay),
    ("example", show_example, stay),
    ("sketch", show_sketch, escape_twice),
    ("extrude", show_extrude, escape_twice),
    ("settings", show_settings, leave_settings),
    ("render", show_render, leave_render),
    ("stress", show_stress, escape),
    ("palette", show_palette, escape),
    ("confirm", show_confirm, escape),
)
SCREENS = [name for name, _, _ in FLOWS]


@pytest.fixture(scope="module")
def scans():
    """Walks every screen once in one session, so a flow that breaks only fails its own screen."""
    out = out_dir()
    results: dict[str, list[dict] | str] = {}
    aria: dict[str, str] = {}
    s = Session(viewport=(1400, 900))
    try:
        for name, show, leave in FLOWS:
            try:
                show(s)
                _settled(s)
                (out / f"aria_{name}.yml").write_text(s.page.locator("body").aria_snapshot(), encoding="utf-8")
                if name in ARIA:
                    aria[name] = aria_mismatch(s, (ARIA_DIR / ARIA[name]).read_text(encoding="utf-8"))
                if name == ARIA_NEGATIVE[0]:
                    aria["negative"] = aria_mismatch(s, ARIA_NEGATIVE[1], timeout=500)
                found = axe_violations(s.page)
                results[name] = found
                (out / f"axe_{name}.json").write_text(json.dumps(found, indent=1), encoding="utf-8")
            except Exception as e:
                results[name] = f"{type(e).__name__}: {e}"
                aria.setdefault(name, results[name])
            finally:
                try:
                    leave(s)
                except Exception:
                    pass
    finally:
        s.close()
    if os.environ.get("FUNDACAD_AXE_LOWER") == "1":
        ran = {name: counts(found) for name, found in results.items() if isinstance(found, list)}
        write_baseline(BASELINE, lowered_baseline(ran, ALLOWED))
    return {"axe": results, "aria": aria}


@pytest.mark.parametrize("screen", SCREENS)
def test_a_screen_has_no_axe_violation_beyond_its_baseline(scans, screen):
    found = scans["axe"][screen]
    assert not isinstance(found, str), f"{screen} did not open: {found}"
    allowed = ALLOWED.get(screen, {})
    for note in under_baseline(counts(found), allowed):
        warnings.warn(f"{screen}: {note}", stacklevel=1)
    problems = over_baseline(counts(found), allowed)
    assert not problems, (
        f"new axe violations on {screen}, the nodes are in {out_dir() / f'axe_{screen}.json'}:\n" + "\n".join(problems)
    )


def test_the_baseline_names_only_screens_the_smoke_test_walks():
    assert sorted(set(ALLOWED) - set(SCREENS)) == []


@pytest.mark.parametrize("screen", sorted(ARIA))
def test_a_screen_keeps_the_nodes_of_its_aria_template(scans, screen):
    problem = scans["aria"].get(screen, "the walk never reached this screen")
    assert not problem, (
        f"{screen} no longer matches aria/{ARIA[screen]}, the full tree is in {out_dir() / f'aria_{screen}.yml'}. "
        f"Update the template only when the change is meant:\n{problem}"
    )


def test_an_aria_template_naming_a_missing_node_fails(scans):
    problem = scans["aria"].get("negative")
    assert problem is not None, f"the walk never reached {ARIA_NEGATIVE[0]}"
    assert problem, "a template with a node the page lacks matched"


def test_every_aria_template_is_checked_on_a_walked_screen():
    assert sorted(set(ARIA) - set(SCREENS)) == []
    assert sorted(p.name for p in ARIA_DIR.glob("*.yml")) == sorted(ARIA.values())

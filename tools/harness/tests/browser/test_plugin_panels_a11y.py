import json
import os
import tempfile
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.a11y import AXE_TAGS, load_axe
from fundacad_harness.screens import close_settings, set_theme

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

# A box sized by a few tunable parameters, and a free shaft beside it for a thread.
DOC = {
    "version": 10,
    "parameters": {"width": 30, "height": 10, "lid": 1, "tilt": 15, "size": 10, "wall": 2},
    "paramDefs": {
        "width": {
            "expr": "30",
            "value": 30,
            "unit": "mm",
            "group": "g1",
            "control": {"kind": "slider", "min": 20, "max": 60},
        },
        "height": {
            "expr": "10",
            "value": 10,
            "unit": "mm",
            "group": "g1",
            "control": {"kind": "number", "min": 4, "step": 1},
        },
        "lid": {"expr": "1", "value": 1, "unit": "count", "group": "g1", "control": {"kind": "toggle"}},
        "tilt": {"expr": "15", "value": 15, "unit": "deg"},
        "size": {
            "expr": "10",
            "value": 10,
            "unit": "mm",
            "control": {
                "kind": "choice",
                "choices": [{"label": "Small", "value": 10}, {"label": "Large", "value": 30}],
            },
        },
        "wall": {"expr": "height / 5", "value": 2, "unit": "mm"},
    },
    "paramExtras": {
        "groups": [{"id": "g1", "name": "Body"}],
        "configurations": [{"id": "c1", "name": "Tall", "values": {"height": "20"}}],
        "checks": [{"id": "k1", "expr": "wall >= 3", "message": "wall under 3 mm is fragile", "level": "warning"}],
    },
    "features": [
        {"id": "b", "type": "box", "length": "width", "width": 30, "height": "height"},
        {"id": "s", "type": "cylinder", "radius": 3, "height": 16, "operation": "new"},
        {"id": "ms", "type": "move", "dx": 40, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},
    ],
}

RUN = (
    "([sel, tags]) => axe.run(document.querySelector(sel), {runOnly: {type: 'tag', values: tags},"
    " resultTypes: ['violations']}).then(r => r.violations.map(v => ({id: v.id, impact: v.impact, help: v.help,"
    " nodes: v.nodes.map(n => ({target: n.target, html: n.html, summary: n.failureSummary}))})))"
)

SELECT_FACE = """(pt) => {
  window.__fundacad.selectFeature(null);
  const id = window.viewport.faceIdNear(pt);
  if (id != null) window.viewport.selectFaces([id]);
  return id;
}"""

PARAMETERS = '[data-tree-item]:has(.xp-head)'
SETUP = ".xp-setup-panel"
LIBRARY = ".scr-panel"
THREAD = "[data-testid=thread-panel]"
TEXTURE = ".ui-panel:has([data-panel=texture])"
PANELS = ("parameters", "setup", "library", "custom", "thread", "texture")
THEMES = ("dark", "light")


def out_dir() -> Path:
    out = Path(os.environ.get("FUNDACAD_A11Y_OUT") or Path(tempfile.gettempdir()) / "fundacad-a11y")
    out.mkdir(parents=True, exist_ok=True)
    return out


def load(s: Session) -> None:
    s.page.evaluate(
        "async (d) => { window.store.load(JSON.stringify(d)); await window.store.rebuildNow();"
        " window.viewport.setStandardView('iso'); window.viewport.fitView(); }",
        DOC,
    )
    s.page.wait_for_function(
        "() => (window.store.buildState.result?.bodies ?? []).length === 2", timeout=120000, polling=200
    )
    s.settle()


def closed(s: Session, sel: str) -> None:
    for _ in range(3):
        if not s.page.locator(sel).count():
            return
        s.page.keyboard.press("Escape")
        s.page.wait_for_timeout(300)
    s.page.locator(sel).wait_for(state="detached", timeout=5000)


def open_parameters(s: Session) -> str:
    s.page.locator(PARAMETERS).wait_for()
    return PARAMETERS


def open_setup(s: Session) -> str:
    s.page.locator(".xp-setup").click()
    s.page.locator(SETUP).wait_for()
    return SETUP


def open_library(s: Session) -> str:
    s.page.evaluate("() => window.__fundacad.handleAction('fasteners')")
    s.page.locator(".scr-library").wait_for()
    # The panel keeps its tab and an open form between openings.
    if s.page.locator(".scr-form .scr-cancel").count():
        s.page.locator(".scr-form .scr-cancel").click()
    s.page.locator(".scr-tab-catalogue").click()
    return LIBRARY


def open_custom(s: Session) -> str:
    s.page.locator(".scr-tab-custom").click()
    s.page.locator(".scr-new").click()
    s.page.locator(".scr-form").wait_for()
    return LIBRARY


def open_thread(s: Session) -> str:
    assert s.page.evaluate(SELECT_FACE, [43, 0, 0]) is not None, "no shaft face near the point"
    s.page.evaluate("() => window.__fundacad.handleAction('standardThread')")
    s.page.locator(THREAD).wait_for(timeout=15000)
    return THREAD


def open_texture(s: Session) -> str:
    assert s.page.evaluate(SELECT_FACE, [0, 0, 5]) is not None, "no top face near the point"
    s.page.evaluate("() => window.__fundacad.handleAction('texture')")
    s.page.locator("[data-panel=texture]").wait_for(timeout=15000)
    return TEXTURE


def scan(s: Session, theme: str, name: str, sel: str) -> list[dict]:
    # Panels fade in, and axe reads a half faded node as low contrast.
    s.page.wait_for_timeout(500)
    load_axe(s.page)
    found = s.page.evaluate(RUN, [sel, list(AXE_TAGS)])
    out = out_dir()
    (out / f"axe_plugin_{name}_{theme}.json").write_text(json.dumps(found, indent=1), encoding="utf-8")
    s.page.locator(sel).screenshot(path=str(out / f"plugin_{name}_{theme}.png"))
    return found


@pytest.fixture(scope="module")
def scans():
    results: dict[tuple[str, str], object] = {}
    s = Session(viewport=(1400, 900))
    try:
        load(s)
        for theme in THEMES:
            if theme == "light":
                set_theme(s, "light")
                close_settings(s)
            steps = (
                ("parameters", open_parameters, None),
                ("setup", open_setup, SETUP),
                ("library", open_library, None),
                ("custom", open_custom, LIBRARY),
                ("thread", open_thread, THREAD),
                ("texture", open_texture, "[data-panel=texture]"),
            )
            for name, show, leave in steps:
                try:
                    results[(theme, name)] = scan(s, theme, name, show(s))
                except Exception as e:
                    results[(theme, name)] = f"{type(e).__name__}: {e}"
                    s.page.keyboard.press("Escape")
                if leave:
                    closed(s, leave)
                s.settle()
    finally:
        s.close()
    return results


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("panel", PANELS)
def test_a_rebuilt_plugin_panel_has_no_axe_violation(scans, panel, theme):
    found = scans[(theme, panel)]
    assert not isinstance(found, str), f"{panel} did not open in {theme}: {found}"
    lines = [f"{v['id']} ({len(v['nodes'])}): {v['help']}" for v in found]
    where = out_dir() / f"axe_plugin_{panel}_{theme}.json"
    assert not lines, f"{panel} in {theme}, the nodes are in {where}:\n" + "\n".join(lines)

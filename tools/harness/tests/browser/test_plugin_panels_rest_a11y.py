import json
import os
import tempfile
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.a11y import AXE_TAGS, load_axe
from fundacad_harness.screens import close_settings, open_settings, pick, set_theme

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

LEDGE = Path(__file__).resolve().parents[2] / "fixtures" / "overhang_ledge.json"

RUN = (
    "([sel, tags]) => axe.run(document.querySelector(sel), {runOnly: {type: 'tag', values: tags},"
    " resultTypes: ['violations']}).then(r => r.violations.map(v => ({id: v.id, impact: v.impact, help: v.help,"
    " nodes: v.nodes.map(n => ({target: n.target, html: n.html, summary: n.failureSummary}))})))"
)

# Plugins that talk to hardware or a network are drawn against this stand in for the app's native commands, so
# nothing leaves the page: one printer at a made up host answers a probe and a filament query, and a snapshot is a
# small picture that is served or refused as the test says.
FAKE_NATIVE = """() => {
  const registry = JSON.stringify([
    { id: 'u1', name: 'Test printer', host: 'printer.invalid', port: 7125, kind: 'MoonrakerU1', webcam_port: 80 },
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const g = canvas.getContext('2d');
  g.fillStyle = '#d9d2c5';
  g.fillRect(0, 0, 160, 90);
  g.fillStyle = '#3b6ea5';
  g.fillRect(40, 20, 80, 50);
  window.__snapshot = { serve: true, base64: canvas.toDataURL('image/jpeg').split(',')[1] };
  const json = (value) => ({ status: 200, contentType: 'application/json', text: JSON.stringify(value), base64: null });
  const query = {
    result: {
      status: {
        print_task_config: {
          filament_vendor: ['Polymaker', 'Prusament'],
          filament_type: ['PLA', 'PETG'],
          filament_sub_type: ['', ''],
          filament_color_rgba: ['FF8800FF', '3B6EA5FF'],
          filament_exist: [true, true],
        },
      },
    },
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (cmd, args) => {
      if (cmd === 'plugin_data_adopt') return false;
      if (cmd === 'plugin_data_read') return args.name === 'printers.json' ? registry : null;
      if (cmd === 'plugin_data_write' || cmd === 'plugin_set_disabled') return null;
      if (cmd.startsWith('plugin:')) return null;
      if (cmd !== 'plugin_local_request') throw `no ${cmd} in this test`;
      const url = args.request.url;
      if (url.includes('/server/info')) return json({ result: { klippy_connected: true, klippy_state: 'ready', moonraker_version: 'test' } });
      if (url.includes('/webcam/')) {
        if (!window.__snapshot.serve) return { status: 503, contentType: null, text: null, base64: null };
        return { status: 200, contentType: 'image/jpeg', text: null, base64: window.__snapshot.base64 };
      }
      return json(query);
    },
  };
}"""

MAKE_PNG = """async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const g = canvas.getContext('2d');
  g.fillStyle = '#c9b99a';
  g.fillRect(0, 0, 64, 48);
  g.fillStyle = '#2f5d8a';
  g.fillRect(12, 10, 40, 28);
  const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
  const state = await import('/plugins/FundaCAD.ReferenceImages/state.ts');
  return await state.tool.value.add(new File([blob], 'drawing.png', { type: 'image/png' }), 'XY', null);
}"""
DROP_IMAGE = """async () => {
  const state = await import('/plugins/FundaCAD.ReferenceImages/state.ts');
  state.selected.value = null;
  window.store.setReferenceImages([]);
}"""

SET_CAMERA = """async () => {
  const state = await import('/plugins/FundaCAD.Printing/state.ts');
  state.cameraPanel.value = 'u1';
}"""
CLEAR_CAMERA = """async () => {
  const state = await import('/plugins/FundaCAD.Printing/state.ts');
  state.cameraPanel.value = null;
}"""

SHOW_PILL = """async () => {
  const status = await import('/plugins/FundaCAD.Printing/printStatus.ts');
  const print = status.usePrintStatusStore();
  print.text = 'Printing drawing.gcode, 42%';
  print.onClick = () => {};
}"""
HIDE_PILL = """async () => {
  const status = await import('/plugins/FundaCAD.Printing/printStatus.ts');
  const print = status.usePrintStatusStore();
  print.text = null;
  print.onClick = null;
}"""

ASK_LINK = """async () => {
  const dialog = await import('/plugins/FundaCAD.Onshape/dialog.ts');
  window.__link = dialog.askForLink(true);
}"""
ASK_BED = """async () => {
  const dialog = await import('/plugins/FundaCAD.PrintToolbox/customBedDialog.ts');
  window.__bed = dialog.openCustomBedDialog([220, 220, 250]);
}"""
ASK_FILAMENTS = """async () => {
  const state = await import('/plugins/FundaCAD.Printing/state.ts');
  window.__map = state.openFilamentMapping(
    [
      { index: 0, name: 'Orange PLA', color: '#ff8800', material: 'PLA' },
      { index: 1, name: 'Blue PETG', color: '#3b6ea5', material: 'PETG' },
    ],
    [
      { index: 0, vendor: 'Polymaker', material: 'PLA', sub_type: '', color: '#ff8800', present: true },
      { index: 1, vendor: 'Prusament', material: 'PETG', sub_type: '', color: '#3b6ea5', present: true },
      { index: 2, vendor: '', material: '', sub_type: '', color: '#808080', present: false },
    ],
  );
}"""
ANSWER_FILAMENTS = """async () => {
  const state = await import('/plugins/FundaCAD.Printing/state.ts');
  state.filamentReq.value?.resolve(null);
}"""

BROWSER = "#browser"
NODE_PANEL = ".ui-panel:has([data-panel=node-body])"
IMAGE_PANEL = ".ref-image-window"
CAMERA = ".ui-panel:has(.camera-frame)"
PRINTABILITY = ".ui-panel:has(.printability-panel), .printability-panel"
THEMES = ("dark", "light")

# Every panel opens: the hardware and network plugins draw from their settings or their own request objects, and
# their native calls are answered by FAKE_NATIVE, so nothing is left out.
PANELS = (
    "gamepad",
    "navigation",
    "spacemouse",
    "onshape_keys",
    "printlook_prefs",
    "layer_lines",
    "palette",
    "reference_image",
    "reference_items",
    "onshape_link",
    "custom_bed",
    "printability",
    "node_body",
    "filament_mapping",
    "camera",
    "camera_offline",
    "print_pill",
)


def load(s: Session) -> None:
    # Through the store, as the File menu's chooser is the system's once the native stand in is there.
    s.page.evaluate(
        "async (text) => { window.store.load(text); await window.store.rebuildNow();"
        " window.viewport.setStandardView('iso'); window.viewport.fitView(); }",
        LEDGE.read_text(encoding="utf-8"),
    )
    s.page.wait_for_function(
        "() => (window.store.buildState.result?.bodies ?? []).length > 0", timeout=120000, polling=200
    )
    s.settle()


def remount_palette(s: Session) -> None:
    # The palette asks for the printer's service once, when it mounts, and the two plugins start in no fixed order.
    # Filtering the Items to one kind and back mounts it again with both running.
    pick(s, "#browser-filter", "Sketches")
    pick(s, "#browser-filter", "All items")
    s.settle()


def out_dir() -> Path:
    out = Path(os.environ.get("FUNDACAD_A11Y_OUT") or Path(tempfile.gettempdir()) / "fundacad-a11y")
    out.mkdir(parents=True, exist_ok=True)
    return out


def gone(s: Session, sel: str) -> None:
    for _ in range(3):
        if not s.page.locator(sel).count():
            return
        s.page.keyboard.press("Escape")
        s.page.wait_for_timeout(300)
    s.page.locator(sel).wait_for(state="detached", timeout=5000)


def plugin_settings(plugin: str):
    """Opens a plugin's Settings row in Preferences and returns its selector and a step that leaves it."""
    sel = f'[data-plugin-settings="{plugin}"]'

    def show(s: Session) -> str:
        open_settings(s, "Plugins")
        row = s.page.locator(f'[data-plugin-row="{plugin}"]')
        row.wait_for()
        row.locator("[data-plugin-settings-toggle]").click()
        s.page.locator(sel).wait_for()
        return sel

    def leave(s: Session) -> None:
        close_settings(s)

    return show, leave


def open_gamepad(s: Session) -> str:
    return plugin_settings("FundaCAD.Gamepad")[0](s)


def open_navigation(s: Session) -> str:
    sel = plugin_settings("FundaCAD.Navigation")[0](s)
    radial = s.page.get_by_role("checkbox", name="Radial menu", exact=True)
    if not radial.is_checked():
        radial.click()
    s.page.locator(f"{sel} [data-nav-bindings]").wait_for()
    s.page.evaluate(
        "(sel) => document.querySelectorAll(sel + ' details').forEach((d) => { d.open = true; })", sel
    )
    # A key the app keeps for itself is refused, which draws the panel's alert row.
    s.page.locator(f"{sel} [data-nav-key]").first.click()
    s.page.keyboard.press("Control+z")
    s.page.locator(f'{sel} [role="alert"]').first.wait_for()
    return sel


def open_spacemouse(s: Session) -> str:
    sel = plugin_settings("FundaCAD.SpaceMouse")[0](s)
    s.page.locator(f"{sel} [data-spacemouse-section]").wait_for(timeout=15000)
    return sel


def open_onshape_keys(s: Session) -> str:
    return plugin_settings("FundaCAD.Onshape")[0](s)


def open_printlook_prefs(s: Session) -> str:
    return plugin_settings("FundaCAD.PrintLook")[0](s)


def open_layer_lines(s: Session) -> str:
    s.page.locator('[data-workspace="render"]').click()
    s.page.get_by_role("tab", name="Environment", exact=True).click()
    sel = "[data-render-section$=layer-lines]"
    s.page.locator(sel).wait_for()
    # The slider, direction and depth only show while the lines are on.
    lines = s.page.locator(sel).get_by_role("checkbox", name="Layer lines")
    if not lines.is_checked():
        lines.click()
    s.page.locator(sel).get_by_role("slider", name="Layer height").wait_for()
    return sel


def leave_layer_lines(s: Session) -> None:
    s.page.locator('[data-workspace="model"]').click()
    s.settle()


def open_palette(s: Session) -> str:
    s.page.locator(".pal-sync").wait_for(timeout=20000)
    return BROWSER


def open_reference_image(s: Session) -> str:
    assert s.page.evaluate(MAKE_PNG) is not None, "the reference image was not added"
    s.page.locator("[data-panel=reference-image]").wait_for()
    return IMAGE_PANEL


def open_reference_items(s: Session) -> str:
    s.page.locator("[data-ref-image]").wait_for()
    return BROWSER


def open_onshape_link(s: Session) -> str:
    s.page.evaluate(ASK_LINK)
    s.page.locator(".onshape-link-dialog").wait_for()
    # Confirming with nothing typed is refused, which draws the dialog's alert row.
    s.page.locator("[data-testid=onshape-link]").press("Enter")
    s.page.locator('.onshape-link-dialog [role="alert"]').first.wait_for()
    return ".onshape-link-dialog"


def open_custom_bed(s: Session) -> str:
    s.page.evaluate(ASK_BED)
    s.page.locator(".bed-custom-dialog").wait_for()
    return ".bed-custom-dialog"


def open_printability(s: Session) -> str:
    s.page.evaluate("() => window.__fundacad.handleAction('print-printability')")
    s.page.locator(".printability-panel").wait_for()
    s.page.locator(".printability-run").click()
    s.page.locator(".printability-header").wait_for()
    return PRINTABILITY


def leave_printability(s: Session) -> None:
    s.page.locator(".printability-close").click()
    s.page.locator(".printability-panel").wait_for(state="detached")


def open_node_body(s: Session) -> str:
    s.page.evaluate("() => window.__fundacad.handleAction('nodeBody')")
    s.page.locator("[data-panel=node-body]").wait_for(timeout=15000)
    # Three clicks in the view, each extending the chain from the node before, left of where the panel sits.
    middle = s.page.evaluate(
        "() => { const r = window.viewport.domElement.getBoundingClientRect();"
        " return {x: r.x + r.width / 2, y: r.y + r.height / 2}; }"
    )
    for dx, dy in ((-250, 40), (-140, 120), (-20, 200)):
        s.page.mouse.click(middle["x"] + dx, middle["y"] + dy)
        s.settle()
    s.page.locator("[data-node=n3]").wait_for()
    return NODE_PANEL


def leave_node_body(s: Session) -> None:
    gone(s, "[data-panel=node-body]")


def open_filament_mapping(s: Session) -> str:
    s.page.evaluate(ASK_FILAMENTS)
    s.page.locator(".print-map-card").wait_for()
    return ".print-map-card"


def open_camera(s: Session) -> str:
    s.page.evaluate("() => { window.__snapshot.serve = true; }")
    s.page.evaluate(SET_CAMERA)
    s.page.wait_for_function(
        "() => document.querySelector('.camera-frame')?.src.startsWith('data:image/jpeg')", timeout=15000
    )
    return CAMERA


def open_camera_offline(s: Session) -> str:
    s.page.evaluate("() => { window.__snapshot.serve = false; }")
    s.page.evaluate(SET_CAMERA)
    s.page.locator(".camera-offline").wait_for(timeout=20000)
    return CAMERA


def leave_camera(s: Session) -> None:
    s.page.evaluate(CLEAR_CAMERA)
    s.page.locator(".camera-frame").wait_for(state="detached")


def open_print_pill(s: Session) -> str:
    s.page.evaluate(SHOW_PILL)
    s.page.locator(".print-status-pill").wait_for()
    return ".print-status-pill"


def leave_print_pill(s: Session) -> None:
    s.page.evaluate(HIDE_PILL)
    s.page.locator(".print-status-pill").wait_for(state="detached")


def scan(s: Session, theme: str, name: str, sel: str) -> list[dict]:
    # Panels fade in, and axe reads a half faded node as low contrast.
    s.page.wait_for_timeout(500)
    load_axe(s.page)
    found = s.page.evaluate(RUN, [sel, list(AXE_TAGS)])
    out = out_dir()
    (out / f"axe_plugin_{name}_{theme}.json").write_text(json.dumps(found, indent=1), encoding="utf-8")
    s.page.locator(sel).first.screenshot(path=str(out / f"plugin_{name}_{theme}.png"))
    return found


def leave_settings(s: Session) -> None:
    close_settings(s)


def drop_dialog(sel: str, answer: str):
    def leave(s: Session) -> None:
        s.page.evaluate(answer)
        s.page.locator(sel).wait_for(state="detached")

    return leave


def leave_by_escape(sel: str):
    def leave(s: Session) -> None:
        gone(s, sel)

    return leave


def drop_image(s: Session) -> None:
    s.page.evaluate(DROP_IMAGE)
    s.page.locator("[data-ref-image]").wait_for(state="detached")


def keep(s: Session) -> None:
    return None


def walk(s: Session) -> dict[tuple[str, str], object]:
    results: dict[tuple[str, str], object] = {}
    # Before the model opens, so the palette's one probe of the printer finds the stand in.
    s.page.evaluate(FAKE_NATIVE)
    load(s)
    remount_palette(s)
    for theme in THEMES:
        if theme == "light":
            set_theme(s, "light")
            close_settings(s)
        steps = (
            ("gamepad", open_gamepad, leave_settings),
            ("navigation", open_navigation, leave_settings),
            ("spacemouse", open_spacemouse, leave_settings),
            ("onshape_keys", open_onshape_keys, leave_settings),
            ("printlook_prefs", open_printlook_prefs, leave_settings),
            ("layer_lines", open_layer_lines, leave_layer_lines),
            ("palette", open_palette, keep),
            ("reference_image", open_reference_image, keep),
            ("reference_items", open_reference_items, drop_image),
            ("onshape_link", open_onshape_link, leave_by_escape(".onshape-link-dialog")),
            ("custom_bed", open_custom_bed, leave_by_escape(".bed-custom-dialog")),
            ("printability", open_printability, leave_printability),
            ("node_body", open_node_body, leave_node_body),
            ("filament_mapping", open_filament_mapping, drop_dialog(".print-map-card", ANSWER_FILAMENTS)),
            ("camera", open_camera, leave_camera),
            ("camera_offline", open_camera_offline, leave_camera),
            ("print_pill", open_print_pill, leave_print_pill),
        )
        for name, show, leave in steps:
            try:
                results[(theme, name)] = scan(s, theme, name, show(s))
            except Exception as e:
                results[(theme, name)] = f"{type(e).__name__}: {e}"
                s.page.keyboard.press("Escape")
            try:
                leave(s)
            except Exception as e:
                results.setdefault((theme, f"{name}:leave"), f"{type(e).__name__}: {e}")
            s.settle()
    return results


@pytest.fixture(scope="module")
def scans():
    s = Session(viewport=(1400, 900))
    try:
        return walk(s)
    finally:
        s.close()


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("panel", PANELS)
def test_a_rebuilt_plugin_panel_has_no_axe_violation(scans, panel, theme):
    found = scans[(theme, panel)]
    assert not isinstance(found, str), f"{panel} did not open in {theme}: {found}"
    lines = [f"{v['id']} ({len(v['nodes'])}): {v['help']}" for v in found]
    where = out_dir() / f"axe_plugin_{panel}_{theme}.json"
    assert not lines, f"{panel} in {theme}, the nodes are in {where}:\n" + "\n".join(lines)

"""A handle drag let go over the value box, not the canvas, still ends, so a Save right after writes what it shows."""

import json
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.screens import out_dir

pytestmark = [pytest.mark.browser]

BLOCK = "tools/harness/fixtures/block.json"
TOOL = "() => ({ dragging: window.edgeFeature.dragging, pending: window.edgeFeature.pending })"
FEATURES = "() => window.store.document.features.map((f) => [f.type, f.radius ?? null])"
BOX = "() => { const r = document.querySelector('.dim-input').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }"
UNDER = "([x, y]) => document.elementFromPoint(x, y)?.closest('canvas') ? 'canvas' : 'overlay'"


@pytest.fixture(scope="module")
def s():
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        yield session
    finally:
        session.close()


def drag_handle(s: Session, mm: float, onto_value_box: bool) -> None:
    for _ in range(3):
        s.press("Escape")
    s.open_file(BLOCK, discard=True)
    s.view("iso")
    s.pick_edge("between top front")
    s.tool("Fillet")
    s.settle()
    h = s.call("handlePoint", name=s.call("handles")[0].split(" ")[0])
    dx, dy = h["dir"]
    px = mm * h["pxPerMm"]
    m = s.page.mouse
    m.move(h["x"], h["y"], steps=4)
    s.page.wait_for_timeout(60)
    m.down()
    for i in range(1, 9):
        m.move(h["x"] + dx * px * i / 8, h["y"] + dy * px * i / 8)
    if onto_value_box:
        s.page.wait_for_timeout(200)
        x, y = s.page.evaluate(BOX)
        assert s.page.evaluate(UNDER, [x, y]) == "overlay"
        m.move(x, y, steps=4)
    m.up()


def saves_the_fillet(s: Session, name: str) -> None:
    s.page.wait_for_timeout(300)
    assert s.page.evaluate(TOOL) == {"dragging": False, "pending": True}
    out = out_dir() / f"{name}.funda"
    with s.page.expect_download(timeout=60000) as dl:
        s.page.keyboard.press("Control+S")
    dl.value.save_as(out)
    s.settle()
    s.screenshot(str(out.with_suffix(".png")))

    shown = [f for f in s.page.evaluate(FEATURES) if f[0] == "fillet"]
    assert len(shown) == 1 and shown[0][1] > 0
    doc = json.loads(Path(out).read_text(encoding="utf-8"))
    saved = [(f["type"], f.get("radius")) for f in doc.get("document", doc)["features"]]
    assert ("fillet", shown[0][1]) in saved
    assert s.status(raw=True).get("tool") is None


def test_a_fillet_drag_let_go_over_the_value_box_ends_and_saves(s: Session) -> None:
    drag_handle(s, 6, onto_value_box=True)
    saves_the_fillet(s, "drag_release_on_value_box")


def test_a_long_fillet_drag_is_in_a_save_made_soon_after(s: Session) -> None:
    # The review case LS40 of yzwnd29p: the pointer ends far past the size the edge allows.
    drag_handle(s, 40, onto_value_box=False)
    saves_the_fillet(s, "drag_release_long")

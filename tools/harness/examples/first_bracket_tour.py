"""The guided first bracket, started from Home's card and done step by step with real clicks and keys. Each step
advances by itself, the open L hint shows while the L is left open, the bracket ends as one body extruded 30 mm,
and the guide ends finished. The bubble keeps off an open menu, Help's at step 5 and File's with the ring on Export
at step 13. A second start from Help is stopped on step 5 and leaves nothing on screen.

Run with `python tools/harness/examples/first_bracket_tour.py`.
"""

import tempfile
from pathlib import Path

from fundacad_harness import Session

TOUR = "first-bracket"
STEPS = 14
ARM = 5
# The L on XZ in sketch mm, where sketch x is world X and sketch y is world Z.
L = [(0, 0), (50, 0), (50, ARM), (ARM, ARM), (ARM, 50), (0, 50)]
# Short of the first corner, so six lines make no closed area yet.
SHORT = (0, 8)

HOLES = "() => window.store.document.features.filter((f) => f.type === 'hole')"
INSPECT = "() => window.geometry.session('inspect', { document: window.store.document })"
EXTRUDES = "() => window.store.document.features.filter((f) => f.type === 'extrude').map((f) => ({ id: f.id, distance: f.distance }))"
OPEN_MENU = "() => { const m = document.querySelector('.ui-menu'); return m && m.style.visibility !== 'hidden' ? m.getBoundingClientRect().toJSON() : null; }"
BUBBLE = "() => { const b = document.querySelector('.guide-bubble'); return b && getComputedStyle(b).visibility !== 'hidden' ? b.getBoundingClientRect().toJSON() : null; }"
# What is on top at the middle of the open menu's first item.
FIRST_ITEM_ON_TOP = """() => {
  const item = document.querySelector('.ui-menu [role^=menuitem]');
  const r = item.getBoundingClientRect();
  return item.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
}"""


def extent(box):
    """The size of a box along X, Y and Z, rounded to 0.01 mm."""
    return tuple(round(hi - lo, 2) for lo, hi in zip(box["min"], box["max"]))


def inside_corner(box, arm=ARM):
    """The edge where the arms of an L meet, for an L drawn on XZ from the box's low X and Z corner."""
    lo, hi = box["min"], box["max"]
    return f"near={lo[0] + arm:g},{(lo[1] + hi[1]) / 2:g},{lo[2] + arm:g}"


def on_inside(box, z, arm=ARM):
    """A point on the inside face of the upright arm, the one that faces the other arm, halfway through its depth."""
    return (box["min"][0] + arm, (box["min"][1] + box["max"][1]) / 2, z)


def until(s, cond, seconds=8.0):
    """The tour checks its step on the guide layer's frame loop, so a step can pass a frame after an action settles."""
    for _ in range(int(seconds * 10)):
        v = cond()
        if v:
            return v
        s.page.wait_for_timeout(100)
    return cond()


def expect_step(s, n):
    at = until(s, lambda: (lambda t: t if t and t["step"] == n and not t["ended"] else None)(s.tour(raw=True)))
    assert at == {"id": TOUR, "step": n, "of": STEPS, "ended": None}, (n, s.tour(raw=True), s.status())
    g = until(s, lambda: s.guide(raw=True))
    assert g and g["count"] == f"Step {n} of {STEPS}", g
    return g


def follow(s, want):
    """Clicks where the ring is until it reaches `want`, the way a rail flyout or a menu opens first."""
    for _ in range(3):
        g = s.guide(raw=True)
        assert g["ring"], f"no ring for {want}: {g}"
        if g["on"] == want:
            return s.click(want)
        s.click(g["on"])
        # A flyout animates open, so a second click before the ring moves would close it again.
        until(s, lambda: s.guide(raw=True)["on"] != g["on"], seconds=2)
    raise AssertionError(f"the ring never reached {want}: {s.guide(raw=True)}")


def keys(s, text):
    s.press(*text, "Enter")


def overlaps(a, b):
    across = a["x"] < b["x"] + b["width"] and b["x"] < a["x"] + a["width"]
    return across and a["y"] < b["y"] + b["height"] and b["y"] < a["y"] + a["height"]


def bubble_off_menu(s):
    """The open menu, once the guide's bubble is off it or hidden."""
    menu = until(s, lambda: s.page.evaluate(OPEN_MENU))
    assert menu, "no menu opened"

    def clear():
        b = s.page.evaluate(BUBBLE)
        return b is None or not overlaps(b, menu)

    assert until(s, clear, seconds=2), (s.page.evaluate(BUBBLE), menu)
    return menu


def menu_takes_clicks(s, top):
    """Opens a title bar menu over the guide, its first item takes a click, and Escape closes it."""
    s.click(f"menu:{top}")
    bubble_off_menu(s)
    assert s.page.evaluate(FIRST_ITEM_ON_TOP), f"the guide covers {top}'s first item"
    s.page.locator(".ui-menu [role^=menuitem]").first.click(trial=True, timeout=5000)
    s.press("Escape")
    assert until(s, lambda: s.page.evaluate(OPEN_MENU) is None), f"Escape did not close {top}"


def body_box(s):
    found = s.page.evaluate(INSPECT)
    assert len(found["bodies"]) == 1, found["bodies"]
    return found["bodies"][0]["bbox"]


def start_from_home(s):
    if s.bridge.call("startScreen") != "home":
        s.menu("File/Home")
    s.click("action:first-bracket")
    if s.status(raw=True)["doc"] != "Bracket":
        s.click("Discard")


def run(s):
    start_from_home(s)
    assert s.status(raw=True)["doc"] == "Bracket", s.status()
    assert s.bridge.call("startScreen") != "home"

    g = expect_step(s, 1)
    assert g["on"] == "action:sketch" and g["ring"], g
    s.click("action:sketch")

    g = expect_step(s, 2)
    assert g["ring"] is None, g
    s.pick_plane("XZ")

    expect_step(s, 3)
    follow(s, "action:line")

    expect_step(s, 4)
    for p in L:
        s.click_at(sketch=p)
    s.click_at(sketch=SHORT)
    hint = until(s, lambda: s.guide(raw=True)["hint"], seconds=10)
    assert hint == "The L is not closed yet, click its first corner again.", s.guide()
    assert s.tour(raw=True)["step"] == 4
    s.click_at(sketch=L[0])

    expect_step(s, 5)
    menu_takes_clicks(s, "Help")
    assert s.tour(raw=True)["step"] == 5, s.tour()
    follow(s, "action:finish")

    expect_step(s, 6)
    follow(s, "pick:extrude")

    expect_step(s, 7)
    s.click_at(world=(25, 0, ARM / 2))
    keys(s, "25")
    box = body_box(s)
    assert extent(box) == (50, 25, 50), box

    expect_step(s, 8)
    follow(s, "pick:fillet")

    expect_step(s, 9)
    s.pick_edge(inside_corner(box), via="edge")
    keys(s, "4")

    expect_step(s, 10)
    follow(s, "pick:hole")

    expect_step(s, 11)
    s.pick_face("near={:g},{:g},{:g}".format(*on_inside(box, 30)))
    s.click_at(world=on_inside(box, 42))
    s.press("Enter")
    holes = until(s, lambda: s.page.evaluate(HOLES))
    assert len(holes) == 1 and len(holes[0]["points"]) == 2, holes
    assert all(abs(p[0] - (box["min"][0] + ARM)) < 0.01 for p in holes[0]["points"]), holes

    extrude = s.page.evaluate(EXTRUDES)
    assert [e["distance"] for e in extrude] == [25], extrude
    g = expect_step(s, 12)
    eid = extrude[0]["id"]
    assert g["on"] == f"feature:{eid}" and g["ring"], g
    s.click(f"feature:{eid}", double=True)
    keys(s, "30")

    expect_step(s, 13)
    assert [e["distance"] for e in s.page.evaluate(EXTRUDES)] == [30]
    assert extent(body_box(s)) == (50, 30, 50)
    types = [r["type"] for r in s.history(raw=True)["rows"]]
    assert types == ["sketch", "extrude", "fillet", "hole"], types
    with tempfile.TemporaryDirectory() as tmp, s.page.expect_download(timeout=20_000) as dl:
        s.press("Ctrl+S")
        dl.value.save_as(str(Path(tmp) / "Bracket.funda"))
    assert dl.value.suggested_filename == "Bracket.funda", dl.value.suggested_filename
    # The ring moves into the open File menu, and the bubble sits beside the menu, not on it.
    s.click("menu:File")
    assert until(s, lambda: s.guide(raw=True)["on"] == "menu:File/Export…" and s.guide(raw=True)["ring"]), s.guide()
    bubble_off_menu(s)
    assert s.page.evaluate(BUBBLE), "the bubble hid beside the File menu"
    s.click("menu:File/Export…")

    expect_step(s, 14)
    # Escape closes the dialog and leaves the guide up, then Next works with the dialog open again.
    s.press("Escape")
    assert until(s, lambda: s.page.locator(".modal-panel").count() == 0), "Escape did not close Export"
    assert s.tour(raw=True) == {"id": TOUR, "step": 14, "of": STEPS, "ended": None}, s.tour()
    s.menu("File/Export…")
    assert s.page.locator(".modal-panel").count() == 1
    s.click("#guide-next")
    assert s.tour(raw=True) == {"id": TOUR, "step": 14, "of": STEPS, "ended": "finished"}, s.tour()
    s.wait_for("Guide finished")
    assert s.guide() is None
    s.press("Escape")
    assert s.page_errors() == [], s.page_errors()


def run_stop(s):
    s.menu("Help/Guided First Bracket")
    if s.status(raw=True)["doc"] != "Bracket" or s.status(raw=True)["dirty"]:
        s.click("Discard")
    expect_step(s, 1)
    for n in range(1, 5):
        s.click("#guide-next")
        expect_step(s, n + 1)
    s.click("#guide-stop")
    assert s.tour(raw=True) == {"id": TOUR, "step": 5, "of": STEPS, "ended": "stopped"}, s.tour()
    assert s.guide() is None
    assert s.page_errors() == [], s.page_errors()


if __name__ == "__main__":
    with Session() as s:
        run(s)
        run_stop(s)
    print("first bracket tour: all checks passed")

"""The guided first bracket, started from Home's card and done step by step with real clicks and keys. Each step
advances by itself, the open L hint shows while the L is left open, the bracket ends as one body extruded 30 mm,
and the guide ends finished. A second start from Help is stopped on step 5 and leaves nothing on screen.

Run with `python tools/harness/examples/first_bracket_tour.py`.
"""

import tempfile
from pathlib import Path

from fundacad_harness import Session
from fundacad_harness.errors import Occluded

TOUR = "first-bracket"
STEPS = 14
ARM = 5
# The L on XZ in sketch mm, where sketch x is world X and sketch y is world Z.
L = [(0, 0), (50, 0), (50, ARM), (ARM, ARM), (ARM, 50), (0, 50)]
# Short of the first corner, so six lines make no closed area yet.
SHORT = (0, 8)

INSPECT = "() => window.geometry.session('inspect', { document: window.store.document })"
EXTRUDES = "() => window.store.document.features.filter((f) => f.type === 'extrude').map((f) => ({ id: f.id, distance: f.distance }))"


def extent(box):
    """The size of a box along X, Y and Z, rounded to 0.01 mm."""
    return tuple(round(hi - lo, 2) for lo, hi in zip(box["min"], box["max"]))


def inside_corner(box, arm=ARM):
    """The edge where the arms of an L meet, for an L drawn on XZ from the box's low X and Z corner."""
    lo, hi = box["min"], box["max"]
    return f"near={lo[0] + arm:g},{(lo[1] + hi[1]) / 2:g},{lo[2] + arm:g}"


def on_back(box, z):
    """A point on the back of the upright arm, the face at the box's low X, halfway through its depth."""
    return (box["min"][0], (box["min"][1] + box["max"][1]) / 2, z)


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
    raise AssertionError(f"the ring never reached {want}: {s.guide(raw=True)}")


def keys(s, text):
    s.press(*text, "Enter")


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
    try:
        s.pick_face("left")
    except Occluded:
        # The default view looks at the inside of the L, the back of the upright arm faces away from it.
        s.view("left")
        s.pick_face("left")
    s.click_at(world=on_back(box, 42))
    s.press("Enter")
    s.view("iso")

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
    s.menu("File/Export…")

    expect_step(s, 14)
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

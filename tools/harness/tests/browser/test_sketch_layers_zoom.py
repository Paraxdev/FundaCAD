"""A sketch's dimension labels, their leaders and its relation glyphs sit on their points at interface size 175, under
the browser build's root zoom, which leaves projected points in window pixels and scales the lengths the layers set."""

import pytest
from test_window_caps import frames, size_to

pytestmark = [pytest.mark.browser]

SKETCH = "tools/harness/fixtures/sketch_dim_relation.json"

# Every label, leader and glyph against the point it was projected from, all in window pixels.
LAYERS = """() => {
  const pinia = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia;
  const st = pinia._s.get("sketchAnnotations");
  const z = parseFloat(document.documentElement.style.zoom || "1");
  const at = (q) => {
    const p = window.viewport.projectToScreen(window.sketch.plane.to3D(q.x, q.y));
    return [p.x, p.y];
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, left: r.left, top: r.top, right: r.right,
             bottom: r.bottom };
  };
  const labels = [...document.querySelectorAll(".sketch-dims > *")];
  const leaders = [...document.querySelectorAll(".sketch-dim-leaders g")];
  const glyphs = [...document.querySelectorAll(".sketch-glyphs > *")];
  return {
    dims: st.dimItems.map((d, i) => {
      const g = leaders[i];
      const line = g?.querySelector("line");
      const n = (k) => parseFloat(line.getAttribute(k)) * z;
      const leader = g && g.getAttribute("visibility") !== "hidden"
        ? { x1: n("x1"), y1: n("y1"), x2: n("x2"), y2: n("y2") } : null;
      return { at: at(d.anchor), box: box(labels[i]), leader };
    }),
    glyphs: st.glyphItems.map((g, i) => ({ at: at(g.pos), box: box(glyphs[i]) })),
  };
}"""

BARE = """([x, y]) => document.elementFromPoint(x, y) === window.viewport.canvas"""


def layers(s):
    frames(s)
    return s.page.evaluate(LAYERS)


def near(b, p, tol=3):
    return abs(b["cx"] - p[0]) <= tol and abs(b["cy"] - p[1]) <= tol


@pytest.fixture
def sk(session):
    session.press("Escape")
    session.open_file(SKETCH)
    session.settle()
    session.page.locator('.timeline-node[data-id="s"]').dblclick()
    session.page.wait_for_function("() => window.sketch.active", timeout=15_000)
    # The sketch opens with a drawing tool, under which the labels are click-through.
    session.page.keyboard.press("Escape")
    session.page.wait_for_selector(".sketch-dims:not(.dims-passive)", state="attached")
    assert session.page.evaluate("() => window.sketch.active")
    session.page.wait_for_function(
        "() => document.querySelectorAll('.sketch-dims > *, .sketch-glyphs > *').length >= 2"
    )
    session.settle()
    yield session
    session.page.keyboard.press("Escape")
    session.page.keyboard.press("Control+0")
    session.page.wait_for_function("() => document.documentElement.style.zoom === ''")
    session.page.keyboard.press("Escape")
    session.page.keyboard.press("Escape")
    frames(session)


def test_the_dimension_label_and_the_relation_glyph_sit_on_their_points(sk):
    size_to(sk, 175)
    got = layers(sk)
    assert got["dims"] and got["glyphs"], f"the sketch shows no dimension or no glyph: {got}"
    for d in got["dims"]:
        # The grown Items card can push the label aside, then its leader points back to the anchor.
        seg = d["leader"]
        ends = seg and abs(seg["x2"] - d["at"][0]) <= 3 and abs(seg["y2"] - d["at"][1]) <= 3
        assert near(d["box"], d["at"]) or ends, f"at 175 percent a dimension label is off its anchor {d['at']}: {d}"
    for g in got["glyphs"]:
        assert near(g["box"], g["at"]), f"at 175 percent a relation glyph is off its point {g['at']}: {g['box']}"


# The label a press at the point reaches, by the browser's own hit test and by the pointerdown the layer gets.
HIT = """([x, y]) => {
  window.__dimHit = null;
  document.querySelector(".sketch-dims").addEventListener(
    "pointerdown", (e) => (window.__dimHit = e.target.closest(".sketch-dim") ? "label" : "other"), { capture: true, once: true });
  return !!document.elementFromPoint(x, y)?.closest(".sketch-dim");
}"""


def test_a_press_on_the_dimensions_point_lands_on_its_label(sk):
    size_to(sk, 175)
    x, y = layers(sk)["dims"][0]["at"]
    assert sk.page.evaluate(HIT, [x, y]), f"at 175 percent the label is not under its dimension's point {x, y}"
    sk.page.mouse.click(x, y)
    assert sk.page.evaluate("() => window.__dimHit") == "label"


def test_a_label_pushed_off_its_point_has_a_leader_from_its_border_to_the_point(sk):
    size_to(sk, 175)
    x, y = layers(sk)["dims"][0]["at"]
    spots = [(x, y - 220), (x, y + 220), (x - 260, y), (x + 260, y)]
    cx, cy = next(p for p in spots if sk.page.evaluate(BARE, list(p)))
    sk.page.mouse.move(cx, cy)
    d = None
    for _ in range(30):
        sk.page.mouse.wheel(0, -240)
        d = layers(sk)["dims"][0]
        if d["leader"]:
            break
    assert d and d["leader"], f"zooming in at {cx, cy} never pushed the label off its point: {d}"
    seg, b = d["leader"], d["box"]
    assert abs(seg["x2"] - d["at"][0]) <= 3 and abs(seg["y2"] - d["at"][1]) <= 3, (
        f"at 175 percent the leader ends off the dimension's point {d['at']}: {seg}"
    )
    inside = b["left"] - 2 <= seg["x1"] <= b["right"] + 2 and b["top"] - 2 <= seg["y1"] <= b["bottom"] + 2
    on_edge = (
        min(
            abs(seg["x1"] - b["left"]),
            abs(seg["x1"] - b["right"]),
            abs(seg["y1"] - b["top"]),
            abs(seg["y1"] - b["bottom"]),
        )
        <= 2
    )
    assert inside and on_edge, f"at 175 percent the leader starts off the label's border {b}: {seg}"

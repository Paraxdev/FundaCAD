"""A big assembly orbits at full resolution in Matcap, and hovering it never stalls.

64 holed plates stacked four deep, so the pointer over the model has edges
inside its grab radius on every layer, most of them behind the plate in front,
as over a printer assembly. A hover used to test every one of them for occlusion
with a sight ray through every body, and froze for seconds on a 12 M triangle
assembly; the stalls read as slow frames and shrank the canvas in Matcap, where
a smaller canvas saves nothing. Under a software renderer every frame is slow,
so the motion level drops at once, and Matcap has to stay at full size anyway.

The model is small for a GPU, since the software renderer spends seconds a
frame on fat edge lines; the budgets are for it, numbers from a 12 M triangle
assembly on a GPU are in the change that added this. Those fat lines are most of
a software frame here, so once a first window of moving frames has measured them
the edges draw as 1px lines while the camera moves, and the full set is back at
rest (src/viewport/edgeMotion.ts). Run with
`python tools/harness/examples/big_model_orbit.py`, it prints what it measured.
"""

import json
import math
import time
import tempfile
from pathlib import Path

from fundacad_harness import Session

HOVER_BUDGET_MS = 250
ORBIT_P95_BUDGET_MS = 2500
HOVER_POINTS = 40
ORBIT_STEPS = 40
# The thin edges have to at least halve a moving frame: 469 to 92 ms measured.
THIN_GAIN = 2
THIN_SHARE = 0.8
REST_TIMEOUT_MS = 10_000

PLATE = 30
BODIES = 64
HOLES = 3


def document():
    pitch = PLATE / HOLES
    first = -PLATE / 2 + pitch / 2
    features = [
        {"id": "plate", "type": "box", "length": PLATE, "width": PLATE, "height": 2},
        # The first hole is cut at the origin, so the plate's corner goes there.
        {"id": "toCorner", "type": "move", "dx": -first, "dy": -first, "bodies": ["body1"]},
        {"id": "hole", "type": "cylinder", "radius": pitch * 0.3, "height": 6, "operation": "cut", "targets": ["body1"]},
        {"id": "holes", "type": "patternRect", "countX": HOLES, "countY": HOLES, "spacingX": pitch, "spacingY": pitch, "features": ["hole"]},
    ]
    # Each duplicate doubles the bodies: 4 x 4 side by side, 4 layers deep.
    n = 1
    for i, (dx, dy, dz) in enumerate([(32, 0, 0), (64, 0, 0), (0, 32, 0), (0, 64, 0), (0, 0, 7), (0, 0, 14)]):
        features.append({"id": f"dup{i}", "type": "duplicate", "dx": dx, "dy": dy, "dz": dz,
                         "bodies": [f"body{k + 1}" for k in range(n)]})
        n *= 2
    return {"version": 10, "parameters": {}, "features": features}


MATCAP = """async () => {
  const vm = await import("/src/ui/viewMode.ts");
  vm.chooseViewMode("matcap", window.viewport.renderTier);
  window.viewport.requestRender();
}"""

HOVER = """(n) => {
  const v = window.viewport;
  const rect = v.canvas.getBoundingClientRect();
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = rect.left + rect.width * (0.3 + 0.4 * ((i * 7) % n) / n);
    const y = rect.top + rect.height * (0.3 + 0.4 * ((i * 13) % n) / n);
    const t = performance.now();
    v.hoverAt({ clientX: x, clientY: y }, true);
    out.push(performance.now() - t);
  }
  return out;
}"""

RECORD = """() => {
  const r = window.viewport.scene.renderer;
  const rec = (window.__orbit = { periods: [], ratios: [], modes: [], times: [], moved: [], on: true });
  let last = performance.now();
  const tick = () => {
    if (!rec.on) return;
    const now = performance.now();
    rec.periods.push(now - last);
    rec.ratios.push(r.getPixelRatio());
    rec.modes.push(window.viewport.edgeMotionMode);
    rec.times.push(now);
    rec.moved.push(window.viewport.frameMoved === true);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return Math.min(window.devicePixelRatio, 2);
}"""

STOP = "() => { window.__orbit.on = false; return window.__orbit; }"

AT_REST = """() => {
  const v = window.viewport;
  return {
    mode: v.edgeMotionMode,
    drawn: v.scene.post.edgesDrawn,
    hidden: v.model.bodies.filter((b) => b.edges.segments > 0 && !b.edges.object.visible).length,
  };
}"""


def quantile(xs, f):
    s = sorted(xs)
    return s[min(len(s) - 1, int(len(s) * f))] if s else 0


def orbit(page):
    box = page.evaluate("() => { const r = window.viewport.canvas.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
    cx, cy = box
    base = page.evaluate(RECORD)
    page.mouse.move(cx - 150, cy)
    page.mouse.down(button="right")
    for i in range(ORBIT_STEPS):
        page.mouse.move(cx - 150 + 300 * i / ORBIT_STEPS, cy + 30 * math.sin(i / 6), steps=1)
        time.sleep(1 / 30)
    up = page.evaluate("() => performance.now()")
    page.mouse.up(button="right")
    time.sleep(1.0)
    # The camera glides on after the drag, and the full edges come back once it stops.
    page.wait_for_function("() => window.viewport.renderIdle", timeout=REST_TIMEOUT_MS)
    rest = page.evaluate(AT_REST)
    rest["ms_after_drag"] = round(page.evaluate("() => performance.now()") - up)
    rec = page.evaluate(STOP)
    drag = [(p, m) for p, m, t, mv in zip(rec["periods"], rec["modes"], rec["times"], rec["moved"]) if t <= up and mv]
    return base, rec["periods"][3:], rec["ratios"], drag, rest


def run(s, tmp_path):
    path = Path(tmp_path) / "stacked_plates.json"
    path.write_text(json.dumps(document()))
    s.open_file(path)
    bodies = s.page.evaluate("() => window.viewport.model.bodies.length")
    assert bodies == BODIES, f"the stack built {bodies} bodies, not {BODIES}, {s.last_error()}"
    s.view("iso")
    s.page.evaluate(MATCAP)
    s.settle()

    hover = s.page.evaluate(HOVER, HOVER_POINTS)
    # The camera flight to iso is a gesture too and may have found the fat lines slow already.
    s.page.evaluate("() => window.viewport.edgeRule.reset()")
    # Twice, so the slow level a software renderer reaches on the first is in force for the second.
    base, periods, ratios, drag1, rest1 = orbit(s.page)
    _, periods2, ratios2, drag2, rest2 = orbit(s.page)
    periods += periods2
    ratios += ratios2
    full = [p for p, m in drag1[1:] if m == "full"]
    thin = [p for p, m in drag1 + drag2 if m == "thin"]
    got = {
        "hover_max_ms": round(max(hover), 1),
        "hover_median_ms": round(quantile(hover, 0.5), 1),
        "orbit_frames": len(periods),
        "orbit_median_ms": round(quantile(periods, 0.5), 1),
        "orbit_p95_ms": round(quantile(periods, 0.95), 1),
        "pixel_ratios": sorted(set(ratios)),
        "full_edges_median_ms": round(quantile(full, 0.5), 1),
        "thin_edges_median_ms": round(quantile(thin, 0.5), 1),
        "second_orbit_thin_share": round(sum(m == "thin" for _, m in drag2) / max(1, len(drag2)), 2),
        "at_rest": [rest1, rest2],
    }
    print("big model orbit:", json.dumps(got))
    assert got["hover_max_ms"] < HOVER_BUDGET_MS, f"a hover held the main thread {got['hover_max_ms']} ms, {got}"
    assert set(ratios) == {base}, f"Matcap drew below its full pixel ratio {base} while orbiting, {got}"
    assert got["orbit_p95_ms"] < ORBIT_P95_BUDGET_MS, f"orbit frames too slow, {got}"
    assert full and thin, f"the first window drew the full edges and the rest thin ones, {got}"
    assert got["second_orbit_thin_share"] >= THIN_SHARE, f"the second orbit kept the fat edges, {got}"
    assert got["thin_edges_median_ms"] * THIN_GAIN <= got["full_edges_median_ms"], f"the thin edges saved too little, {got}"
    for rest in (rest1, rest2):
        assert rest["mode"] == "full" and rest["drawn"] is None and rest["hidden"] == 0, f"the full edges were not back at rest, {got}"
    return got


if __name__ == "__main__":
    with Session() as s, tempfile.TemporaryDirectory() as tmp:
        run(s, tmp)
    print("big model orbit: all checks passed")

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
a software frame here, so once two windows of moving frames have measured them
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
# CI's software renderer gained only 1.9x (1043 to 550 ms) where this PC measured 469 to 92 ms.
THIN_GAIN = 1.5
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


BOXES = 512
# MERGE_ON_DRAWS in src/viewport/edgeMotion.ts.
MERGE_ON_DRAWS = 384
# Of the canvas, over what two renders of the full edges differ by.
MERGED_LOOK_SHARE = 0.0005


def box_document():
    """8 x 8 x 8 small boxes, enough draws for the merged level and few segments."""
    features = [{"id": "box", "type": "box", "length": 4, "width": 4, "height": 4}]
    n = 1
    for i, d in enumerate([6, 12, 24]):
        for axis in range(3):
            step = [0, 0, 0]
            step[axis] = d
            features.append({"id": f"dup{i}{axis}", "type": "duplicate", "dx": step[0], "dy": step[1], "dz": step[2],
                             "bodies": [f"body{k + 1}" for k in range(n)]})
            n *= 2
    return {"version": 10, "parameters": {}, "features": features}


# The same camera drawn with the full edges, the merged batches and the full edges
# again, in each look; the second pair is the noise of the look itself.
MERGED_LOOK = """async (look) => {
  const v = window.viewport;
  const post = v.scene.post;
  const gl = v.scene.renderer.getContext();
  const vm = await import("/src/ui/viewMode.ts");
  vm.chooseViewMode(look, v.renderTier);
  for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
  const frame = { members: v.model.bodies.map((b) => b.edges), thin: false, weight: 1, keep: () => false };
  const shot = (f) => {
    post.edgeFrame = f;
    try {
      post.render(v.rig.active, false, false, { moving: false, ghosted: v.ghosted });
    } finally {
      post.edgeFrame = null;
    }
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const diff = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) n++;
    }
    return n;
  };
  const full = shot(null);
  const merged = shot(frame);
  const drawn = post.edgesDrawn;
  const again = shot(null);
  vm.chooseViewMode("matcap", v.renderTier);
  v.requestRender();
  return { look, pixels: full.length / 4, merged: diff(full, merged), noise: diff(full, again), members: drawn ? drawn.merged : 0 };
}"""

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
  const rec = (window.__orbit = { periods: [], ratios: [], modes: [], members: [], times: [], moved: [], on: true });
  let last = performance.now();
  const tick = () => {
    if (!rec.on) return;
    const now = performance.now();
    rec.periods.push(now - last);
    rec.ratios.push(r.getPixelRatio());
    rec.modes.push(window.viewport.edgeMotionMode);
    rec.members.push(window.viewport.scene.post.edgesDrawn?.merged ?? 0);
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
    members = [n for n, t, mv in zip(rec["members"], rec["times"], rec["moved"]) if t <= up and mv]
    return base, rec["periods"][3:], rec["ratios"], drag, rest, members


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
    # The lowest motion level, as slow Realtime frames before Matcap leave it:
    # Matcap still draws at full size, and its frames still judge the edges.
    s.page.evaluate("() => { window.viewport.motion.lvl = 2; }")
    # Twice, so the slow level a software renderer reaches on the first is in force for the second.
    base, periods, ratios, drag1, rest1, _ = orbit(s.page)
    _, periods2, ratios2, drag2, rest2, _ = orbit(s.page)
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
        "orbit_modes": ["".join(m[0] for _, m in d) for d in (drag1, drag2)],
        "at_rest": [rest1, rest2],
    }
    print("big model orbit:", json.dumps(got))
    assert got["hover_max_ms"] < HOVER_BUDGET_MS, f"a hover held the main thread {got['hover_max_ms']} ms, {got}"
    assert set(ratios) == {base}, f"Matcap drew below its full pixel ratio {base} while orbiting, {got}"
    assert got["orbit_p95_ms"] < ORBIT_P95_BUDGET_MS, f"orbit frames too slow, {got}"
    assert full and thin, f"the first windows drew the full edges and the rest thin ones, {got}"
    assert got["second_orbit_thin_share"] >= THIN_SHARE, f"the second orbit kept the fat edges, {got}"
    assert got["thin_edges_median_ms"] * THIN_GAIN <= got["full_edges_median_ms"], f"the thin edges saved too little, {got}"
    for rest in (rest1, rest2):
        assert rest["mode"] == "full" and rest["drawn"] is None and rest["hidden"] == 0, f"the full edges were not back at rest, {got}"
    got["merged"] = run_merged(s, tmp_path)
    return got


def run_merged(s, tmp_path):
    """Many small bodies: the edges draw as merged batches while moving, look the same, and are back at rest."""
    path = Path(tmp_path) / "boxes.json"
    path.write_text(json.dumps(box_document()))
    s.open_file(path)
    bodies = s.page.evaluate("() => window.viewport.model.bodies.length")
    assert bodies == BOXES, f"the grid built {bodies} bodies, not {BOXES}, {s.last_error()}"
    s.view("iso")
    s.page.evaluate(MATCAP)
    s.settle()
    looks = [s.page.evaluate(MERGED_LOOK, look) for look in ("matcap", "realtime")]
    s.settle()
    s.page.evaluate("() => window.viewport.edgeRule.reset()")
    _, _, _, drag, rest, members = orbit(s.page)
    # Two windows of four frames before a slow renderer may draw thin.
    first = [m for _, m in drag[:8]]
    # Ghosts blend over the edges, so each body's edges sort with their own mesh.
    s.page.evaluate("() => window.viewport.setXray(true)")
    s.settle()
    _, _, _, xray_drag, xray_rest, _ = orbit(s.page)
    s.page.evaluate("() => window.viewport.setXray(false)")
    got = {"looks": looks, "first_frames": first, "members_max": max(members, default=0), "at_rest": rest,
           "xray_modes": sorted({m for _, m in xray_drag}), "xray_at_rest": xray_rest}
    print("big model orbit, merged:", json.dumps(got))
    for look in looks:
        assert look["members"] >= MERGE_ON_DRAWS, f"the batches did not take the bodies' edges, {got}"
        assert look["merged"] <= look["noise"] + look["pixels"] * MERGED_LOOK_SHARE, f"the merged edges look different in {look['look']}, {got}"
    assert first and set(first) == {"merged"}, f"the first moving frames did not draw merged, {got}"
    assert got["members_max"] >= MERGE_ON_DRAWS, f"the moving frames did not merge the bodies' edges, {got}"
    assert rest["mode"] == "full" and rest["drawn"] is None and rest["hidden"] == 0, f"the full edges were not back at rest, {got}"
    assert got["xray_modes"] == ["full"], f"x ray drew the edges merged or thin, {got}"
    assert xray_rest["drawn"] is None and xray_rest["hidden"] == 0, f"x ray left edges hidden, {got}"
    return got


if __name__ == "__main__":
    with Session() as s, tempfile.TemporaryDirectory() as tmp:
        run(s, tmp)
    print("big model orbit: all checks passed")

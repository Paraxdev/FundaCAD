"""A box drag over a big assembly tracks the cursor and lands its release without a stall.

Holed plates doubled into a stack, dragged over by a window box on part of it, a crossing box
the other way and a window over all of it, 30 mouse steps each. Before the drag repainted
only what its take changed and projected only the bodies the box reached, a drag over 8,192
boxes held each frame 1.4 s and its release 1.7 s. Each drag times the pointermove handlers,
the frame gaps while it runs, the drag's projection and the release until two frames have
drawn. Run with `python tools/harness/examples/big_model_box.py [--gpu] [HOLES:LOG2_BODIES]`,
for example `--gpu 4:9` for 512 plates of 16 holes, it prints what it measured.
"""

import json
import sys
import tempfile
import time
from pathlib import Path

from fundacad_harness import Session

STEPS = 30
HOLES = 3
LOG2_BODIES = 6
# The handler only moves the rectangle and queues a frame, the drag's projection runs once per drag.
HANDLER_P95_BUDGET_MS = 16
PROJECT_BUDGET_MS = 50
# With a GPU, frame p95 and release to two frames; CI draws in software, so its budgets only catch a stall.
GPU_FRAME_P95_BUDGET_MS = 50
GPU_RELEASE_BUDGET_MS = 500
SOFT_FRAME_P95_BUDGET_MS = 5000
SOFT_RELEASE_BUDGET_MS = 10_000


def document(holes=HOLES, log2=LOG2_BODIES):
    plate = 30
    pitch = plate / holes
    first = -plate / 2 + pitch / 2
    features = [
        {"id": "plate", "type": "box", "length": plate, "width": plate, "height": 2},
        # The first hole is cut at the origin, so the plate's corner goes there.
        {"id": "toCorner", "type": "move", "dx": -first, "dy": -first, "bodies": ["body1"]},
        {"id": "hole", "type": "cylinder", "radius": pitch * 0.3, "height": 6, "operation": "cut", "targets": ["body1"]},
        {"id": "holes", "type": "patternRect", "countX": holes, "countY": holes, "spacingX": pitch, "spacingY": pitch, "features": ["hole"]},
    ]
    # Each duplicate doubles the bodies, along x, y and z in turn.
    n = 1
    for i in range(log2):
        d = [0, 0, 0]
        d[i % 3] = 32 * 2 ** (i // 3)
        features.append({"id": f"dup{i}", "type": "duplicate", "dx": d[0], "dy": d[1], "dz": d[2],
                         "bodies": [f"body{k + 1}" for k in range(n)]})
        n *= 2
    return {"version": 10, "parameters": {}, "features": features}


INSTALL = """() => {
  if (window.__box) return;
  const v = window.viewport;
  const T = (window.__box = { project: [], moves: [], frames: [], on: false });
  const project = v.projectForArea;
  v.projectForArea = function (...a) {
    const t = performance.now();
    try { return project.apply(this, a); } finally { T.project.push(performance.now() - t); }
  };
  let at = 0;
  window.addEventListener('pointermove', () => { at = performance.now(); }, { capture: true });
  window.addEventListener('pointermove', () => { if (T.on) T.moves.push(performance.now() - at); });
  let last = performance.now();
  const tick = () => { const now = performance.now(); if (T.on) T.frames.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}"""

RESET = "() => { const T = window.__box; T.project = []; T.moves = []; T.frames = []; T.on = true; }"

COLLECT = """() => {
  const T = window.__box, h = window.viewport.highlighter;
  T.on = false;
  return { project: T.project, moves: T.moves, frames: T.frames,
           picked: { faces: h.getSelectedFaces().length, edges: h.getSelectedEdges().length, bodies: h.getSelectedBodies().length } };
}"""

TWO_FRAMES = "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"


def p95(xs):
    s = sorted(xs)
    return round(s[min(len(s) - 1, int(len(s) * 0.95))], 1) if s else 0


def drag(page, a, b):
    page.evaluate("() => window.viewport.highlighter.clearSelection()")
    page.evaluate(TWO_FRAMES)
    page.evaluate(RESET)
    page.mouse.move(*a)
    page.mouse.down()
    for i in range(1, STEPS + 1):
        page.mouse.move(a[0] + (b[0] - a[0]) * i / STEPS, a[1] + (b[1] - a[1]) * i / STEPS)
    t = time.perf_counter()
    page.mouse.up()
    page.evaluate(TWO_FRAMES)
    release = (time.perf_counter() - t) * 1000
    raw = page.evaluate(COLLECT)
    return {
        "handler_p95_ms": p95(raw["moves"]),
        "frame_p95_ms": p95(raw["frames"]),
        "project_ms": round(max(raw["project"], default=0), 1),
        "projections": len(raw["project"]),
        "release_ms": round(release, 1),
        "picked": raw["picked"],
    }


def run(s, tmp_path, holes=HOLES, log2=LOG2_BODIES):
    path = Path(tmp_path) / "box_plates.json"
    path.write_text(json.dumps(document(holes, log2)))
    s.open_file(path)
    bodies = s.page.evaluate("() => window.viewport.model.bodies.length")
    assert bodies == 2**log2, f"the stack built {bodies} bodies, not {2**log2}, {s.last_error()}"
    s.view("iso")
    s.settle()
    s.page.evaluate(INSTALL)
    L, T, W, H = s.page.evaluate("() => { const r = window.viewport.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
    at = lambda fx, fy: (L + W * fx, T + H * fy)  # noqa: E731
    # A first drag links the software renderer's programs for the selection colours, the second set is measured.
    drag(s.page, at(0.01, 0.01), at(0.99, 0.99))
    got = {
        "bodies": bodies,
        "window_part": drag(s.page, at(0.01, 0.01), at(0.55, 0.6)),
        "crossing_part": drag(s.page, at(0.97, 0.96), at(0.45, 0.4)),
        "window_all": drag(s.page, at(0.01, 0.01), at(0.99, 0.99)),
    }
    print("big model box:", json.dumps(got))
    frame_budget = GPU_FRAME_P95_BUDGET_MS if s.gpu else SOFT_FRAME_P95_BUDGET_MS
    release_budget = GPU_RELEASE_BUDGET_MS if s.gpu else SOFT_RELEASE_BUDGET_MS
    for name in ("window_part", "crossing_part", "window_all"):
        d = got[name]
        assert d["projections"] == 1, f"{name} projected the model {d['projections']} times, {got}"
        assert d["handler_p95_ms"] < HANDLER_P95_BUDGET_MS, f"{name} held a pointermove {d['handler_p95_ms']} ms, {got}"
        assert d["project_ms"] < PROJECT_BUDGET_MS, f"{name} spent {d['project_ms']} ms projecting, {got}"
        assert d["frame_p95_ms"] < frame_budget, f"{name} drew its frames in {d['frame_p95_ms']} ms, {got}"
        assert d["release_ms"] < release_budget, f"{name} took {d['release_ms']} ms to land its release, {got}"
    # With the face filter a box takes faces and edges: a window over part of the stack takes fewer than one over all.
    part, cross, whole = (got[k]["picked"] for k in ("window_part", "crossing_part", "window_all"))
    assert 0 < part["faces"] < whole["faces"] and 0 < cross["faces"] < whole["faces"], f"a box took the wrong faces, {got}"
    assert 0 < part["edges"] < whole["edges"], f"a box took the wrong edges, {got}"
    return got


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--gpu"]
    holes, log2 = (int(x) for x in args[0].split(":")) if args else (HOLES, LOG2_BODIES)
    with Session(gpu="--gpu" in sys.argv) as s, tempfile.TemporaryDirectory() as tmp:
        run(s, tmp, holes, log2)
    print("big model box: all checks passed")

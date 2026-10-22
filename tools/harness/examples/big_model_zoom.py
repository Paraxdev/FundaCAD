"""Zooming a big assembly out notch by notch and back never stalls a wheel notch or the hover after it.

The 64 holed plates of big_model_orbit.py, zoomed out by real wheel notches until the
zoom stops and back in. Zoomed out, every edge segment of the stack lies under the
hover's grab radius, and a pick fed each of them to the edge ranking: on a 12 M
triangle assembly a pointer move took 1.1 s at the zoom out limit. Each notch here
times the wheel event's handler, the long tasks until the view rests and after, and a
hover at a few points round the centre. Run with
`python tools/harness/examples/big_model_zoom.py`, it prints what it measured.
"""

import importlib.util
import json
import tempfile
import time
from pathlib import Path

from fundacad_harness import Session

# By path, so the tests' loader (tests/browser/test_examples.py) finds it as well as a plain run does.
_spec = importlib.util.spec_from_file_location("big_model_orbit", Path(__file__).with_name("big_model_orbit.py"))
_orbit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_orbit)
BODIES, MATCAP, document = _orbit.BODIES, _orbit.MATCAP, _orbit.document

NOTCH_PX = 100
MAX_NOTCHES = 40
# A notch that changes the distance by less than this is at the zoom limit.
LIMIT_SHARE = 0.001
WHEEL_BUDGET_MS = 50
HOVER_BUDGET_MS = 50
# Machine free: zoomed out the hover may cost this much more than at the fitted view, plus 2 ms of
# timer noise. Without the density cut the limit cost 21x the fitted view here, 61.8 ms against 2.9.
ZOOMED_OUT_SHARE = 1.5
REST_TIMEOUT_MS = 20_000
REST_WATCH_S = 0.4
# Loose like big_model_orbit.py's budgets, CI draws in software; the SV08 on a GPU stays under 50 ms.
EASE_TASK_BUDGET_MS = 250

INSTALL = """() => {
  if (window.__zoom) return;
  const z = (window.__zoom = { wheel: [], long: [] });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) z.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask' });
  let at = 0;
  window.addEventListener('wheel', () => { at = performance.now(); }, { capture: true, passive: true });
  window.addEventListener('wheel', () => { z.wheel.push(performance.now() - at); }, { passive: true });
}"""

HOVER = """() => {
  const v = window.viewport;
  const r = v.canvas.getBoundingClientRect();
  const out = [];
  for (let i = 0; i < 9; i++) {
    const x = r.left + r.width / 2 + 4 * ((i % 3) - 1), y = r.top + r.height / 2 + 4 * (Math.floor(i / 3) - 1);
    const t = performance.now();
    v.hoverAt({ clientX: x, clientY: y }, true);
    out.push(performance.now() - t);
  }
  const c = v.rig.active;
  return { hover: Math.max(...out), dist: c.position.distanceTo(v.rig.getTarget()), zoom: c.zoom, wheel: window.__zoom.wheel.splice(0) };
}"""


# Long tasks from the wheel event until the view comes to rest, and in a short wait at rest after it.
LONG = """([a, b]) => window.__zoom.long.filter(([t, d]) => t + d >= a && t < b).map(([t, d]) => [t >= b ? 'rest' : 'ease', d])"""


def notch(page, dy):
    start = page.evaluate("() => performance.now()")
    page.mouse.wheel(0, dy)
    time.sleep(0.3)
    page.wait_for_function("() => window.viewport.renderIdle", timeout=REST_TIMEOUT_MS)
    rest = page.evaluate("() => performance.now()")
    time.sleep(REST_WATCH_S)
    long = page.evaluate(LONG, [start, rest])
    row = page.evaluate(HOVER)
    row["ease_long"] = max((d for k, d in long if k == "ease"), default=0)
    row["rest_long"] = max((d for k, d in long if k == "rest"), default=0)
    return row


def out_and_back(page):
    rows = [page.evaluate(HOVER)]
    out = 0
    while out < MAX_NOTCHES:
        rows.append(notch(page, NOTCH_PX))
        out += 1
        a, b = rows[-2], rows[-1]
        if abs(b["dist"] / b["zoom"] - a["dist"] / a["zoom"]) <= LIMIT_SHARE * a["dist"] / a["zoom"]:
            break
    for _ in range(out):
        rows.append(notch(page, -NOTCH_PX))
    return rows


def run(s, tmp_path):
    path = Path(tmp_path) / "stacked_plates.json"
    path.write_text(json.dumps(document()))
    s.open_file(path)
    bodies = s.page.evaluate("() => window.viewport.model.bodies.length")
    assert bodies == BODIES, f"the stack built {bodies} bodies, not {BODIES}, {s.last_error()}"
    s.view("iso")
    s.page.evaluate(MATCAP)
    s.settle()
    s.page.evaluate(INSTALL)
    cx, cy = s.page.evaluate("() => { const r = window.viewport.canvas.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
    s.page.mouse.move(cx, cy)
    # The software renderer links a program on its first use, 0.4 s for the thin edges and again for a shader first
    # drawn zoomed out, so a first pass out and back links them all and the second is measured.
    warm = out_and_back(s.page)
    rows = out_and_back(s.page)
    out = (len(rows) - 1) // 2
    wheel = [w for r in rows for w in r["wheel"]]
    got = {
        "notches_out": out,
        "dist_range": [round(min(r["dist"] for r in rows)), round(max(r["dist"] for r in rows))],
        "wheel_events": len(wheel),
        "wheel_max_ms": round(max(wheel, default=0), 1),
        "hover_max_ms": round(max(r["hover"] for r in rows), 1),
        "hover_fitted_ms": round(rows[0]["hover"], 1),
        "hover_at_limit_ms": round(max(r["hover"] for r in rows[out - 2 : out + 1]), 1),
        "hover_by_notch_ms": [round(r["hover"], 1) for r in rows],
        "ease_long_by_notch_ms": [round(r.get("ease_long", 0)) for r in rows],
        "warm_ease_long_max_ms": round(max(r.get("ease_long", 0) for r in warm)),
        "rest_long_max_ms": round(max((r.get("rest_long", 0) for r in rows), default=0)),
    }
    print("big model zoom:", json.dumps(got))
    assert out < MAX_NOTCHES, f"the zoom out never reached its limit, {got}"
    assert got["dist_range"][1] > 8 * got["dist_range"][0], f"the wheel did not zoom out, {got}"
    assert len(wheel) == 2 * out, f"a wheel event went missing, {got}"
    assert got["wheel_max_ms"] < WHEEL_BUDGET_MS, f"a wheel notch held the main thread {got['wheel_max_ms']} ms, {got}"
    assert got["hover_max_ms"] < HOVER_BUDGET_MS, f"a hover after a notch held the main thread {got['hover_max_ms']} ms, {got}"
    assert max(got["ease_long_by_notch_ms"]) < EASE_TASK_BUDGET_MS, f"a notch held the main thread while it eased, {got}"
    assert got["rest_long_max_ms"] == 0, f"a long task ran at rest after a notch, {got}"
    assert got["hover_at_limit_ms"] <= ZOOMED_OUT_SHARE * got["hover_fitted_ms"] + 2, f"the hover grew as the view zoomed out, {got}"
    return got


if __name__ == "__main__":
    with Session() as s, tempfile.TemporaryDirectory() as tmp:
        run(s, tmp)
    print("big model zoom: all checks passed")

"""A maker's 3,000 part printer STEP dropped on a blank document imports with the capability note, its
subassemblies collapsed in Items and no error. The import, the first frame after it and one short orbit's p95
frame go to the test log.

The budgets are for CI's software renderer, which spends seconds a frame on a big model. Run with
`python tools/harness/examples/big_printer_import.py`.
"""

import json
import math
import time

from fundacad_harness import Session

STEP = "tests/fixtures/printer_3000.stpz"
LEAVES = 3000
GROUPS = ["Frame", "Motion", "Bed", "Toolhead", "Electronics"]
IMPORT_BUDGET_S = 180
FIRST_FRAME_BUDGET_S = 60

LANDED = "() => !window.store.busyState.active && window.store.document.features.some((f) => f.type === 'import')"
DRAWN = f"() => window.viewport.model.bodies.length >= {LEAVES} && window.viewport.renderIdle"
NOTE = "async () => (await import('/src/io/files.ts')).describeImportCapability(3000)"

RECORD = """() => {
  const rec = (window.__orbit = { periods: [], on: true });
  let last = performance.now();
  const tick = () => {
    if (!rec.on) return;
    const now = performance.now();
    rec.periods.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}"""


def wait(s, js, budget):
    t0 = time.monotonic()
    s.page.wait_for_function(js, timeout=budget * 1000, polling=200)
    return time.monotonic() - t0


def orbit_p95(s):
    cx, cy = s.page.evaluate(
        "() => { const r = window.viewport.canvas.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }"
    )
    s.page.evaluate(RECORD)
    s.page.mouse.move(cx - 120, cy)
    s.page.mouse.down(button="right")
    for i in range(30):
        s.page.mouse.move(cx - 120 + 240 * i / 30, cy + 20 * math.sin(i / 5), steps=1)
        time.sleep(1 / 30)
    s.page.mouse.up(button="right")
    periods = sorted(s.page.evaluate("() => { window.__orbit.on = false; return window.__orbit.periods; }")[2:])
    return round(periods[min(len(periods) - 1, int(len(periods) * 0.95))]) if periods else None


def run(s):
    t0 = time.monotonic()
    s.import_file(STEP, settle=False)
    imported = time.monotonic() - t0 + wait(s, LANDED, IMPORT_BUDGET_S)
    first_frame = wait(s, DRAWN, FIRST_FRAME_BUDGET_S)
    s.settle(timeout=FIRST_FRAME_BUDGET_S)
    p95 = orbit_p95(s)
    got = {"import_s": round(imported, 1), "first_frame_s": round(first_frame, 1), "orbit_p95_ms": p95}
    print("big printer import:", json.dumps(got))
    assert imported < IMPORT_BUDGET_S, imported

    assert len(s.bodies(raw=True)) == LEAVES, s.bodies()
    note = s.page.evaluate(NOTE)
    said = [m["text"] for m in s.messages(raw=True)["rows"]]
    assert note and any(note in m for m in said), (note, said)
    assert s.last_error() == "none", s.last_error()

    s.panel("items")
    rows = [(r[1], r[3], r[4]) for r in s.screen(region="items", raw=True)["lines"] if r[2] == "row"]
    printer = next(ref for ref, label, _ in rows if label == "Printer" and ref.startswith("folder:"))
    assert "closed" in next(flags for ref, _, flags in rows if ref == printer), rows
    s.expand(printer)
    labels = [r[3] for r in s.screen(region="items", raw=True)["lines"] if r[2] == "row"]
    assert [g for g in GROUPS if g in labels] == GROUPS, labels
    assert not s.page_errors(), s.page_errors()


if __name__ == "__main__":
    with Session() as s:
        run(s)
    print("big printer import: all checks passed")

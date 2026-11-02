"""The Geometry browser stays quick on a comb of 2,002 faces and 6,000 edges: the fetch, a page turn, a filter over all rows
and a bracket step, each timed in the page from the key to the next frame. Limits are three times the budgets of the design."""

import json
import statistics

import pytest

pytestmark = [pytest.mark.browser]

TEETH = 500
TOOTH_WIDE = 2.5
GAP = 1.5
TOOTH_LONG = 12.0
SPINE = 8.0
THICK = 7.0
AT = (-310.5, 42.25)
# Two caps, and a tip, a floor and two flanks per tooth, the end teeth's outer flanks being the comb's ends.
SIDES = 4 * TEETH
FACES = SIDES + 2
# Each side face has one edge along the thickness and one on each cap.
EDGES = 3 * SIDES
# The tips and floors measure 7 mm, the flanks 12 mm, and the 2 ends, the long back and the 2 caps more.
AT_LEAST_10 = 2 * (TEETH - 1) + 2 + 1 + 2

BUDGET_MS = {"fetch": 1000, "page": 50, "filter": 20, "step": 16}
LIMIT = 3

# `work` ends on window's own listener, after the app's and Vue's patch, or when a page turn moves focus to its new row.
# A posted task reads a steady 60 ms here whatever the handler does, so it can not time the work.
TIMER = """() => {
  window.__mark = null;
  if (window.__timer) return;
  window.__timer = (e) => {
    const t0 = performance.now();
    const mark = { type: e.type, t0, work: null, frame: null };
    window.__mark = mark;
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { mark.frame = performance.now() - t0; };
      channel.port2.postMessage(0);
    });
  };
  const worked = () => {
    const mark = window.__mark;
    if (mark && mark.work === null) mark.work = performance.now() - mark.t0;
  };
  for (const type of ["keydown", "input"]) {
    window.addEventListener(type, window.__timer, true);
    window.addEventListener(type, worked);
  }
  window.addEventListener("focusin", worked);
}"""

BUSY_ON = """() => {
  window.__busy = () => {
    const end = performance.now() + 30;
    while (performance.now() < end);
  };
  window.addEventListener("keydown", window.__busy, true);
}"""
BUSY_OFF = """() => window.removeEventListener("keydown", window.__busy, true)"""

MARK_DONE = "type => window.__mark?.type === type && window.__mark.work !== null && window.__mark.frame !== null"

SPEECH_CLOCK = """() => {
  const polite = document.getElementById("a11y-polite");
  window.__stepAt = null;
  window.__spokenAt = null;
  window.addEventListener("keydown", (e) => { if (e.key === "]") window.__stepAt ??= performance.now(); }, true);
  new MutationObserver(() => {
    if (polite.textContent.includes("Flat face 1")) window.__spokenAt ??= performance.now();
  }).observe(polite, { childList: true, characterData: true, subtree: true });
}"""

ROWS_ARE = "n => document.querySelector('[role=option]')?.getAttribute('aria-setsize') === n"
FIRST_PLACE = "() => document.querySelector('[role=option]')?.getAttribute('aria-posinset')"
ACTIVE_ROW = "() => document.activeElement?.getAttribute('role') === 'option'"
ACTIVE_ID = "() => document.activeElement?.id"


def comb_document():
    x, y = AT
    pitch = TOOTH_WIDE + GAP
    floor = y + SPINE
    top = floor + TOOTH_LONG
    outline = [(x, y), (x + TEETH * pitch - GAP, y)]
    for tooth in range(TEETH - 1, -1, -1):
        left = x + tooth * pitch
        outline += [(left + TOOTH_WIDE, top), (left, top)]
        if tooth:
            outline += [(left, floor), (left - GAP, floor)]
    lines = [
        {"type": "line", "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]}
        for a, b in zip(outline, outline[1:] + outline[:1])
    ]
    return {
        "version": 10,
        "parameters": {},
        "features": [
            {"id": "s", "type": "sketch", "plane": "XY", "entities": lines},
            {"id": "e", "type": "extrude", "name": "Comb", "sketch": "s", "distance": THICK, "operation": "new"},
        ],
    }


def tab_until(s, key, role):
    for _ in range(12):
        s.page.keyboard.press(key)
        if s.page.evaluate("() => document.activeElement?.getAttribute('role')") == role:
            return
    raise AssertionError(f"{key} never reached a {role}")


def to_canvas(s):
    for _ in range(8):
        s.page.keyboard.press("F6")
        if s.page.evaluate(ACTIVE_ID) == "canvas":
            return
    raise AssertionError("F6 never reached the canvas")


def next_frames(s):
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def timed(s, key, type="keydown"):
    s.page.evaluate("() => { window.__mark = null; }")
    s.page.keyboard.press(key)
    s.page.wait_for_function(MARK_DONE, arg=type)
    return s.page.evaluate("() => window.__mark")


# The median, as a garbage collection in the page lands on single presses. Only the work has a limit: a frame here is
# SwiftShader drawing the lit comb, which says little about the same frame on a graphics card.
def report(what, marks):
    work = statistics.median(m["work"] for m in marks)
    frame = statistics.median(m["frame"] for m in marks)
    print(f"MEASURED {what} work {work:.1f} ms, worst {max(m['work'] for m in marks):.1f} ms, frame {frame:.1f} ms")
    return work


@pytest.fixture(scope="module")
def comb(tmp_path_factory):
    path = tmp_path_factory.mktemp("comb") / "comb.json"
    path.write_text(json.dumps(comb_document()))
    return path


@pytest.fixture
def s(session, comb):
    session.press("Escape")
    session.open_file(comb)
    session.settle(timeout=120)
    assert [(b["faces"], b["fault"]) for b in session.bodies(raw=True)] == [(FACES, None)]
    session.page.evaluate(TIMER)
    yield session
    session.page.evaluate("() => document.activeElement?.blur()")
    session.page.keyboard.press("Escape")
    session.page.keyboard.press("Escape")


def browse(s):
    s.command("Browse Faces and Edges")
    s.page.wait_for_function(ACTIVE_ROW, timeout=30_000)


def test_the_timer_counts_a_handler_that_takes_its_time(s):
    to_canvas(s)
    s.page.evaluate(BUSY_ON)
    try:
        assert report("a handler of 30 ms", [timed(s, "]")]) >= 30
    finally:
        s.page.evaluate(BUSY_OFF)


def test_the_first_step_fetches_the_rows_inside_the_budget(s):
    s.page.evaluate(SPEECH_CLOCK)
    to_canvas(s)
    s.page.keyboard.press("]")
    s.page.wait_for_function("() => window.__spokenAt !== null", timeout=30_000)
    ms = s.page.evaluate("() => window.__spokenAt - window.__stepAt")
    print(f"MEASURED fetch to first spoken row {ms:.1f} ms")
    assert ms < BUDGET_MS["fetch"] * LIMIT


def test_a_page_turn_stays_inside_the_budget(s):
    browse(s)
    s.page.wait_for_function(ROWS_ARE, arg=str(FACES))
    marks = [timed(s, "PageDown") for _ in range(7)]
    s.page.wait_for_function("() => document.activeElement?.getAttribute('aria-posinset') === '701'")
    assert s.page.evaluate(FIRST_PLACE) == "701"
    assert s.page.get_by_role("option").count() == 100
    assert report("page turn", marks) < BUDGET_MS["page"] * LIMIT


def test_a_filter_over_all_rows_stays_inside_the_budget(s):
    browse(s)
    s.page.keyboard.press("Shift+Tab")
    timed(s, "1", "input")
    marks = []
    for _ in range(4):
        marks.append(timed(s, "0", "input"))
        s.page.wait_for_function(ROWS_ARE, arg=str(AT_LEAST_10))
        marks.append(timed(s, "Backspace", "input"))
        s.page.wait_for_function(ROWS_ARE, arg=str(FACES))
    assert report("filter", marks) < BUDGET_MS["filter"] * LIMIT


def test_a_bracket_step_stays_inside_the_budget_before_it_renders(s):
    browse(s)
    to_canvas(s)
    marks = []
    for _ in range(9):
        marks.append(timed(s, "]"))
        next_frames(s)
    # The focused first row is where the brackets went on from.
    s.page.wait_for_function("() => document.getElementById('a11y-polite').textContent.includes('Flat face 10,')")
    assert report("step", marks) < BUDGET_MS["step"] * LIMIT


def test_a_page_of_edge_rows_turns_inside_the_budget(s):
    browse(s)
    tab_until(s, "Shift+Tab", "radio")
    s.page.keyboard.press("ArrowRight")
    tab_until(s, "Tab", "option")
    s.page.wait_for_function(ROWS_ARE, arg=str(EDGES))
    marks = [timed(s, "PageDown") for _ in range(7)]
    assert report("edge page turn", marks) < BUDGET_MS["page"] * LIMIT

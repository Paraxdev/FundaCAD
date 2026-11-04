"""The sketch palette's Dimensions and Relations lists work by keys alone: a length is typed into its row and the
constraint it made is deleted from its Relations row, with no pointer event reaching the page."""

import math
from pathlib import Path

import pytest
from fundacad_harness import Session
from fundacad_harness.a11y import axe_violations, counts, over_baseline, read_baseline
from test_announcer import heard, listen
from test_sketch_keys import (
    COUNT_POINTERS,
    CONSTRAINTS,
    new_document_by_keys,
    no_pointer,
    point,
    shapes,
    to_items_plane,
    tool,
)

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

BASELINE = Path(__file__).with_name("axe_baseline.json")

# The accessible name of the focused control, its labelling element first as a FieldRow input has no aria-label.
FOCUSED = """() => {
  const a = document.activeElement;
  if (!a) return null;
  const by = a.getAttribute("aria-labelledby");
  if (by) return by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent.trim() ?? "").join(" ");
  return a.getAttribute("aria-label");
}"""
LISTS = """() => ({
  dimensions: [...document.querySelectorAll("#palette .dim-row label")].map((l) => l.textContent.trim()),
  relations: [...document.querySelectorAll("#palette .rel-row .ui-list-row")].map((r) => r.getAttribute("aria-label")),
  deletes: [...document.querySelectorAll("#palette .rel-row .rel-del")].map((b) => b.getAttribute("aria-label")),
  summary: document.querySelector("#palette .rel-summary")?.textContent.trim() ?? null,
})"""


def to_palette(s):
    for _ in range(10):
        s.page.keyboard.press("F6")
        if s.page.evaluate("() => !!document.activeElement?.closest('#palette')"):
            return
    raise AssertionError("F6 never reached the sketch palette")


def tab_to(s, name, limit=20):
    for _ in range(limit):
        if s.page.evaluate(FOCUSED) == name:
            return
        s.page.keyboard.press("Tab")
    raise AssertionError(f"Tab never reached {name!r}, last on {s.page.evaluate(FOCUSED)!r}")


def length(line):
    return math.hypot(line["x2"] - line["x1"], line["y2"] - line["y1"])


@pytest.fixture(scope="module", params=["navigator", "classic"])
def rig(request):
    session = Session()
    try:
        if request.param == "classic":
            session.page.goto(session.url + "&nav=legacy", wait_until="domcontentloaded", timeout=60_000)
            session._ensure_page()
        yield session
    finally:
        session.close()


@pytest.fixture
def s(rig):
    rig.press("Escape")
    new_document_by_keys(rig)
    listen(rig)
    rig.page.evaluate(COUNT_POINTERS)
    yield rig
    rig.page.keyboard.press("Escape")
    rig.page.keyboard.press("Escape")


def test_a_length_typed_in_its_row_drives_the_line_and_its_relation_row_deletes_it_by_keys(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "l", "line")
    point(s, 13, -4)
    kb.type("@18,7")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 1")
    kb.press("Escape")
    assert shapes(s) == [{"type": "line", "x1": 13, "y1": -4, "x2": 31, "y2": 3}]
    s.page.wait_for_function("() => document.querySelectorAll('#palette .dim-row').length === 1")
    assert s.page.evaluate(LISTS) == {
        "dimensions": ["Length of Line 1"],
        "relations": [],
        "deletes": [],
        "summary": "Not constrained",
    }

    to_palette(s)
    tab_to(s, "Length of Line 1")
    kb.press("Control+A")
    kb.type("30")
    assert s.page.evaluate("() => document.activeElement.value") == "30"
    listen(s)
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.constraints.length === 1")
    heard(s, "3 degrees of freedom")
    line = shapes(s)[0]
    assert length(line) == pytest.approx(30, abs=1e-6)
    # The start is held, the solver takes the change up at the end.
    assert [line["x1"], line["y1"]] == pytest.approx([13, -4], abs=1e-6)
    made = s.page.evaluate(CONSTRAINTS)
    assert [{k: v for k, v in c.items() if k != "id"} for c in made] == [
        {"type": "distance", "line": s.page.evaluate("() => window.sketch.entities[0].id"), "value": 30}
    ]

    s.page.wait_for_function("() => document.querySelectorAll('#palette .rel-row').length === 1")
    lists = s.page.evaluate(LISTS)
    assert lists["dimensions"] == ["Length of Line 1"]
    assert lists["summary"] == "3 degrees of freedom"
    [row] = lists["relations"]
    assert "30" in row and "Line 1" in row, row
    assert lists["deletes"] == [f"Delete {row}"]
    allowed = read_baseline(BASELINE).get("sketch", {})
    assert over_baseline(counts(axe_violations(s.page)), allowed) == []

    tab_to(s, row)
    listen(s)
    kb.press("Delete")
    s.page.wait_for_function("() => window.sketch.constraints.length === 0")
    assert any(t.startswith("Deleted") and "Line 1" in t for t in heard(s, "Deleted"))
    heard(s, "Not constrained")
    s.page.wait_for_function("() => document.activeElement?.classList.contains('rel-summary')")
    assert s.page.evaluate(LISTS) == {
        "dimensions": ["Length of Line 1"],
        "relations": [],
        "deletes": [],
        "summary": "Not constrained",
    }
    assert length(shapes(s)[0]) == pytest.approx(30, abs=1e-6)
    no_pointer(s)

    kb.press("Escape")
    kb.press("Escape")
    new_document_by_keys(s)
    listen(s)
    to_items_plane(s)
    # Past the 400 ms delay of a freedom line, as entry must say none.
    s.page.wait_for_timeout(800)
    spoken = s.page.evaluate("() => window.__spoken")
    assert not any("freedom" in t or "constrained" in t or "defined" in t for t in spoken), spoken
    assert shapes(s) == []
    assert s.page.evaluate(CONSTRAINTS) == []
    lists = s.page.evaluate(LISTS)
    assert {k: v for k, v in lists.items() if k != "summary"} == {"dimensions": [], "relations": [], "deletes": []}
    assert s.page.evaluate("() => document.querySelector('#palette .dim-empty')?.textContent.trim()")
    no_pointer(s)


LAYOUT = """() => {
  const p = document.querySelector("#palette");
  const box = (el) => el && { shown: el.clientHeight, full: el.scrollHeight };
  const [relations, shapes] = [...p.querySelectorAll(".rel-list")];
  return {
    bottom: Math.round(p.getBoundingClientRect().bottom),
    window: innerHeight,
    card: box(p),
    dimensions: box(p.querySelector(".dim-list")),
    relations: box(relations),
    shapes: box(shapes ?? null),
    offset: (() => {
      const a = p.getBoundingClientRect(),
        b = p.parentElement.getBoundingClientRect();
      return [Math.round(a.top - b.top), Math.round(b.right - a.right)];
    })(),
  };
}"""


def test_a_busy_sketch_keeps_each_list_to_its_rows_and_the_palette_inside_the_window(s):
    kb = s.page.keyboard
    to_items_plane(s)
    for i in range(10):
        tool(s, "r", "rectangle")
        point(s, round(-47.5 + 11.25 * i, 2), round(31 - 7.5 * i, 2))
        kb.type(str(14 + 3 * i))
        kb.press("Tab")
        kb.type(str(9 + i))
        kb.press("Enter")
        s.page.wait_for_function("n => window.sketch.entities.length === n", arg=i + 1)
    kb.press("Escape")
    s.page.wait_for_function("() => document.querySelectorAll('#palette .rel-list .rel-row').length === 20")
    s.page.locator("#palette button").filter(has_text="Shapes").first.focus()
    kb.press("Enter")
    s.page.wait_for_function("() => document.querySelectorAll('#palette .rel-list').length === 2")
    got = s.page.evaluate(LAYOUT)
    assert got["bottom"] <= got["window"], repr(got)
    assert got["offset"] == [0, 0], repr(got)
    assert got["card"]["full"] > got["card"]["shown"], got
    for name in ("dimensions", "relations", "shapes"):
        assert got[name]["shown"] == min(got[name]["full"], 216), (name, got)
    no_pointer(s)


SCREEN = """([x, y]) => {
  const p = window.viewport.projectToScreen(window.sketch.plane.to3D(x, y));
  return [p.x, p.y];
}"""
CANVAS = """() => ({
  inPalette: !!document.activeElement?.closest("#palette"),
  lines: window.sketch.entities.map((e) => e.id),
  constraints: window.sketch.constraints.length,
  selected: [...window.sketch.selected],
})"""


# The Shapes list's rows share the class, and a busy sketch case before this one leaves it open.
RELATION = "#palette .rel-row:has(.rel-del)"


def click_on_sketch(s, x, y):
    s.page.mouse.click(*s.page.evaluate(SCREEN, [x, y]))
    s.page.wait_for_timeout(300)


def test_a_canvas_click_after_a_palette_click_gives_delete_back_to_the_canvas_selection(s):
    kb = s.page.keyboard
    to_items_plane(s)
    for n, (start, end) in enumerate((((13, -4), "@18,7"), ((-20, 9), "@-11,14")), 1):
        tool(s, "l", "line")
        point(s, *start)
        kb.type(end)
        kb.press("Enter")
        s.page.wait_for_function("n => window.sketch.entities.length === n", arg=n)
        kb.press("Escape")
    kb.press("Escape")
    s.page.wait_for_function("() => window.sketch.tool === 'select'")
    line1, line2 = s.page.evaluate(CANVAS)["lines"]
    to_palette(s)
    for n, (name, value) in enumerate((("Length of Line 1", "30"), ("Length of Line 2", "21")), 1):
        tab_to(s, name)
        kb.press("Control+A")
        kb.type(value)
        kb.press("Enter")
        s.page.wait_for_function("n => window.sketch.constraints.length === n", arg=n)
    s.page.wait_for_function("() => document.querySelectorAll('#palette .rel-del').length === 2")

    # A row clicked selects its line and keeps focus, a click on the other line must take Delete back.
    s.page.locator(f"{RELATION} .ui-list-row").filter(has_text="Line 1").click()
    s.page.wait_for_function("id => [...window.sketch.selected].join() === id", arg=line1)
    click_on_sketch(s, -25.5, 16)
    got = s.page.evaluate(CANVAS)
    assert got == {"inPalette": False, "lines": [line1, line2], "constraints": 2, "selected": [line2]}, got
    kb.press("Delete")
    s.page.wait_for_function("() => window.sketch.entities.length === 1")
    assert s.page.evaluate(CANVAS)["lines"] == [line1]
    assert s.page.evaluate(CANVAS)["constraints"] == 1

    # The X moves focus to the summary, which must not keep Delete from the line clicked next.
    row = s.page.locator(RELATION).first
    row.hover()
    row.locator(".rel-del").click()
    s.page.wait_for_function("() => window.sketch.constraints.length === 0")
    s.page.wait_for_timeout(300)
    click_on_sketch(s, 22, -0.5)
    assert s.page.evaluate(CANVAS) == {"inPalette": False, "lines": [line1], "constraints": 0, "selected": [line1]}
    kb.press("Delete")
    s.page.wait_for_function("() => window.sketch.entities.length === 0")

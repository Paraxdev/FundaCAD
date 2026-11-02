"""Ctrl+Z in a tool's value box takes back the typing, then does what menu Undo does, the tool staying open."""

import pytest

pytestmark = pytest.mark.browser

BLOCK = "tools/harness/fixtures/block.json"
PLATE = "tools/harness/fixtures/plate.json"
OPEN = {
    "Shell": ("top", "front", "field:distance"),
    "Fillet": ("between top front", "between top back", "field:radius"),
    "Extrude": ("top", "front", "D"),
}
STATE = """() => {
  const box = [...document.querySelectorAll('.dim-input')].find((b) => getComputedStyle(b).display !== 'none');
  const input = box?.querySelector('input:not([type=checkbox])');
  return {
    open: !!box,
    value: input?.value ?? null,
    focused: !!input && document.activeElement === input,
    steps: window.store.document.features.length,
  };
}"""


@pytest.fixture
def s(session):
    yield session
    session.press("Escape")


def tool_on_second_pick(s, tool):
    """A step of the tool already made, the tool open again on another pick, its field focused."""
    first, second, field = OPEN[tool]
    pick = s.pick_edge if tool == "Fillet" else s.pick_face
    s.press("Escape")
    s.new_document()
    s.open_file(BLOCK)
    s.view("iso")
    pick(first)
    s.tool(tool)
    s.page.keyboard.type("1")
    s.press("Enter")
    s.settle()
    s.press("Escape")
    pick(second)
    s.tool(tool)
    s.settle()
    return field


def state(s):
    s.settle()
    return s.page.evaluate(STATE)


@pytest.mark.parametrize("tool", OPEN)
def test_untouched_field_undoes_like_the_menu_and_the_tool_stays(s, tool):
    tool_on_second_pick(s, tool)
    start = state(s)
    s.press("Ctrl+Z")
    key = state(s)
    assert key == {**start, "steps": start["steps"] - 1}
    s.press("Ctrl+Y")
    assert state(s) == start

    tool_on_second_pick(s, tool)
    s.menu("Edit/Undo")
    menu = state(s)
    assert {k: menu[k] for k in ("open", "value", "steps")} == {k: key[k] for k in ("open", "value", "steps")}


@pytest.mark.parametrize("tool", OPEN)
def test_typing_in_the_field_is_undone_first_then_the_previous_step(s, tool):
    field = tool_on_second_pick(s, tool)
    start = state(s)
    s.page.keyboard.type("7")
    assert state(s)["value"] == "7"
    s.press("Ctrl+Z")
    assert state(s) == start, "the field's own undo leaves the document alone"
    s.press("Ctrl+Y")
    assert state(s) == {**start, "value": "7"}
    s.press("Ctrl+Z")
    assert state(s) == start
    s.press("Ctrl+Z")
    assert state(s) == {**start, "steps": start["steps"] - 1}
    s.type(field, "1.5")
    s.press("Enter")
    after = state(s)
    assert (after["open"], after["steps"]) == (False, start["steps"]), "the tool still commits"


FIELDS = """() => {
  const box = [...document.querySelectorAll('.dim-input')].find((b) => getComputedStyle(b).display !== 'none');
  return {
    open: !!box,
    values: box ? [...box.querySelectorAll('input:not([type=checkbox])')].map((x) => x.value) : null,
    steps: window.store.document.features.map((f) => f.type),
    redo: !!window.store.canRedo,
  };
}"""
ADD_BOX_STEP = "() => window.store.addFeature({ id: 'late', type: 'box', length: 7, width: 6, height: 3 })"
ADD_SKETCH_STEP = """() => window.store.addFeature({
  id: 's', type: 'sketch', name: 'S', plane: 'XY',
  entities: [{ type: 'rectangle', id: 'r1', width: 10, height: 10, x: 40, y: 3 }],
})"""


def fields(s):
    s.settle()
    return s.page.evaluate(FIELDS)


def sweep(s, *points):
    """Real mouse moves over the canvas, as fractions of it: a tracking box follows them."""
    for fx, fy in points:
        x, y = s.page.evaluate(
            f"""() => {{
              const r = [...document.querySelectorAll('canvas')].sort((a, b) => b.width - a.width)[0]
                .getBoundingClientRect();
              return [r.left + r.width * {fx}, r.top + r.height * {fy}];
            }}"""
        )
        s.page.mouse.move(x, y, steps=4)
        s.settle()


def extrude_on_sketch(s, later_step=False):
    s.press("Escape")
    s.new_document()
    s.open_file(PLATE)
    s.view("iso")
    s.page.evaluate(ADD_SKETCH_STEP)
    s.settle()
    if later_step:
        s.page.evaluate(ADD_BOX_STEP)
        s.settle()
    s.click("feature:s")
    s.settle()
    s.tool("Extrude")
    s.settle()
    s.click_at(world=(40, 3, 0))
    s.settle()


def last_step(s):
    return s.page.evaluate("() => window.store.document.features.at(-1)")


def test_extrude_on_a_sketch_undoes_a_later_step_and_stays(s):
    extrude_on_sketch(s, later_step=True)
    start = fields(s)
    assert start["open"] and start["steps"] == ["box", "sketch", "box"]
    s.page.keyboard.type("7")
    assert fields(s)["values"][0] == "7"
    s.press("Ctrl+Z")
    assert fields(s) == start, "the field's own undo leaves the document alone"
    s.press("Ctrl+Z")
    after = fields(s)
    assert (after["open"], after["steps"], after["redo"]) == (True, ["box", "sketch"], True)
    s.page.keyboard.type("6.5")
    s.press("Enter")
    s.settle()
    assert s.last_error() == "none"
    assert last_step(s)["distance"] == 6.5


def test_typing_the_tracked_value_locks_it_against_the_mouse(s):
    extrude_on_sketch(s)
    sweep(s, (0.5, 0.35))
    shown = fields(s)["values"][0]
    assert shown not in ("", "0")
    s.page.keyboard.type(shown)
    sweep(s, (0.5, 0.2), (0.6, 0.65))
    assert fields(s)["values"][0] == shown
    s.press("Enter")
    s.settle()
    assert last_step(s)["distance"] == float(shown)


def test_undoing_the_typed_tracked_value_lets_the_mouse_drive_again(s):
    extrude_on_sketch(s)
    sweep(s, (0.5, 0.35))
    shown = fields(s)["values"][0]
    s.page.keyboard.type(shown)
    s.press("Ctrl+Z")
    assert fields(s)["steps"] == ["box", "sketch"]
    sweep(s, (0.5, 0.2), (0.6, 0.65))
    assert fields(s)["values"][0] != shown

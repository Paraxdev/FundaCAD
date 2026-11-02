"""Ctrl+Z in a tool's value box takes back the typing, with none left the tool closes and the document undoes."""

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
def test_untouched_field_closes_the_tool_and_undoes_and_the_menu_keeps_it(s, tool):
    tool_on_second_pick(s, tool)
    start = state(s)
    s.press("Ctrl+Z")
    assert (state(s)["open"], state(s)["steps"]) == (False, start["steps"] - 1)
    s.press("Ctrl+Y")
    assert (state(s)["open"], state(s)["steps"]) == (False, start["steps"])

    tool_on_second_pick(s, tool)
    s.menu("Edit/Undo")
    menu = state(s)
    assert (menu["open"], menu["value"], menu["steps"]) == (True, start["value"], start["steps"] - 1)


@pytest.mark.parametrize("tool", OPEN)
def test_typing_in_the_field_is_undone_first_then_the_tool_closes_on_the_previous_step(s, tool):
    tool_on_second_pick(s, tool)
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
    after = state(s)
    assert (after["open"], after["steps"]) == (False, start["steps"] - 1), "no typing left, as an untouched field"
    s.press("Ctrl+Y")
    assert state(s)["steps"] == start["steps"]


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


def test_extrude_on_a_sketch_takes_typing_back_then_closes_on_a_later_step(s):
    extrude_on_sketch(s, later_step=True)
    start = fields(s)
    assert start["open"] and start["steps"] == ["box", "sketch", "box"]
    s.page.keyboard.type("7")
    assert fields(s)["values"][0] == "7"
    s.press("Ctrl+Z")
    assert fields(s) == start, "the field's own undo leaves the document alone"
    s.press("Ctrl+Z")
    assert fields(s) == {"open": False, "values": None, "steps": ["box", "sketch"], "redo": True}
    assert s.page.evaluate("() => window.extrude.active") is False


def test_extrude_on_a_sketch_stays_when_the_menu_undoes_a_later_step(s):
    extrude_on_sketch(s, later_step=True)
    s.menu("Edit/Undo")
    after = fields(s)
    assert (after["open"], after["steps"], after["redo"]) == (True, ["box", "sketch"], True)
    s.type("D", "6.5")
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


@pytest.mark.parametrize("how", ["Ctrl+Z", "menu"])
def test_extrude_closes_when_its_sketch_is_undone_and_the_redo_survives(s, how):
    extrude_on_sketch(s)
    assert fields(s)["open"]
    s.press("Ctrl+Z") if how == "Ctrl+Z" else s.menu("Edit/Undo")
    assert fields(s) == {"open": False, "values": None, "steps": ["box"], "redo": True}
    assert s.page.evaluate("() => window.extrude.active") is False
    s.press("Ctrl+Y")
    assert fields(s) == {"open": False, "values": None, "steps": ["box", "sketch"], "redo": False}
    assert s.last_error() == "none"


def reedit_fillet(s, later_step=False):
    s.press("Escape")
    s.new_document()
    s.open_file(BLOCK)
    s.view("iso")
    s.pick_edge("between top front")
    s.tool("Fillet")
    s.page.keyboard.type("1.5")
    s.press("Enter")
    s.settle()
    s.press("Escape")
    fillet = s.page.evaluate("() => window.store.document.features.at(-1).id")
    if later_step:
        s.page.evaluate(ADD_BOX_STEP)
        s.settle()
    s.click(f"feature:{fillet}", double=True)
    s.settle()


@pytest.mark.parametrize("how", ["Ctrl+Z", "menu"])
def test_reedit_closes_when_its_step_is_undone_and_the_redo_survives(s, how):
    reedit_fillet(s)
    opened = fields(s)
    assert (opened["open"], opened["values"]) == (True, ["1.5"])
    s.press("Ctrl+Z") if how == "Ctrl+Z" else s.menu("Edit/Undo")
    assert fields(s) == {"open": False, "values": None, "steps": ["box"], "redo": True}
    assert s.page.evaluate("() => [window.edgeFeature.active, window.store.editPreviewId]") == [False, None]
    s.press("Ctrl+Y")
    after = fields(s)
    assert (after["open"], after["steps"]) == (False, ["box", "fillet"])
    assert s.last_error() == "none"


def test_reedit_closes_when_the_key_removes_a_later_step(s):
    reedit_fillet(s, later_step=True)
    s.press("Ctrl+Z")
    after = fields(s)
    assert (after["open"], after["steps"], after["redo"]) == (False, ["box", "fillet"], True)


def test_reedit_stays_when_the_menu_removes_a_later_step(s):
    reedit_fillet(s, later_step=True)
    s.menu("Edit/Undo")
    after = fields(s)
    assert (after["open"], after["steps"], after["redo"]) == (True, ["box", "fillet"], True)
    s.type("field:radius", "2.25")
    s.press("Enter")
    s.settle()
    assert (s.last_error(), last_step(s)["radius"]) == ("none", 2.25)


def test_two_typed_fields_are_taken_back_before_the_sketch_has_the_key(s):
    s.press("Escape")
    s.new_document()
    s.open_file(BLOCK)
    s.view("iso")
    s.pick_face("top")
    s.tool("Sketch")
    s.settle()
    s.press("r")
    s.settle()
    s.click_at(sketch=(-2, 1))
    s.settle()
    sweep(s, (0.55, 0.45))
    s.page.keyboard.type("4.5")
    s.press("Tab")
    s.page.keyboard.type("3.5")
    s.press("Enter")
    s.settle()
    drawn = s.page.evaluate("() => window.sketch.entities.length")
    assert drawn == 1
    s.click_at(sketch=(3, 2))
    s.settle()
    sweep(s, (0.6, 0.4))
    tracked = fields(s)["values"]
    s.page.keyboard.type("7")
    s.press("Tab")
    s.page.keyboard.type("8")
    s.press("Shift+Tab")
    assert fields(s)["values"] == ["7", "8"]

    s.press("Ctrl+Z")
    assert fields(s)["values"] == ["7", tracked[1]], "the last typed goes first"
    s.press("Ctrl+Z")
    assert fields(s)["values"] == tracked
    assert s.page.evaluate("() => window.sketch.entities.length") == drawn, "the sketch not touched yet"
    s.press("Ctrl+Z")
    assert s.page.evaluate("() => window.sketch.entities.length") == drawn - 1
    s.press("Escape")
    s.press("Escape")


def type_seven_and_take_it_back(s):
    s.page.keyboard.type("7")
    s.page.wait_for_timeout(400)
    s.page.keyboard.press("Control+z")


def open_on_block(s, tool):
    s.press("Escape")
    s.new_document()
    s.open_file(BLOCK)
    s.view("iso")
    s.pick_edge("between top front") if tool == "Fillet" else s.pick_face("top")
    s.tool(tool)
    s.settle()


@pytest.mark.parametrize("tool", ["Shell", "Extrude"])
def test_enter_straight_after_a_field_undo_on_a_face_commits_nothing_as_the_field_shows_nothing(s, tool):
    open_on_block(s, tool)
    start = fields(s)
    assert start["values"][0] == "0"
    type_seven_and_take_it_back(s)
    s.page.keyboard.press("Enter")
    assert fields(s)["steps"] == ["box"], "the 7 was taken back"
    assert fields(s)["values"] == start["values"]
    assert s.bodies(raw=True)[0]["faces"] == 6, "nor does the preview keep it"


def test_enter_straight_after_a_field_undo_commits_the_fillet_the_field_shows(s):
    open_on_block(s, "Fillet")
    shown = fields(s)["values"][0]
    type_seven_and_take_it_back(s)
    s.page.keyboard.press("Enter")
    s.settle()
    assert (s.last_error(), last_step(s)["radius"]) == ("none", float(shown))


@pytest.mark.parametrize("towards", [(0.5, 0.35), (0.5, 0.85)])
def test_enter_straight_after_a_field_undo_commits_the_extrude_the_field_shows(s, towards):
    extrude_on_sketch(s)
    sweep(s, towards)
    shown = fields(s)["values"][0]
    dragged = s.page.evaluate("() => window.extrude.distance")
    assert abs(abs(dragged) - float(shown)) < 0.01
    type_seven_and_take_it_back(s)
    assert fields(s)["values"][0] == shown
    s.page.keyboard.press("Enter")
    s.settle()
    assert last_step(s)["distance"] == pytest.approx(dragged, abs=1e-3), "the drag's depth and its side"

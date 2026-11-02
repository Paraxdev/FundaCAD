"""Ctrl+Z in a tool's value box takes back the typing, then does what menu Undo does, the tool staying open."""

import pytest

pytestmark = pytest.mark.browser

BLOCK = "tools/harness/fixtures/block.json"
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

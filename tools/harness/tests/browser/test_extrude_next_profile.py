"""With an extrude open and its depth set, a click inside the next sketch profile keeps the extrude and starts Extrude on
that profile, whether the plate lies behind the profile or not. The profile wins over the face behind it, so no
Press/Pull starts. Esc backs the new step out, Ctrl+Z takes back one step and closes it, and once the new extrude is
written one Ctrl+Z takes back only that. A tool run from the command search (Ctrl+F) carries on the same way, and says
why while the depth is not set."""

import pytest
from fundacad_harness import Session

pytestmark = [pytest.mark.browser]

PLATE = "tools/harness/fixtures/plate.json"
SKETCH = """([id, x, z]) => window.store.addFeature({
  id, type: 'sketch', name: id.toUpperCase(), plane: { origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] },
  entities: [{ type: 'rectangle', id: id + 'r', width: 8, height: 8, x, y: 0 }],
})"""
TOP = """() => {
  const p = window.store.buildState.result.mesh.positions;
  let top = -Infinity;
  for (let i = 2; i < p.length; i += 3) top = Math.max(top, p[i]);
  return top;
}"""
BUILT = "() => window.store.hasPreview && !window.store.buildState.building"
STATE = """() => ({
  extrude: window.extrude.active,
  pressPull: window.pressPull.active,
  fillet: window.edgeFeature.active ? window.edgeFeature.kind : null,
  types: window.store.document.features.map((f) => f.type),
  sketches: window.extrude.active ? window.extrude.profileSketches : [],
  rests: window.extrude.active ? window.extrude.dependsOn() : [],
})"""
NEXT_OPEN = """(id) => window.extrude.active && window.extrude.profileSketches.includes(id)
  && window.store.hasPreview && !window.store.buildState.building"""


@pytest.fixture(scope="module")
def rig():
    session = Session()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def s(rig):
    rig.press("Escape")
    rig.new_document()
    rig.open_file(PLATE)
    rig.view("iso")
    rig.top = rig.page.evaluate(TOP)
    yield rig
    for _ in range(3):
        rig.page.keyboard.press("Escape")


def state(s):
    return s.page.evaluate(STATE)


def sketches(s, *placed):
    for sid, x in placed:
        s.page.evaluate(SKETCH, [sid, x, s.top])
    s.settle()


def open_extrude(s, x=-10):
    """Extrude on S1 with its depth typed, which sets it."""
    s.click("feature:s1")
    s.settle()
    s.tool("Extrude")
    s.settle()
    s.click_at(world=(x, 0, s.top))
    s.settle()
    s.type("field:distance", "6")
    s.page.wait_for_function(BUILT, timeout=20000)
    s.settle()


def carry_to(s, sid, x):
    before = state(s)["types"]
    s.click_at(world=(x, 0, s.top))
    s.page.wait_for_function(NEXT_OPEN, arg=sid, timeout=20000)
    s.settle()
    st = state(s)
    assert st["sketches"] == [sid], st
    assert st["pressPull"] is False and st["fillet"] is None, st
    assert st["types"] == [*before, "extrude"], st
    assert len(st["rests"]) == 1, st
    return before


def history_types(s):
    return [r["type"] for r in s.history(raw=True)["rows"]]


@pytest.mark.parametrize("x", [10, 32], ids=["on-the-plate", "off-the-plate"])
def test_a_click_inside_the_next_profile_keeps_the_extrude_and_extrudes_the_profile(s, x):
    sketches(s, ("s1", -10), ("s2", x))
    open_extrude(s)
    carry_to(s, "s2", x)
    s.type("field:distance", "3", enter=True)
    s.settle()
    types = history_types(s)
    assert types.count("extrude") == 2, types
    assert "press-pull" not in types, types
    assert state(s)["extrude"] is False
    assert s.page_errors() == []


def test_a_click_on_its_own_profile_goes_on_as_before_and_starts_no_second_extrude(s):
    sketches(s, ("s1", -10))
    open_extrude(s)
    before = state(s)["types"]
    s.click_at(world=(-10, 0, s.top))
    s.settle()
    st = state(s)
    assert st["extrude"] is False, st
    assert st["types"] == [*before, "extrude"], st


def test_esc_backs_the_next_extrude_out_and_keeps_the_first(s):
    sketches(s, ("s1", -10), ("s2", 10))
    open_extrude(s)
    before = carry_to(s, "s2", 10)
    s.press("Escape")
    s.settle()
    st = state(s)
    assert st["extrude"] is False and st["types"] == [*before, "extrude"], st
    assert s.page_errors() == []


def test_ctrl_z_takes_back_one_step_and_closes_the_next_extrude(s):
    sketches(s, ("s1", -10), ("s2", 10))
    open_extrude(s)
    before = carry_to(s, "s2", 10)
    s.press("Control+z")
    s.settle()
    st = state(s)
    assert st["extrude"] is False and st["types"] == before, st
    assert s.page_errors() == []


def test_one_ctrl_z_after_the_next_extrude_is_written_takes_back_only_that_one(s):
    sketches(s, ("s1", -10), ("s2", 10))
    open_extrude(s)
    before = carry_to(s, "s2", 10)
    s.type("field:distance", "3", enter=True)
    s.settle()
    assert history_types(s).count("extrude") == 2
    s.press("Control+z")
    s.settle()
    assert state(s)["types"] == [*before, "extrude"]
    assert s.page_errors() == []


@pytest.mark.parametrize(
    "command,started",
    [
        ("Fillet", "() => window.edgeFeature.active && window.edgeFeature.kind === 'fillet'"),
        ("Chamfer", "() => window.edgeFeature.active && window.edgeFeature.kind === 'chamfer'"),
        ("Press/Pull", "() => window.pressPull.active"),
    ],
)
def test_a_tool_from_the_command_search_keeps_the_extrude_and_starts(s, command, started):
    sketches(s, ("s1", -10))
    open_extrude(s)
    before = state(s)["types"]
    s.command(command)
    s.page.wait_for_function(started, timeout=20000)
    s.settle()
    st = state(s)
    assert st["extrude"] is False and st["types"] == [*before, "extrude"], st
    assert s.page_errors() == []


def test_fillet_from_the_command_search_says_why_while_the_depth_is_not_set(s):
    sketches(s, ("s1", -10))
    s.click("feature:s1")
    s.settle()
    s.tool("Extrude")
    s.settle()
    s.click_at(world=(-10, 0, s.top))
    s.settle()
    before = state(s)["types"]
    s.command("Fillet")
    s.settle()
    st = state(s)
    assert st["extrude"] is True and st["fillet"] is None and st["types"] == before, st
    assert "Set the depth first" in s.status(), s.status()

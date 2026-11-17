"""With a Press/Pull open and its push set, a click inside a sketch profile keeps the push and starts Extrude on that
profile, whether the plate lies behind the profile or not. The profile wins over the face behind it, so no second
Press/Pull starts."""

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


def history_types(s):
    return [r["type"] for r in s.history(raw=True)["rows"]]


# Over the plate the profile floats above the pushed top, so it is in front of the face behind it.
@pytest.mark.parametrize("x,lift", [(10, 4), (32, 0)], ids=["over-the-plate", "off-the-plate"])
def test_a_click_inside_a_profile_keeps_the_push_and_extrudes_the_profile(s, x, lift):
    z = s.top + lift
    # Picked first, a profile floating over the top would take the click.
    s.pick_face("top")
    s.page.evaluate(SKETCH, ["s2", x, z])
    s.settle()
    before = state(s)["types"]
    s.press("q")
    s.page.wait_for_function("() => window.pressPull.active", timeout=20000)
    s.type("field:distance", "2")
    s.page.wait_for_function(BUILT, timeout=20000)
    s.settle()
    s.click_at(world=(x, 0, z))
    s.page.wait_for_function(NEXT_OPEN, arg="s2", timeout=20000)
    s.settle()
    st = state(s)
    assert st["sketches"] == ["s2"], st
    assert st["pressPull"] is False and st["fillet"] is None, st
    assert st["types"] == [*before, "press-pull"], st
    assert len(st["rests"]) == 1, st
    s.type("field:distance", "3", enter=True)
    s.settle()
    types = history_types(s)
    assert types.count("press-pull") == 1 and types.count("extrude") == 1, types
    assert state(s)["extrude"] is False
    assert s.page_errors() == []

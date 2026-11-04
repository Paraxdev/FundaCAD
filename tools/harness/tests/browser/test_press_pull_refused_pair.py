FIXTURE = "tools/harness/fixtures/filleted_box.json"
BLEND = "near=43.59,24.29,34.75"
STATE = """() => { const v = window.viewport; const ghosts = [];
 v.scene.scene.traverse(o => { const m = o.material; if (!o.isMesh || !o.visible || !m) return;
  const ms = Array.isArray(m) ? m : [m]; const n = o.geometry.getAttribute('position')?.count || 0;
  if (n >= 300 && ms.some(x => x.transparent && x.opacity < 0.5)) ghosts.push(o.name || o.type); });
 return { stale: v.stale, outOfDate: v.outOfDate, ghosts, refusal: window.store.previewError }; }"""


def test_a_push_of_the_round_face_and_the_top_builds_with_no_ghost(session):
    s = session
    s.open_file(FIXTURE)
    s.view("iso")
    s.settle()
    s.pick_face(BLEND)
    s.pick_face("top", add=True)
    s.press("q")
    s.type("D", "7")
    s.settle()
    st = s.page.evaluate(STATE)
    assert not st["refusal"], st
    assert not s.call("status").get("prompt", "").startswith("Refused")
    assert not st["stale"] and not st["outOfDate"]
    assert st["ghosts"] == []
    s.press("Enter")
    s.settle()
    rows = s.history(raw=True)["rows"]
    assert rows[-1]["type"] == "press-pull", rows
    assert rows[-1]["state"] == "", rows
    assert s.page.evaluate(STATE)["ghosts"] == []
    assert s.page_errors() == []

FIXTURE = "tools/harness/fixtures/filleted_box.json"
STATE = """() => { const v = window.viewport; let see = 0;
 v.scene.scene.traverse(o => { if (!o.isMesh || !o.visible || o.userData.owner === undefined) return;
  const ms = Array.isArray(o.material) ? o.material : [o.material]; if (ms.some(m => m.transparent && m.opacity < 1)) see++; });
 return { peek: [...v.peek], ghosted: v.ghosted, mode: window.pressPull.mode, see }; }"""


def test_switching_from_cut_to_join_stops_seeing_through_the_body(session):
    s = session
    s.open_file(FIXTURE)
    s.view("iso")
    s.settle()
    s.pick_face("top")
    s.press("q")
    s.click("Cut")
    s.drag_handle(s.call("handles")[0].split(" ")[0], mm=-5)
    s.settle()
    st = s.page.evaluate(STATE)
    assert st["mode"] == "cut" and st["peek"] == ["body1"] and st["see"] == 1

    s.click("Join")
    s.settle()
    st = s.page.evaluate(STATE)
    assert st["mode"] == "join"
    assert st["peek"] == [] and not st["ghosted"] and st["see"] == 0

    s.press("Enter")
    s.settle()
    st = s.page.evaluate(STATE)
    assert st["peek"] == [] and not st["ghosted"] and st["see"] == 0
    assert s.page_errors() == []

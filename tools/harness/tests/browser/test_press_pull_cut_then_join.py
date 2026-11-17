"""Press/Pull keeps the body solid in Cut and Join, draws the outline of the push over it, and the pushed face stays
selected after each preview."""

FIXTURE = "tools/harness/fixtures/filleted_box.json"
STATE = """() => { const v = window.viewport; let see = 0;
 v.scene.scene.traverse(o => { if (!o.isMesh || !o.visible || o.userData.owner === undefined) return;
  const ms = Array.isArray(o.material) ? o.material : [o.material]; if (ms.some(m => m.transparent && m.opacity < 1)) see++; });
 const out = window.pressPull.outline;
 return { peek: [...v.peek], ghosted: v.ghosted, mode: window.pressPull.mode, see,
  segments: out ? out.segments : 0, color: out ? out.color : 0, faces: v.highlighter.getSelectedFaces().length }; }"""


def red_first(color):
    r, g, b = (color >> 16) & 255, (color >> 8) & 255, color & 255
    return r > g + 40 and r > b + 40


def test_cut_and_join_keep_the_body_solid_and_outline_the_push(session):
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
    assert st["mode"] == "cut" and st["peek"] == [] and not st["ghosted"] and st["see"] == 0
    assert st["segments"] > 0 and red_first(st["color"])
    assert st["faces"] == 1

    s.click("Join")
    s.settle()
    st = s.page.evaluate(STATE)
    assert st["mode"] == "join"
    assert st["peek"] == [] and not st["ghosted"] and st["see"] == 0
    assert st["segments"] > 0 and not red_first(st["color"])
    assert st["faces"] == 1

    s.press("Enter")
    s.settle()
    st = s.page.evaluate(STATE)
    assert st["peek"] == [] and not st["ghosted"] and st["see"] == 0 and st["segments"] == 0
    assert s.page_errors() == []

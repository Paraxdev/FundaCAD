"""Material tools end to end: fundacad-mcp attached to a harness window over its live session
sets a material, assigns it to a body and a face, and Ctrl+Z takes one assignment back
without a replacing load or a change to the stress study and environment."""

import json
import os
import re
import time

import pytest
from fundacad_harness.launch import find_repo
from test_guide_mode import Mcp, until

pytestmark = pytest.mark.browser

BLOCK = "tools/harness/fixtures/block.json"
FACE_ROW = re.compile(r'^\s*"(F\d+)": (\{.*\})$', re.M)
STORE = "window.__fundacad.store"


@pytest.fixture
def dressed(session, tmp_path):
    doc = json.loads((find_repo() / BLOCK).read_text())
    doc["stress"] = {
        "body": "body1",
        "supports": [{"id": 1, "type": "fixed", "faces": [{"kind": "face", "by": "nearest", "point": [10, 10, 0], "body": "body1"}]}],
        "loads": [],
        "gravity": {"on": True, "direction": "-Y"},
        "material": "PETG",
        "size": 2.5,
    }
    doc["environment"] = {"name": "Workshop", "settings": {"exposure": 1.35, "rotation": 37.5}}
    path = tmp_path / "dressed.json"
    path.write_text(json.dumps(doc))
    session.press("Escape")
    session.new_document()
    session.open_file(str(path))
    session.view("iso")
    sf = tmp_path / "session.json"
    sf.write_text(json.dumps({"port": session.engine_port, "token": session.token, "pid": os.getpid()}))
    mcp = Mcp(sf, tmp_path / "mcp.log")
    try:
        yield session, mcp
    finally:
        mcp.close()


def tool(mcp, tool_name: str, /, **args) -> tuple[bool, str]:
    res = mcp.rpc("tools/call", {"name": tool_name, "arguments": args})["result"]
    return bool(res.get("isError")), "\n".join(c.get("text", "") for c in res["content"])


def state(s) -> dict:
    return s.page.evaluate(
        f"""() => {{
          const st = {STORE}, o = st.toObject();
          return {{ loads: st.loadCount, version: o.version, features: o.features, stress: o.stress ?? null,
            environment: o.environment ?? null, library: st.materialLibrary.map((m) => m.id),
            bodyMaterial: o.bodyMaterial ?? {{}}, faceMaterials: o.faceMaterials ?? {{}} }};
        }}"""
    )


def canvas_png(s) -> bytes:
    return s.page.locator("canvas").first.screenshot()


def test_a_material_set_assigned_and_undone_in_the_open_window(dressed):
    s, mcp = dressed
    before = state(s)
    assert before["stress"] and before["environment"]

    err, out = tool(mcp, "material_set", id="m-brushed", name="Brushed steel", color="#ff2200", metalness=0.8, roughness=0.3)
    assert not err, out
    assert until(lambda: "m-brushed" in state(s)["library"]), (out, state(s)["library"])
    lib = s.page.evaluate(f"() => {STORE}.materialLibrary.find((m) => m.id === 'm-brushed')")
    assert (lib["metalness"], lib["roughness"]) == (0.8, 0.3), lib

    shot = canvas_png(s)
    err, out = tool(mcp, "material_assign", material="m-brushed", bodies=["body1"])
    assert not err, out
    assert until(lambda: state(s)["bodyMaterial"].get("body1") == "m-brushed"), (out, state(s))
    assert until(lambda: canvas_png(s) != shot, 5), "the canvas did not redraw"
    after = state(s)
    assert after["loads"] == before["loads"], "a replacing load ran"

    s.press("Control+z")
    assert until(lambda: "body1" not in state(s)["bodyMaterial"]), state(s)
    undone = state(s)
    assert undone["library"] == after["library"], "undo took the library edit too"
    for key in ("loads", "version", "features", "stress", "environment"):
        assert undone[key] == before[key], key


def test_a_face_picked_from_inspect_gets_the_material(dressed):
    s, mcp = dressed
    before = state(s)
    err, out = tool(mcp, "material_set", id="m-top", name="Top coat", color="#00aa55")
    assert not err, out
    err, out = tool(mcp, "inspect", detail=True, selectors=True)
    assert not err, out
    top = dict((k, json.loads(v)) for k, v in FACE_ROW.findall(out))["F5"]
    err, out = tool(mcp, "material_assign", material="m-top", faces=[top])
    assert not err, out
    assert until(lambda: state(s)["faceMaterials"]), (out, state(s))
    got = state(s)
    assert got["faceMaterials"] == {"body1#5": "m-top"}, got["faceMaterials"]
    assert got["bodyMaterial"] == {}
    for key in ("loads", "version", "features", "stress", "environment"):
        assert got[key] == before[key], key

    s.press("Control+z")
    assert until(lambda: not state(s)["faceMaterials"]), state(s)
    assert state(s)["loads"] == before["loads"]

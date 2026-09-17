"""The slicer project 3MF and the preset flattening. Run from sidecar/:
uv run python ../plugins/FundaCAD.Printing/geometry/tests/test_project3mf.py"""

import json
import os
import tempfile
import xml.etree.ElementTree as ET
import zipfile

import _bootstrap  # noqa: F401

import print_presets
import server
from builder import rebuild
from print_project3mf import sanitize_inputs

PASS = "  ok"

DOC = {"parameters": {}, "features": [
    {"id": "s1", "type": "sketch", "plane": "XY",
     "entities": [{"type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]},
    {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"},
    {"id": "s2", "type": "sketch", "plane": "XY",
     "entities": [{"type": "rectangle", "width": 20, "height": 20, "x": 40, "y": 0}]},
    {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 5, "operation": "new"},
]}


def test_sanitize():
    palette, colors0, _ = sanitize_inputs(
        [{"name": "Red", "color": "#e03030"}, {"name": "Blue", "color": "3050E0FF"}],
        {"x": 99}, {},
    )
    assert palette[1]["color"] == "#3050E0", "RRGGBBAA should normalize to #RRGGBB"
    assert not colors0, "out-of-range slot must be dropped"
    pal_mat, _, _ = sanitize_inputs(
        [{"name": "Red", "color": "#e03030", "material": "PLA"},
         {"name": "Blue", "color": "#3050E0"}], {}, {})
    assert pal_mat[0]["material"] == "PLA", "material must survive sanitize"
    assert "material" not in pal_mat[1], "absent material stays absent"
    print(PASS, "sanitize normalizes colours, drops bad slots, keeps materials")


def test_export_through_the_engine():
    """Through the engine's own exportWith job, the way the window reaches it:
    zip layout, per-object extruder metadata (1-based = slot+1, unassigned -> 1),
    palette -> filament_colour, shared bed-centering transform."""
    _, _, bodies = rebuild(DOC)
    assert len(bodies) == 2
    b0, b1 = bodies[0]["id"], bodies[1]["id"]

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "proj.3mf")
        res = server._plugin_export_job(DOC, path, "print-project-3mf", {
            "palette": [{"name": "Red", "color": "#E03030", "material": "PETG"},
                        {"name": "Blue", "color": "#3050E0"}],
            "bodyColors": {b1: 1},
            "bodyNames": {b0: "Left"},
            "settings": {"printer_variant": "0.6"},
        })
        assert "error" not in res, f"export failed: {res}"
        assert res.get("info") == {}, res

        with zipfile.ZipFile(res["path"]) as z:
            entries = set(z.namelist())
            for want in ("[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model",
                         "Metadata/model_settings.config",
                         "Metadata/project_settings.config"):
                assert want in entries, f"missing zip entry {want}"
            model = ET.fromstring(z.read("3D/3dmodel.model"))
            cfg = ET.fromstring(z.read("Metadata/model_settings.config"))
            proj = json.loads(z.read("Metadata/project_settings.config"))

    core = "{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}"
    objs = model.findall(f".//{core}object")
    assert len(objs) == 2
    assert objs[0].get("name") == "Left", "bodyNames rename must win"
    items = model.findall(f".//{core}item")
    assert len(items) == 2 and items[0].get("transform") == items[1].get("transform"), \
        "assembly must share ONE transform"

    # the combined bbox center lands at bed center (135,135) and z-min drops to 0:
    # doc spans x in [-10,50] y in [-10,10] z in [0,5] -> tx=115 ty=135
    tx, ty, tz = (float(v) for v in items[0].get("transform").split()[9:])
    assert abs(tx - 115) < 0.1 and abs(ty - 135) < 0.1 and abs(tz) < 0.1, (tx, ty, tz)

    ext = {o.get("id"): o.find("./metadata[@key='extruder']").get("value")
           for o in cfg.findall("./object")}
    assert ext["2"] == "1", "unassigned body -> extruder 1"
    assert ext["3"] == "2", "slot 1 -> extruder 2 (1-based)"
    assert proj["filament_colour"] == ["#E03030", "#3050E0"]
    assert proj["filament_type"] == ["PETG", "PLA"], \
        "material -> filament_type at its slot; material-less slot defaults PLA"
    assert proj["printer_model"] == "Snapmaker U1", "base settings must be there"
    assert proj["printer_variant"] == "0.6", "caller settings must win"
    print(PASS, "project 3MF: zip layout, extruder metadata, filament_colour, "
          "filament_type, shared transform, settings")


def _write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


def _datadir(root):
    """A minimal slicer data directory: one system machine with a user child, a
    system and a user process, and a filament, all tied by compatible_printers."""
    # A `user` component ABOVE the datadir must not make every preset a user one.
    dd = os.path.join(root, "user", "OrcaSlicer")
    _write(os.path.join(dd, "OrcaSlicer.conf"), {"presets": {"machine": "My U1"}})
    _write(os.path.join(dd, "system", "Vendor", "machine", "base.json"),
           {"name": "Base U1", "printer_model": "Snapmaker U1", "nozzle_diameter": ["0.4"]})
    _write(os.path.join(dd, "user", "default", "machine", "mine.json"),
           {"name": "My U1", "inherits": "Base U1", "print_host": "192.168.0.46"})
    _write(os.path.join(dd, "system", "Vendor", "process", "sys.json"),
           {"name": "0.20mm Standard", "compatible_printers": ["Base U1"], "line_width": "0.42"})
    _write(os.path.join(dd, "user", "default", "process", "tuned.json"),
           {"name": "Tuned 0.20", "inherits": "0.20mm Standard", "line_width": "0.45"})
    _write(os.path.join(dd, "system", "Vendor", "filament", "sub", "pla.json"),
           {"name": "Generic PLA", "compatible_printers": ["My U1"],
            "filament_type": ["PLA"], "filament_colour": ["#FFFFFF"]})
    return dd


def test_presets_flatten():
    with tempfile.TemporaryDirectory() as td:
        dd = _datadir(td)
        cfg = print_presets.project_settings(dd, 3)
    assert cfg["printer_model"] == "Snapmaker U1", "the inherits chain must merge"
    assert cfg["print_host"] == "192.168.0.46"
    assert "inherits" not in cfg and "name" not in cfg, "meta keys must be stripped"
    assert cfg["print_settings_id"] == "Tuned 0.20", "the user's own process wins"
    assert cfg["line_width"] == "0.45"
    assert cfg["filament_settings_id"] == ["Generic PLA"] * 3, "one filament per slot"
    assert cfg["filament_type"] == ["PLA"] * 3
    assert "filament_colour" not in cfg, "the palette owns the colours"
    assert cfg["printer_settings_id"] == "My U1"
    print(PASS, "presets flatten: chain merge, user process preferred, per-slot filament")


def test_user_presets_by_component():
    dd = os.path.join("home", "user", "datadir")
    assert print_presets.is_user_preset(os.path.join(dd, "user", "default", "process", "a.json"), dd)
    assert not print_presets.is_user_preset(os.path.join(dd, "system", "V", "process", "a.json"), dd)
    assert not print_presets.is_user_preset("datadir/system/user-contributed/process/x.json")
    assert print_presets.is_user_preset("datadir\\user\\default\\process\\mine.json")
    print(PASS, "user presets are a path component under the datadir, either separator")


def test_missing_presets_do_not_fail_the_export():
    _, _, bodies = rebuild(DOC)
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "proj.3mf")
        res = server._plugin_export_job(DOC, path, "print-project-3mf", {
            "palette": [], "bodyColors": {}, "bodyNames": {},
            "presets": {"datadir": os.path.join(td, "nowhere"), "filamentCount": 1},
        })
        assert "error" not in res, res
        assert res["info"]["presets"] is False and "not found" in res["info"]["presetError"], res
        assert os.path.getsize(res["path"]) > 0
    print(PASS, "no slicer presets still exports, and says so")


def main():
    print("Printing: project 3MF")
    test_sanitize()
    test_export_through_the_engine()
    test_presets_flatten()
    test_user_presets_by_component()
    test_missing_presets_do_not_fail_the_export()
    print("ALL PASS")


if __name__ == "__main__":
    main()

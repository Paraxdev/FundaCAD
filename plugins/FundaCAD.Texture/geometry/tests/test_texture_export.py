"""A textured body exports its DISPLACED mesh.

The trap this exists to catch: displacement lives in the MESH and never in
body["shape"], so any shape-based writer drops it silently, with a successful
export and a smooth part at the other end. That is the whole reason the GLB path
writes per-body meshes instead of handing the shape to OCCT's RWGltf_CafWriter.

It lives HERE rather than in sidecar/tests/test_glb.py, which is where it used
to be, because it needs a `texture` feature to exist: a core test that builds
one fails the moment this plugin is not installed, which is a state the core is
now supposed to tolerate. What sidecar/tests/test_glb.py keeps is everything
about the writer that holds with no plugin present at all.

Run: uv run python test_texture_export.py
"""

import _bootstrap  # noqa: F401  (path + plugin registration)

import os
import tempfile

import builder
import mesh_writers
import plugin_geometry
import server
from build123d import Box
from tessellate import tessellate

PASS = "  ok"


def _smooth_triangle_count():
    """Triangles in the same box with no texture on it, as the baseline."""
    pos, idx, _fids = tessellate(Box(20, 20, 5), 0.1)
    return len(idx) // 3


def test_textured_body_exports_its_displaced_mesh():
    smooth_tris = _smooth_triangle_count()

    doc = {"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"id": "r1", "type": "rectangle", "width": 20, "height": 20, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"},
        {"id": "t1", "type": "texture", "kind": "knurl", "faces": {"by": "all"},
         "depth": 0.4, "scale": 2.0},
    ]}
    _part, errors, bodies = builder.rebuild(doc)
    assert not errors, errors
    body = bodies[0]
    assert body.get(plugin_geometry.BODY_KEY), "the fixture should be textured"

    pos, idx = server._export_mesh(body)
    p = os.path.join(tempfile.mkdtemp(), "tex.glb")
    mesh_writers.write_glb([{"name": "Knurled", "positions": pos,
                             "indices": idx, "color": "#e8e8e8"}], p)
    import json

    with open(p, "rb") as fh:
        raw = fh.read()
    # glTF binary: 12-byte header, then chunk 0 (JSON) with its own 8-byte header
    jlen = int.from_bytes(raw[12:16], "little")
    gdoc = json.loads(raw[20:20 + jlen])
    ntri = gdoc["accessors"][gdoc["meshes"][0]["primitives"][0]["indices"]]["count"] // 3
    assert ntri > smooth_tris * 5, (
        f"only {ntri} triangles vs {smooth_tris} for the smooth box, "
        "the texture was dropped")
    print(PASS, f"textured body exports its displaced mesh ({ntri:,} triangles)")


def test_a_document_with_no_texture_plugin_reports_the_plugin_by_name():
    """The other half of owning a feature: what the build says without the owner.

    The document is intact and every value is kept; what is missing is the code
    that reads it. So the message has to name the plugin, because "unknown
    feature type: texture" gives a person nothing they can act on.
    """
    saved_handler = plugin_geometry._FEATURES.pop("texture")
    try:
        doc = {"parameters": {}, "features": [
            {"id": "s1", "type": "sketch", "plane": "XY",
             "entities": [{"id": "r1", "type": "rectangle", "width": 20, "height": 20,
                           "x": 0, "y": 0}]},
            {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"},
            {"id": "t1", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0},
        ]}
        _part, errors, bodies = builder.rebuild(doc)
        assert len(errors) == 1 and errors[0]["feature_id"] == "t1", errors
        msg = errors[0]["message"]
        assert "FundaCAD.Texture" in msg, f"the message does not name the plugin: {msg!r}"
        assert "unknown feature type" not in msg, msg
        # and the rest of the document still built: a missing plugin costs the
        # one feature, never the part.
        assert bodies and bodies[0].get("shape") is not None, \
            "the body should still build without the texture"
    finally:
        plugin_geometry._FEATURES["texture"] = saved_handler
    print(PASS, "a missing texture plugin is named, and the rest still builds")


def main():
    print("Texture export tests")
    test_textured_body_exports_its_displaced_mesh()
    test_a_document_with_no_texture_plugin_reports_the_plugin_by_name()
    print("ALL PASS")


if __name__ == "__main__":
    main()

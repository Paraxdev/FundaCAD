"""Fastener solids against their tables. Run from sidecar/:
uv run python ../plugins/FundaCAD.Screws/geometry/tests/test_fasteners.py

samples.json is every catalogue family at its smallest and largest size and length, written by
tests/plugins/screwsCatalogue.test.ts from the same tables the window reads.
"""

import copy
import json
import math
import os
import shutil
import tempfile

import _bootstrap  # noqa: F401
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.TopAbs import TopAbs_IN
from OCP.gp import gp_Pnt

import plugin_geometry
from scr_build import build

PASS = "  ok"
TOL = 1e-3
INCH = 25.4

with open(_bootstrap.SAMPLES, encoding="utf-8") as fh:
    SAMPLES = json.load(fh)


def inside(shape, p):
    c = BRepClass3d_SolidClassifier(shape.wrapped, gp_Pnt(*p), 1e-7)
    return c.State() == TopAbs_IN


def valid_single(shape, name):
    assert BRepCheck_Analyzer(shape.wrapped).IsValid(), f"{name} is not a valid solid"
    assert len(shape.solids()) == 1, f"{name} is {len(shape.solids())} solids"
    assert shape.volume > 0, f"{name} has no volume"


def close(a, b, what, tol=TOL):
    assert abs(a - b) <= tol * max(1.0, abs(b)), f"{what}: measured {a:.4f}, table says {b:.4f}"


def mm(spec, v):
    return v * (INCH if spec["units"] == "in" else 1.0)


def test_every_family_builds_at_both_ends_of_its_table():
    families = set()
    for spec in SAMPLES:
        valid_single(build(spec), spec["name"])
        families.add(spec["standard"] + spec["kind"] + json.dumps(spec.get("head", {}).get("type")))
    print(PASS, f"{len(SAMPLES)} samples across every family build one valid solid")


def test_key_dimensions_match_the_table():
    measured = 0
    for spec in SAMPLES:
        shape = build(spec)
        bb = shape.bounding_box()
        name = spec["name"]
        kind = spec["kind"]
        if kind in ("screw", "shoulderScrew"):
            head = spec["head"]
            L = mm(spec, spec["length"])
            bottom = L + (mm(spec, spec["thread"]["length"]) if kind == "shoulderScrew" else 0)
            close(-bb.min.Z, bottom, f"{name} overall length")
            t = head["type"]
            if t in ("socketCap", "lowHead", "cheese", "pan", "button", "knurled"):
                close(bb.max.X - bb.min.X, mm(spec, head["diameter"]), f"{name} head diameter", 2e-3)
                k = mm(spec, head["height"])
                if t == "button":
                    assert 0.8 * k < bb.max.Z <= k + 1e-6, f"{name} button height {bb.max.Z} vs {k}"
                else:
                    close(bb.max.Z, k, f"{name} head height")
            elif t == "countersunk":
                close(bb.max.X - bb.min.X, mm(spec, head["diameter"]), f"{name} head diameter", 2e-3)
                close(bb.max.Z, 0.0, f"{name} flush top")
            elif t in ("hex", "hexFlange"):
                close(bb.max.Z, mm(spec, head["height"]), f"{name} head height")
                across = mm(spec, head["flangeDiameter"] if t == "hexFlange" else head["acrossFlats"])
                close(bb.max.Y - bb.min.Y, across, f"{name} across flats")
            elif t == "none":
                close(bb.max.Z, 0.0, f"{name} top")
        elif kind == "nut":
            nut = spec["nut"]
            close(bb.max.Z - bb.min.Z, mm(spec, nut["height"]), f"{name} height")
            across = nut["flangeDiameter"] if nut["type"] == "flange" else nut["acrossFlats"]
            close(bb.max.Y - bb.min.Y, mm(spec, across), f"{name} across flats")
            d = mm(spec, spec["thread"]["diameter"])
            assert not inside(shape, (d * 0.45, 0, mm(spec, nut["height"]) / 2)), f"{name} has no bore"
        elif kind == "washer":
            w = spec["washer"]
            close(bb.max.Z - bb.min.Z, mm(spec, w["thickness"]), f"{name} thickness")
            close(bb.max.Y - bb.min.Y, mm(spec, w["outer"]), f"{name} outer diameter")
            assert not inside(shape, (0, mm(spec, w["inner"]) * 0.45, mm(spec, w["thickness"]) / 2)), f"{name} has no hole"
            assert inside(shape, (0, (mm(spec, w["inner"]) + mm(spec, w["outer"])) / 4, mm(spec, w["thickness"]) / 2))
        elif kind == "insert":
            ins = spec["insert"]
            close(-bb.min.Z, mm(spec, ins["length"]), f"{name} length")
            close(bb.max.X - bb.min.X, mm(spec, ins["outer"]), f"{name} outer diameter", 2e-3)
        measured += 1
    print(PASS, f"head diameter, head height, length, across flats, thickness measured on {measured} solids")


def _sample(standard, kind=None):
    for spec in SAMPLES:
        if spec["standard"] == standard and (kind is None or spec["kind"] == kind):
            return copy.deepcopy(spec)
    raise AssertionError(f"no sample for {standard}")


def test_drives_are_recesses():
    shcs = _sample("ISO 4762")
    shape = build(shcs)
    k, t = shcs["head"]["height"], shcs["drive"]["depth"]
    across = shcs["drive"]["size"]
    assert not inside(shape, (0, 0, k - t / 2)), "the hex socket's middle is air"
    assert not inside(shape, (across / 2 * 0.95, 0, k - t / 2)), "the socket reaches its corner"
    assert inside(shape, (across / 2 * 1.2 * 1.1547, 0, k - t / 2)), "past the socket is head"
    assert inside(shape, (0, 0, k - t - 0.5 * across)), "below the socket's cone is solid"

    torx = _sample("ISO 14583")
    shape = build(torx)
    k, t, a = torx["head"]["height"], torx["drive"]["depth"], torx["drive"]["size"]
    assert not inside(shape, (0, 0, k - t / 2)), "the torx recess is air"
    assert not inside(shape, (a / 2 * 0.9, 0, k - t / 2)), "a lobe reaches out along X"
    assert inside(shape, (a / 2 * 0.8 * math.cos(math.radians(30)), a / 2 * 0.8 * math.sin(math.radians(30)), k - t / 2)), \
        "between two lobes is head"

    slot = _sample("ISO 1207")
    shape = build(slot)
    k, t, dk = slot["head"]["height"], slot["drive"]["depth"], slot["head"]["diameter"]
    assert not inside(shape, (dk * 0.4, 0, k - t / 2)), "the slot runs across the head"
    assert inside(shape, (0, dk * 0.4, k - t / 2)), "beside the slot is head"

    for drive in ("phillips", "pozidriv"):
        cross = _sample("ISO 7045")
        cross["drive"]["type"] = drive
        shape = build(cross)
        valid_single(shape, drive)
        k, t, m = cross["head"]["height"], cross["drive"]["depth"], cross["drive"]["size"]
        assert not inside(shape, (m * 0.3, 0, k - 0.05)), f"{drive} arm is air"
        assert inside(shape, (m * 0.3, m * 0.3, k - t * 0.9)), f"{drive} is solid between arms deep down"
    print(PASS, "hex, hexalobular, slot, Phillips and Pozidriv are cut into the head where they belong")


def _right_handed_groove(shape, r, depth, pitch, bottom, z_lo, z_hi):
    """Probe on +Y, a quarter turn on: groove air at bottom + kP + P/4 for a right-hand thread."""
    hits_right = hits_left = 0
    k = math.ceil((z_lo - bottom) / pitch) + 1
    while bottom + (k + 1) * pitch < z_hi:
        z = bottom + k * pitch
        probe_r = r - depth * 0.5
        if not inside(shape, (0, probe_r, z + pitch / 4)) and inside(shape, (0, probe_r, z - pitch / 4)):
            hits_right += 1
        if not inside(shape, (0, probe_r, z - pitch / 4)) and inside(shape, (0, probe_r, z + pitch / 4)):
            hits_left += 1
        k += 1
    return hits_right, hits_left


def test_modelled_threads():
    shcs = _sample("ISO 4762")
    shcs["length"] = 10
    shcs["thread"]["length"] = 10
    plain = build(shcs)
    shcs["thread"]["modelled"] = True
    threaded = build(shcs)
    valid_single(threaded, "modelled M1.6 screw")
    assert threaded.volume < plain.volume * 0.98, "a modelled thread removes material"
    d, p = shcs["thread"]["diameter"], shcs["thread"]["pitch"]
    right, left = _right_handed_groove(threaded, d / 2, p * 0.6134, p, -10 - p, -9, -1)
    assert right > 5 and left == 0, f"right-hand thread probes: right {right}, left {left}"

    shcs["thread"]["hand"] = "left"
    lefty = build(shcs)
    valid_single(lefty, "left-hand screw")
    top = 0.0
    bb_right, bb_left = _right_handed_groove(lefty, d / 2, p * 0.6134, p, top - 30 * p, -9, -1)
    assert bb_left > 5 and bb_right == 0, f"left-hand thread probes: right {bb_right}, left {bb_left}"

    nut = _sample("ISO 4032")
    nut["thread"]["modelled"] = True
    shape = build(nut)
    valid_single(shape, "modelled nut")
    plain_nut = copy.deepcopy(nut)
    plain_nut["thread"]["modelled"] = False
    assert shape.volume > build(plain_nut).volume, "a modelled nut bores at the minor diameter"

    insert = _sample("Common knurled insert")
    insert["thread"]["modelled"] = True
    valid_single(build(insert), "modelled insert")

    bolt = _sample("ISO 4014")
    bolt["thread"]["modelled"] = True
    valid_single(build(bolt), "modelled partially threaded bolt")

    inch = _sample("ASME B18.3")
    inch["thread"]["modelled"] = True
    valid_single(build(inch), "modelled inch screw")
    print(PASS, "modelled threads build valid solids, right and left handed, external and internal")


def test_incomplete_or_impossible_specs_are_refused_by_name():
    spec = _sample("ISO 4762")
    del spec["head"]["diameter"]
    del spec["drive"]["depth"]
    try:
        build(spec)
        raise AssertionError("an incomplete spec built")
    except ValueError as ex:
        assert str(ex) == "Fastener: missing head diameter, drive depth", str(ex)

    try:
        build({"kind": "washer", "units": "mm", "name": "w"})
        raise AssertionError("a washer without a washer built")
    except ValueError as ex:
        assert str(ex) == "Fastener: missing washer type", str(ex)

    spec = _sample("ISO 4762")
    spec["head"]["diameter"] = spec["thread"]["diameter"] * 0.8
    spec["thread"]["length"] = spec["length"] + 5
    try:
        build(spec)
        raise AssertionError("an impossible spec built")
    except ValueError as ex:
        assert "the head must be wider than the shank" in str(ex), str(ex)
        assert "the thread cannot be longer than the shank" in str(ex), str(ex)
    print(PASS, "a spec with missing or impossible values is refused with each problem named")


def test_a_user_defined_fastener_in_inches():
    spec = {
        "kind": "screw", "units": "in", "name": "Thumb screw 1/4-20",
        "head": {"type": "knurled", "diameter": 0.75, "height": 0.4, "collarDiameter": 0.4, "collarHeight": 0.1},
        "drive": {"type": "slot", "size": 0.06, "depth": 0.08},
        "thread": {"type": "unified", "diameter": 0.25, "pitch": 0.05, "length": 1.0, "hand": "right"},
        "length": 1.0,
        "point": {"type": "cone"},
    }
    shape = build(spec)
    valid_single(shape, spec["name"])
    bb = shape.bounding_box()
    close(-bb.min.Z, 25.4, "one inch long")
    close(bb.max.Z, 0.4 * 25.4, "head height in mm")
    print(PASS, "a fastener defined in inches is built in millimetres")


def test_inserted_as_an_import_and_rebuilds_without_the_plugin():
    from shape_generate import generate_shape

    blobs = tempfile.mkdtemp(prefix="fastener_blobs_")
    old = os.environ.get("FUNDACAD_BLOB_DIR")
    os.environ["FUNDACAD_BLOB_DIR"] = blobs
    import blobstore

    blobstore._default = None
    spec = _sample("ISO 4762")
    try:
        out = generate_shape("fastener", spec, "store", {"origin": [10, 0, 5], "zAxis": [0, 0, 1]})
        assert out["valid"] and out["solid"], out
        preview = generate_shape("fastener", spec, "mesh")
        assert preview["mesh"]["indices"], "a preview mesh"
        close(preview["volume"], out["volume"], "preview and inserted volumes")

        plugin_geometry._reset_for_tests()
        plugin_geometry._discovered = True
        assert plugin_geometry.generator_for("fastener") is None

        import builder

        doc = {"parameters": {}, "features": [{
            "id": "f1", "type": "import", "format": "brep", "name": spec["name"], "geom": out["geom"],
            "solid": True, "generatedBy": {"plugin": "FundaCAD.Screws", "spec": spec},
        }]}
        _part, errors, bodies = builder.rebuild(doc)
        assert not errors, errors
        assert len(bodies) == 1 and bodies[0]["name"] == spec["name"], bodies
        body = bodies[0]["shape"]
        close(body.volume, out["volume"], "rebuilt volume")
        bb = body.bounding_box()
        close(bb.max.Z, 5 + spec["head"]["height"], "placed on the origin point")
        close((bb.min.X + bb.max.X) / 2, 10, "centred on the origin point")
    finally:
        plugin_geometry._reset_for_tests()
        plugin_geometry.discover()
        blobstore._default = None
        if old is None:
            os.environ.pop("FUNDACAD_BLOB_DIR", None)
        else:
            os.environ["FUNDACAD_BLOB_DIR"] = old
        shutil.rmtree(blobs, ignore_errors=True)
    print(PASS, "an inserted fastener is an import body that rebuilds with the plugin's geometry gone")


def main():
    print("Fasteners")
    test_every_family_builds_at_both_ends_of_its_table()
    test_key_dimensions_match_the_table()
    test_drives_are_recesses()
    test_modelled_threads()
    test_incomplete_or_impossible_specs_are_refused_by_name()
    test_a_user_defined_fastener_in_inches()
    test_inserted_as_an_import_and_rebuilds_without_the_plugin()
    print("ALL PASS")


if __name__ == "__main__":
    main()

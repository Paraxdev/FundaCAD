"""A kernel fault must cost a feature, not the session.

BRepOffset_MakeOffset does not refuse the shapes it cannot handle, it takes the
process down. `_offset_faces` had two fallbacks written around it — press/pull
thickens the one face instead, Offset Face retries face by face — and neither
had ever run, because there is no excepting your way out of an access violation.

The trigger is not exotic. A cylinder with ONE chamfer is enough, and the same
cylinder without the chamfer survives everything, which is the control that
makes the chamfer the cause. On the document that prompted this — a belt spool
with chamfered flanges — every face of the body crashed, in both directions.

So the offset runs in a child process now. Most of what is below is a control:
before the change, three of these tests did not fail, they ended the run.

Run:  uv run python tests/test_offset_isolation.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import os
import sys
import tempfile
import traceback

from build123d import Axis, Cylinder, GeomType, Solid, chamfer
from OCP.BRepCheck import BRepCheck_Analyzer

import offset_child
import solid_ops
from solid_ops import _offset_faces, _press_pull

PASS = "  ok"

PLAIN = Cylinder(30, 5)
CHAMFERED = chamfer(PLAIN.edges().group_by(Axis.Z)[0], 0.3)


def _face(body, kind):
    return [f for f in body.faces() if f.geom_type == kind][0]


def _flat(body, top):
    """The chamfered end's flat, or the far one. The chamfer is on the bottom
    rim, so the flats sort with the chamfered one first."""
    flats = sorted((f for f in body.faces() if f.geom_type == GeomType.PLANE),
                   key=lambda f: f.center().Z)
    return flats[-1] if top else flats[0]


#: The three that used to end the process.
CRASHERS = [
    ("the chamfer cone pushed out", lambda: _face(CHAMFERED, GeomType.CONE), 1.0),
    ("the wall pushed in", lambda: _face(CHAMFERED, GeomType.CYLINDER), -1.0),
    ("the chamfered end pushed in", lambda: _flat(CHAMFERED, False), -1.0),
]

#: Everything that worked before, with the volume it produced. Measured before
#: the change, one isolated subprocess per case.
SURVIVORS = [
    ("plain wall out", PLAIN, lambda: _face(PLAIN, GeomType.CYLINDER), 1.0, 15095.353),
    ("plain wall in", PLAIN, lambda: _face(PLAIN, GeomType.CYLINDER), -1.0, 13210.397),
    ("plain end out", PLAIN, lambda: _flat(PLAIN, True), 1.0, 16964.600),
    ("plain end in", PLAIN, lambda: _flat(PLAIN, True), -1.0, 11309.734),
    ("chamfer cone in", CHAMFERED, lambda: _face(CHAMFERED, GeomType.CONE), -1.0, 13865.492),
    ("chamfered wall out", CHAMFERED, lambda: _face(CHAMFERED, GeomType.CYLINDER), 1.0, 14933.065),
    ("far end out", CHAMFERED, lambda: _flat(CHAMFERED, True), 1.0, 16956.146),
]


def test_the_offsets_that_used_to_kill_the_process():
    """The control, and it is the whole point: this file cannot report a failure
    for these three, it can only fail to reach the end of the run."""
    for label, pick, d in CRASHERS:
        try:
            _offset_faces(CHAMFERED, [(pick(), d)])
        except ValueError as ex:
            assert str(ex).strip(), "refused with an empty message"
            print(PASS, f"{label}: refused, and this process is still here")
            continue
        # Succeeding is allowed — another OCCT build may manage it. Taking the
        # process along is not, and getting here proves it did not.
        print(PASS, f"{label}: completed (no crash either way)")


def test_isolation_did_not_change_a_single_answer():
    """Every case that worked before must give the same solid, to the volume. A
    fix that quietly rounds off the geometry is not a fix."""
    for label, body, pick, d, want in SURVIVORS:
        out = _offset_faces(body, [(pick(), d)])
        assert abs(out.volume - want) < 1e-3, f"{label}: {out.volume:.3f} != {want:.3f}"
        assert BRepCheck_Analyzer(out.wrapped).IsValid(), f"{label}: invalid solid"
    print(PASS, f"{len(SURVIVORS)} offsets unchanged to the third decimal")


def test_press_pull_moves_the_face_the_offset_will_not():
    """What the user actually gets. The offset refuses the chamfer cone, so
    press/pull falls through to thickening that one face — the fallback that was
    there all along and could never be reached."""
    before = CHAMFERED.volume
    out = _press_pull(CHAMFERED, _face(CHAMFERED, GeomType.CONE), 1.0)
    assert BRepCheck_Analyzer(out.wrapped).IsValid(), "press/pull made an invalid solid"
    assert out.volume > before, f"pushing out removed material: {before} -> {out.volume}"
    print(PASS, f"press/pull on the chamfer: {before:.1f} -> {out.volume:.1f} mm3")


def test_a_hard_crash_in_the_child_is_a_refusal_here():
    """The mechanism itself, without waiting for OCCT to misbehave on cue.

    The child is pointed at a script that terminates abnormally on purpose —
    os.abort(), no exception and no traceback, which is what the parent sees
    when the kernel faults. Not ctypes.string_at(0): Python turns that access
    violation into an OSError, so it would have tested a clean non-zero exit
    while claiming to test a crash.

    If the offset were running in this process, this test would not fail. The
    run would stop right here, which is the thing being guarded against."""
    tmp = tempfile.mkdtemp(prefix="fc-offset-test-")
    bomb = os.path.join(tmp, "bomb.py")
    with open(bomb, "w", encoding="utf-8") as fh:
        # the same quiet death offset_child arranges for itself: no error box to
        # sit there while this test's timeout runs
        fh.write(
            "import os" + os.linesep
            + "if os.name == 'nt':" + os.linesep
            + "    import ctypes" + os.linesep
            + "    ctypes.windll.kernel32.SetErrorMode(0x8003)" + os.linesep
            + "os.abort()" + os.linesep
        )
    real = solid_ops._OFFSET_CHILD
    solid_ops._OFFSET_CHILD = bomb
    try:
        _offset_faces(PLAIN, [(_face(PLAIN, GeomType.CYLINDER), 1.0)])
    except ValueError:
        print(PASS, "a child that dies outright comes back as a refusal")
        return
    finally:
        solid_ops._OFFSET_CHILD = real
    raise AssertionError("a crashing child reported success")


def test_a_face_from_another_body_is_refused_not_ignored():
    """The marshalling guard. SetOffsetOnFace ignores a face that is not the
    part's own, and the kernel then hands back the part UNCHANGED and calls it
    success — a silent no-op, which is worse than the crash, because nothing
    anywhere says the edit did not happen."""
    stranger = _face(Cylinder(7, 7), GeomType.CYLINDER)
    try:
        out = _offset_faces(PLAIN, [(stranger, 1.0)])
    except ValueError:
        print(PASS, "a face the body does not own is refused")
        return
    raise AssertionError(
        f"a foreign face was accepted, volume {out.volume:.3f} vs {PLAIN.volume:.3f}"
    )


def test_an_impossible_offset_keeps_its_own_words():
    """The distinct refusals survive the trip through an exit code rather than
    all collapsing into one message."""
    s = Solid.make_sphere(10)
    try:
        _offset_faces(s, [(_face(s, GeomType.SPHERE), -30.0)])
    except ValueError as ex:
        assert str(ex).strip(), "refused with an empty message"
        print(PASS, f"refused: {ex}")
        return
    print(PASS, "that offset succeeded, and validly (the child checks its own result)")


def test_the_exit_codes_cannot_be_mistaken_for_a_crash():
    """A C runtime abort() exits 3 and a shell reports a fault as 139. A child
    code sharing either number would make every log line about this ambiguous —
    refused, or died? — which is the one question the codes exist to answer."""
    codes = {offset_child.REFUSED, offset_child.INVALID, offset_child.MARSHAL}
    assert len(codes) == 3, "two of the child's codes are the same number"
    assert offset_child.OK not in codes
    assert all(c > 10 for c in codes), f"a code sits in the crash range: {codes}"
    print(PASS, f"child codes {sorted(codes)} stay clear of abort and signals")


def test_the_child_ships_with_the_sidecar():
    """The bundle copies sidecar/*.py by denylist, so a new module ships by
    default — but the path this resolves at RUNTIME is worth pinning, because
    getting it wrong breaks the packaged build only."""
    assert os.path.isfile(solid_ops._OFFSET_CHILD), solid_ops._OFFSET_CHILD
    assert os.path.dirname(solid_ops._OFFSET_CHILD) == os.path.dirname(
        os.path.abspath(offset_child.__file__)
    )
    print(PASS, "the child sits beside the modules that ship with it")


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            print(f"FAIL {name}")
            failed += 1
    print("offset isolation:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

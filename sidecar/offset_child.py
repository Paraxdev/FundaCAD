"""BRepOffset, in a process that is allowed to die.

BRepOffset_MakeOffset does not refuse the shapes it cannot handle. It takes the
process down: an access violation inside OCCT, no exception, nothing for a
caller to catch. That is why `_offset_faces` had two carefully written fallbacks
that had never once run — you cannot except your way out of a segfault.

It is not an exotic trigger either. Measured, a four-face body is enough:

    Cylinder(r=30, h=5), one 0.3mm chamfer on the bottom rim

      offset the chamfer cone   +1mm    CRASH
      offset the outer wall     -1mm    CRASH
      offset the chamfered face -1mm    CRASH
      the same cylinder with NO chamfer, all six      all fine

So the gesture that kills a worker is "push a face next to a chamfer by more
than the chamfer is big", which is an ordinary thing to do to an ordinary part.
On the document that prompted this — a belt spool with chamfered flanges and a
threaded joint — EVERY face of the body crashed, in both directions.

Running it here instead means a crash is an exit code. The parent turns that
into the ValueError its callers were already written to handle, and press/pull
lands on the thicken fallback, which answers the same question correctly.

Two separate things then protect the app, and it is worth knowing which does
what. Writing the shape out and reading it back is itself enough to turn SOME
crashes into an honest refusal — the four-face body above dies in process and
comes back REFUSED through here, with no fault at all. The boundary catches what
survives that. Measured over the spool, every face in both directions, 102
offsets: 6 died with 0xC0000005, 87 refused, 8 came back invalid, 1 succeeded.
So neither half is redundant, and the six are the ones that used to be the end
of the session.

The exchange is one BREP file in, one out. The input is a compound holding the
part FOLLOWED BY the faces to offset; a compound written in one go keeps its
shared sub-shapes shared, so those faces read back IsSame with the part's own
and SetOffsetOnFace matches them. That sharing is load-bearing: without it the
offsets attach to nothing, the kernel cheerfully returns the part unchanged, and
a silent no-op is worse than the crash. It is checked below rather than trusted.

Not a library. Run as:
    offset_child.py <in.brep> <out.brep> <d0> [<d1> ...]
"""

import os
import sys

# Exit codes. Anything else is the kernel dying, which is the whole point, so
# they start at 11: a C runtime abort() exits 3, and a code that could mean
# either "refused" or "aborted" would make the parent's log a guess.
OK = 0
REFUSED = 11         # the offset would not run
INVALID = 12         # it ran and produced a solid that is not one
MARSHAL = 13         # the input did not arrive as expected


def _no_crash_dialog():
    """Die quietly. A geometry kernel fault in a child of a desktop app must not
    put a Windows Error Reporting box on the user's screen, and must not sit
    there waiting for someone to dismiss it while the parent's timeout runs."""
    if os.name != "nt":
        return
    try:
        import ctypes

        # SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
    except Exception:
        pass


def _faces_of(shape):
    from OCP.TopAbs import TopAbs_ShapeEnum
    from OCP.TopExp import TopExp_Explorer

    out = []
    ex = TopExp_Explorer(shape, TopAbs_ShapeEnum.TopAbs_FACE)
    while ex.More():
        out.append(ex.Current())
        ex.Next()
    return out


def run(in_path, out_path, dists):
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepOffset import BRepOffset_MakeOffset, BRepOffset_Mode
    from OCP.BRepTools import BRepTools
    from OCP.GeomAbs import GeomAbs_JoinType
    from OCP.TopAbs import TopAbs_ShapeEnum
    from OCP.TopoDS import TopoDS, TopoDS_Iterator, TopoDS_Shape

    bundle = TopoDS_Shape()
    if not BRepTools.Read_s(bundle, in_path, BRep_Builder()) or bundle.IsNull():
        return MARSHAL
    kids = []
    it = TopoDS_Iterator(bundle)
    while it.More():
        kids.append(it.Value())
        it.Next()
    if len(kids) != len(dists) + 1:
        return MARSHAL
    part, faces = kids[0], kids[1:]

    # The sharing check. A face that is merely shaped like one of the part's is
    # not one of the part's, and SetOffsetOnFace would ignore it silently.
    owned = _faces_of(part)
    for f in faces:
        if f.ShapeType() != TopAbs_ShapeEnum.TopAbs_FACE:
            return MARSHAL
        if not any(f.IsSame(o) for o in owned):
            return MARSHAL

    mk = BRepOffset_MakeOffset()
    # GeomAbs_Intersection join is what makes a local single-face offset close up
    # cleanly against the neighbouring faces (the Arc join fails here).
    mk.Initialize(
        part,
        0.0,
        1e-4,
        BRepOffset_Mode.BRepOffset_Skin,
        False,
        False,
        GeomAbs_JoinType.GeomAbs_Intersection,
        False,
        False,
    )
    for f, d in zip(faces, dists):
        mk.SetOffsetOnFace(TopoDS.Face_s(f), d)
    mk.MakeOffsetShape()
    if not mk.IsDone():
        return REFUSED
    sh = mk.Shape()
    if sh.IsNull():
        return REFUSED
    # the offset yields a Shell; wrap it back into a Solid so downstream booleans,
    # tessellation and export all see a uniform solid.
    if sh.ShapeType() == TopAbs_ShapeEnum.TopAbs_SHELL:
        sh = BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(sh)).Solid()
    # IsDone() is not the same as "produced a usable solid": BRepOffset reports
    # success while emitting a shell that self-intersects where the offset ran
    # past the local curvature. Letting that into the document is worse than
    # refusing, because it survives until some later boolean fails somewhere the
    # user cannot connect to what they did.
    if not BRepCheck_Analyzer(sh).IsValid():
        return INVALID
    BRepTools.Write_s(sh, out_path)
    return OK


def main(argv):
    if len(argv) < 4:
        return MARSHAL
    _no_crash_dialog()
    try:
        dists = [float(x) for x in argv[3:]]
    except ValueError:
        return MARSHAL
    try:
        return run(argv[1], argv[2], dists)
    except Exception as ex:
        # An exception here is still a refusal, not a crash: report it on stderr
        # for the parent's log and leave the offset undone.
        print(f"offset_child: {type(ex).__name__}: {ex}", file=sys.stderr)
        return REFUSED


if __name__ == "__main__":
    sys.exit(main(sys.argv))

"""Reading a model file, and deciding whether we are willing to.

Split out of builder.py. An import is the one place the sidecar takes bytes it
did not write: a mesh or B-rep file the user picked, or a blob out of a document
that may not be one of ours. So this module is as much refusal as it is reading —
size caps, triangle counts and a memory check all run BEFORE the slow read, so a
hostile or merely enormous file is turned away in milliseconds instead of
grinding OCCT into the job timeout.

What comes out the far side is a shape the rest of the sidecar can treat like
anything it modelled itself: sewn, canonicalised, merged (shape_util), and split
into bodies.

builder.py re-exports every name below; the tests reach for several of them.
"""

import json
import os
import tempfile

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import (
    Compound,
    Mesher,
    Solid,
    import_brep,
)

from progress import import_phase as _import_phase
from shape_util import (
    _explode_solids,
    _maybe_unify,
    _refacet_clean,
    _shape_to_blob,
    _wrap_topods,
)

# Import guards. FundaCAD imports CLEAN / prismatic models as editable B-rep
# bodies (one B-rep face per mesh triangle). That's great for CAD-exported meshes
# but explodes on dense organic/scanned models — so we refuse those up front with
# a clear message rather than letting OCCT grind into the job timeout.
MAX_IMPORT_TRIANGLES = 150_000  # reject before the slow read (avoids the timeout)
MAX_IMPORT_FACES = 2_000        # after merge: more faces than this = organic/curved,
                                # not a clean editable model (a prismatic CAD part —
                                # even with fillets — merges to far fewer faces).
                                # Judged PER BODY: the number was calibrated on single
                                # parts, and charging a two-object project file the SUM
                                # of its bodies refused files whose bodies each passed
                                # (1,850 + 1,737 against a 2,000 limit).
# The whole-file backstop that per-body limiting needs. This is a VIEWPORT COST
# guard, not an editability judgement: MAX_IMPORT_FACES asks "is this one body a
# clean CAD part", this one asks "can we draw all of it at once". Without it a
# genuinely organic file split into 50 sub-2,000-face bodies walks straight in at
# ~100k faces. 20,000 is a FIRST GUESS, not a measured ceiling — nobody has
# measured where the viewport actually starts to hurt, so treat it as a number to
# revisit with a real measurement, not as a calibrated one.
MAX_IMPORT_TOTAL_FACES = 20_000
# Untrusted-input guards (an import path or embedded BREP comes from a .funda doc
# the user opened, which may be hostile). Caps bound the worst case BEFORE a heavy
# read/parse, so a crafted file can't OOM the worker or aim a parser fuzz at OCCT.
MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024   # reject any import file above this outright
# B-rep formats get a far higher ceiling than meshes. A STEP file is a compact
# description of exact surfaces, so its byte size says little about the work it
# implies; the 356 MiB reference assembly is 3,071 leaves and 133,284 faces. A
# MESH file of the same byte size is a far larger triangle count and a much
# heavier viewport, which is why STL/3MF/OBJ keep the lower cap.
#
# What actually protects the machine now is the RAM check
# (_refuse_if_memory_is_short), which scales with the file AND with what is free
# at that moment. This is only a backstop against absurd input, so it can be
# generous without being reckless.
MAX_IMPORT_BREP_FILE_BYTES = 1024 * 1024 * 1024
MAX_IMPORT_SCAN_BYTES = 64 * 1024 * 1024    # decompressed ASCII-STL / 3MF scan window

IMPORT_PHASE_READ = 0        # reading + converting the file (build123d import_step)
IMPORT_PHASE_CANONICALIZE = 1  # _canonicalize: the LARGEST phase on a big assembly
IMPORT_PHASE_ENCODE = 2      # serialising the B-rep for the wire


def _import_size_cap(fmt):
    """The file-size ceiling for `fmt`. B-rep formats (STEP/STP/BREP) get the
    higher one; everything mesh-shaped keeps the original."""
    return (
        MAX_IMPORT_BREP_FILE_BYTES
        if fmt in ("step", "stp", "brep")
        else MAX_IMPORT_FILE_BYTES
    )


def _count_stream(fh, needle, limit, max_bytes=None):
    """Count `needle` occurrences in a binary stream WITHOUT loading it whole.
    Reads 1 MiB chunks; keeps a len(needle)-1 byte carry between chunks so a match
    straddling a chunk boundary counts exactly once (the carry is shorter than the
    needle, so it can't itself hold a match — no double counting). Stops as soon as
    the count exceeds `limit` (already over the import cap) or `max_bytes` are read,
    so an oversized ASCII STL / 3MF model can't be slurped into memory."""
    nlen = len(needle)
    count = 0
    total = 0
    carry = b""
    while True:
        chunk = fh.read(1 << 20)
        if not chunk:
            break
        total += len(chunk)
        buf = carry + chunk
        count += buf.count(needle)
        carry = buf[-(nlen - 1):] if nlen > 1 else b""
        if count > limit or (max_bytes is not None and total >= max_bytes):
            return count
    return count


def _peek_triangle_count(path, fmt):
    """Best-effort triangle count straight from the file, WITHOUT building a B-rep,
    so a too-dense import fails fast. Streams large files in chunks (stops past the
    cap) so a multi-GB ASCII STL or a lying-header 3MF can't be slurped into memory.
    Returns None when it can't tell.

    A 3MF is summed over EVERY .model part, not just the first: the production
    extension that Bambu, Orca and PrusaSlicer write leaves 3D/3dmodel.model as
    a manifest of <build><item> references with zero triangles and puts the
    geometry in 3D/Objects/*.model, so reading the first part alone counted 0
    for the whole file. The sum errs LONG by one per part, for that part's
    <triangles> container element.

    The placements in <build> are deliberately NOT counted. build123d's Mesher
    reads GetMeshObjects() and never looks at a build item, so a part placed 20
    times is read ONCE: measured, a production-extension 3MF placing one 12-face
    box 1, 2 and 20 times reads back as one shape of 12 faces and volume 1000
    every time. Scaling the sum by the placements charged this gate for geometry
    that is never built, and because the gate is a HARD REFUSAL (see
    import_geometry) erring long here means rejecting a healthy plate with a
    fabricated number in the message: one 40,000-triangle part placed 4 times
    was refused as "~160,004 triangles"."""
    cap = MAX_IMPORT_TRIANGLES
    try:
        if fmt == "stl":
            with open(path, "rb") as fh:
                head = fh.read(84)
            if head[:5].lower() == b"solid":
                with open(path, "rb") as fh:
                    return _count_stream(fh, b"facet normal", cap, MAX_IMPORT_SCAN_BYTES)
            import struct  # binary STL: uint32 triangle count at byte 80
            return struct.unpack("<I", head[80:84])[0]
        if fmt == "3mf":
            import zipfile
            with zipfile.ZipFile(path) as z:
                parts = [n for n in z.namelist() if n.lower().endswith(".model")]
                if not parts:
                    return None
                # zip-bomb guard: the declared UNCOMPRESSED sizes are in the
                # central directory (no decompress), and the budget is the TOTAL
                # over every part — 100 parts of 63 MiB each are a bomb even
                # though none of them is one alone. Past the scan window, return
                # a sentinel above the cap so the caller rejects it.
                if sum(z.getinfo(n).file_size for n in parts) > MAX_IMPORT_SCAN_BYTES:
                    return cap + 1
                total = 0
                budget = MAX_IMPORT_SCAN_BYTES
                for nm in parts:
                    size = z.getinfo(nm).file_size
                    with z.open(nm) as fh:  # stream-decompress, bounded by budget
                        total += _count_stream(fh, b"<triangle", cap, budget)
                    # Charged ONCE per part. The guard above bounds the sum of
                    # the parts by the window, so budget >= size on every pass
                    # and `_count_stream` can never be handed an exhausted
                    # window — which matters because it returns a FLOOR when it
                    # is cut short, and this function has no way to say so.
                    budget -= size
                return total
        if fmt == "obj":
            n = 0
            with open(path, "rb") as fh:
                for ln in fh:  # lazy line iteration, early-break past the cap
                    if ln.startswith(b"f "):
                        n += 1
                        if n > cap:
                            return n
            return n
    except Exception:
        return None
    return None


def _canonicalize_roots(roots):
    """Canonicalise a multi-root file PER ROOT, then compound the results.

    Per root for the same reason the assembly path works per leaf: `_canonical_ok`
    compares `result.volume` against `shape.volume`, and `Compound.volume` does
    not recurse into nested compounds. Hand the gate a multi-root compound and it
    reads a partial volume it can never match, so `_canonicalize` does the whole
    expensive pass and then silently discards every bit of it. Per root, each
    comparison is on a shape the gate can actually measure.

    REACHABILITY, measured rather than assumed: this needs a STEP whose product
    count does not exceed its root count (`step_assembly`'s `is_assembly` test),
    with more than one root. A file written by OCCT's own STEPCAFControl_Writer
    from two free shapes does NOT qualify — it gains a wrapper product, so 2
    roots arrive as 3 nodes and the file takes the assembly path instead. So this
    is a correctness fix on a branch that another writer's output can reach, not
    one demonstrated against a file in this repo.
    """
    out = []
    for r in roots:
        w = _wrap_topods(r)
        if w is not None:
            out.append(_canonicalize(w))
    return Compound(children=out)


def _canonical_ok(result, shape, deep=True):
    """Is `result` an acceptable canonicalisation of `shape`?

    Same solid count, same face count, and with `deep`, also structurally valid
    with the volume within 0.5%. Any doubt (an exception anywhere in the checks)
    is a NO — this decides whether a rewritten surface gets baked permanently
    into the stored B-rep, so the safe answer is to keep the original.

    `deep` exists because the two halves differ in cost by two orders of
    magnitude. MEASURED across the 3,060 leaves of the reference assembly:
    the counts cost 3.5 s, `BRepCheck_Analyzer` 72 s and the volume comparison
    122 s. Running the full gate on every leaf made _canonicalize 209 s against
    the 6.9 s it costs without — 29x the entire pass it was meant to guard, and
    62% of the whole import.

    So: full gate after the sew/ShapeFix rebuild below, which re-creates faces
    from scratch and genuinely can produce an invalid or volume-shifted solid.
    Counts only after SweptToElementary alone, which is a topology-preserving
    modifier — the counts still catch gross damage, and this path previously had
    NO validation at all.

    NOTE the volume comparison is only meaningful when neither side is a compound
    of compounds: `Compound.volume` does not recurse, so on nested input it reads
    a partial figure and the gate can never pass. Callers with multi-root input
    must canonicalise per root (see import_geometry) rather than hand the whole
    compound in here.
    """
    from OCP.BRepCheck import BRepCheck_Analyzer

    try:
        if len(result.solids()) != max(1, len(shape.solids())):
            return False
        if len(result.faces()) != len(shape.faces()):
            return False
        if not deep:
            return True
        return bool(
            BRepCheck_Analyzer(result.wrapped).IsValid()
            and abs(result.volume - shape.volume)
            <= max(1e-6, 0.005 * abs(shape.volume))
        )
    except Exception:  # noqa: BLE001 — an unmeasurable result is not acceptable
        return False


def _canonicalize(shape, tol=1e-3):
    """Canonical-recognition pre-pass for B-rep imports (STEP): snap near-analytic
    B-spline/Bezier faces to true planes/cylinders/cones/spheres, and swept
    surfaces to elementary ones. STEP writers routinely emit splines for what is
    really a plane or cylinder; defeaturing heals by EXTENDING neighbour surfaces,
    and extension is exact on analytic surfaces but fragile polynomial
    extrapolation on splines — snapping at import is what lets Delete Face work
    on such models. Best-effort and hard-validated (same face/solid counts, valid
    B-rep, volume within 0.5%): any doubt → the original shape, unchanged.
    All-analytic imports return immediately."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType

    CONVERTIBLE = (
        GeomAbs_SurfaceType.GeomAbs_BSplineSurface,
        GeomAbs_SurfaceType.GeomAbs_BezierSurface,
        GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion,
        GeomAbs_SurfaceType.GeomAbs_SurfaceOfRevolution,
    )
    try:
        faces = shape.faces()
        if not any(
            BRepAdaptor_Surface(f.wrapped).GetType() in CONVERTIBLE for f in faces
        ):
            return shape
    except Exception:
        return shape

    try:
        from OCP.BRep import BRep_Tool
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_Sewing
        from OCP.BRepCheck import BRepCheck_Analyzer
        from OCP.BRepTools import BRepTools
        from OCP.ShapeCustom import ShapeCustom, ShapeCustom_Surface
        from OCP.ShapeFix import ShapeFix_Face, ShapeFix_Shape, ShapeFix_Solid
        from OCP.TopAbs import TopAbs_SHELL, TopAbs_WIRE
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS

        # swept (extrusion/revolution) surfaces -> elementary, as a whole-shape
        # modifier that preserves topology
        work = _wrap_topods(ShapeCustom.SweptToElementary_s(shape.wrapped)) or shape

        converted = 0
        new_faces = []
        for f in work.faces():
            t = BRepAdaptor_Surface(f.wrapped).GetType()
            nf = f.wrapped
            if t in (
                GeomAbs_SurfaceType.GeomAbs_BSplineSurface,
                GeomAbs_SurfaceType.GeomAbs_BezierSurface,
            ):
                surf = BRep_Tool.Surface_s(f.wrapped)
                ana = ShapeCustom_Surface(surf).ConvertToAnalytical(tol, False)
                if ana is not None:
                    # rebuild the face on the analytic surface with the original
                    # wires; ShapeFix_Face re-projects the pcurves
                    outer = BRepTools.OuterWire_s(f.wrapped)
                    mf = BRepBuilderAPI_MakeFace(ana, outer)
                    wexp = TopExp_Explorer(f.wrapped, TopAbs_WIRE)
                    while wexp.More():
                        w = TopoDS.Wire_s(wexp.Current())
                        if not w.IsSame(outer):
                            mf.Add(w)
                        wexp.Next()
                    if mf.IsDone():
                        fix = ShapeFix_Face(mf.Face())
                        fix.Perform()
                        nf = fix.Face()
                        converted += 1
            new_faces.append(nf)
        if converted == 0:
            # `work` is SweptToElementary's output, and until now it was returned
            # here WITHOUT any of the validation every other exit applies. That
            # modifier rewrites surfaces across the whole shape; if it produced
            # something invalid or volume-shifted, the unchecked return baked it
            # into the embedded B-rep, permanently and silently. Same gate as the
            # converted path below.
            if work is not shape and _canonical_ok(work, shape, deep=False):
                return work
            return shape

        sew = BRepBuilderAPI_Sewing(max(tol, 1e-6))
        for nf in new_faces:
            sew.Add(nf)
        sew.Perform()
        # the transferred wires still carry pcurves referencing the OLD spline
        # surfaces — ShapeFix_Shape re-projects them onto the analytic ones
        # (without it the result is an invalid solid with the wrong volume)
        fixer = ShapeFix_Shape(sew.SewedShape())
        fixer.Perform()
        solids = []
        exp = TopExp_Explorer(fixer.Shape(), TopAbs_SHELL)
        while exp.More():
            sf = ShapeFix_Solid()
            solids.append(Solid(sf.SolidFromShell(TopoDS.Shell_s(exp.Current()))))
            exp.Next()
        if not solids:
            return shape
        result = solids[0] if len(solids) == 1 else Compound(solids)
        return result if _canonical_ok(result, shape) else shape
    except Exception:
        return shape


def _stl_distinct_normals(path):
    """How many DISTINCT facet normals a binary STL has, or None if it isn't one.

    Used as a cheap EMPIRICAL screen for "this mesh is organic and cannot reduce".
    It is deliberately NOT claimed as an exact bound: `_maybe_unify` merges only
    coplanar faces, but `_refacet_clean` also collapses NEAR-coplanar staircases,
    so the final face count can land well below the number of distinct normals —
    measured, a 4,001-normal sphere finishes at 1,269 faces. Calibrate against
    measurement, not against the merge rule.

    Binary STL stores the normal in the first 12 bytes of each 50-byte record, so
    this is one strided numpy read with no geometry work: measured 50 ms on 72k
    triangles. ASCII STL returns None (the caller then just skips the gate)."""
    import numpy as np

    try:
        size = os.path.getsize(path)
        if size < 84:
            return None
        with open(path, "rb") as fh:
            head = fh.read(84)
            ntri = int(np.frombuffer(head[80:84], dtype="<u4")[0])
            # the exact-size identity is what distinguishes binary from ASCII
            if ntri == 0 or size != 84 + 50 * ntri:
                return None
            raw = np.frombuffer(fh.read(50 * ntri), dtype=np.uint8)
        if raw.size != 50 * ntri:
            return None
        n = raw.reshape(ntri, 50)[:, :12].copy().view("<f4").reshape(ntri, 3)
        n = n[np.isfinite(n).all(axis=1)]
        if n.size == 0:
            return None
        # quantize before uniquing: triangles of one planar face give normals that
        # agree only to floating-point noise, and rounding merges them.
        return int(len(np.unique(np.round(n, 3), axis=0)))
    except Exception:
        return None


# Distinct-facet-normal ceiling for the early organic-mesh refusal in
# _sew_mesh_file. CALIBRATED FROM MEASUREMENT, not derived — the screen is only a
# correlate of "will not reduce", so the number is set above every mesh observed
# to import successfully, and the cost of being wrong is rejecting a model that
# would have worked. Measured on spheres/tori (normals -> outcome on the slow
# path): 4,001 -> PASS (1,269 faces), 10,105 -> PASS (1,155 faces),
# 8,631 -> reject, 19,918 -> reject. The pass/reject frontier is not monotonic in
# this statistic, so the gate sits at 20,000 — clear of the largest measured PASS
# by ~2x. Anything between 10k and 20k simply takes the old slow path and gets the
# old answer; the gate exists for the 40k-175k range, where the slow path costs
# ~2 minutes or SIGSEGVs.
MAX_IMPORT_FACET_DIRECTIONS = 20_000


def _too_dense_error(ntri):
    """The user-facing refusal for a mesh past MAX_IMPORT_TRIANGLES.

    Raised from two places, which is not redundancy: import_geometry uses the
    cheap header/line-count peek, while _sew_obj_file re-checks the EXACT count
    after parsing, because an OBJ n-gon fans out to more triangles than the
    peek's one-per-`f`-line estimate."""
    return ValueError(
        f"This mesh has ~{ntri:,} triangles — too dense to import as an editable "
        f"model (limit ~{MAX_IMPORT_TRIANGLES:,}). It's almost certainly an organic/"
        f"scanned model; reduce it first, or import a STEP / clean CAD mesh."
    )


def _sew_mesh_file(path):
    """Read a triangle-mesh file (STL/3MF/OBJ) into a sewn, editable B-rep body.

    Shared by the mesh formats and by the glTF path, which round-trips its
    triangles through a temporary STL to get here — the sew + unify + refacet
    sequence is what turns 12 triangles back into a 6-faced box, and duplicating
    it for glTF would mean maintaining two versions of the same recovery."""
    # Refuse a hopeless mesh BEFORE the expensive path, not after it. The face gate
    # at the bottom of this function only fires once sew + unify + refacet have run,
    # which on an organic mesh means the user waits for work that cannot succeed:
    # measured 117.8 s for a 125,706-triangle sphere before the refusal, and at
    # 147,851 triangles ShapeUpgrade_UnifySameDomain SIGSEGVs the worker outright
    # (~35 s in, reproduced twice) — under MAX_IMPORT_TRIANGLES, so the cap does not
    # protect against it. Screening on facet directions rejects those in ~50 ms.
    #
    # OBJ and glTF both round-trip through a temporary binary STL to get here, so
    # they inherit the gate; native 3MF does not and still takes the slow path.
    nn = _stl_distinct_normals(path)
    if nn is not None and nn > MAX_IMPORT_FACET_DIRECTIONS:
        raise ValueError(
            f"This mesh is curved/organic ({nn:,} distinct facet directions — a clean "
            f"CAD part has a few hundred at most), so it cannot reduce to an editable "
            f"model. FundaCAD edits prismatic CAD models; import a STEP or a "
            f"flat-faced part."
        )
    shapes = Mesher().read(path)
    if not shapes:
        raise ValueError("no geometry found in the mesh file")
    shape = shapes[0] if len(shapes) == 1 else Compound(list(shapes))
    shape = _maybe_unify(shape)
    # collapse facet debris (slivers + near-coplanar staircases) so the
    # import is genuinely editable — crisp faces, crisp edges (best-effort;
    # returns the input unchanged on any doubt)
    shape = _refacet_clean(shape)
    # Judged PER BODY. "Did this reduce to something editable" is a question
    # about ONE part, and a project file from Bambu, Orca or PrusaSlicer is
    # inherently several parts, so summing them charged a multi-object plate N
    # times the budget of the same parts imported one at a time.
    bodies = _explode_solids(shape) or [shape]
    per_body = [len(b.faces()) for b in bodies]
    nf = max(per_body)
    if nf > MAX_IMPORT_FACES:
        # Name the offending body: with twelve objects in the file, a bare
        # number says nothing about WHICH one is the organic mesh.
        which = (f"body {per_body.index(nf) + 1} of {len(per_body)} has "
                 f"{nf:,} faces" if len(per_body) > 1 else f"{nf:,} faces")
        raise ValueError(
            f"This mesh didn't reduce to a clean editable model ({which}; a "
            f"curved/organic surface stays faceted). FundaCAD edits prismatic "
            f"CAD models; import a STEP or a flat-faced part."
        )
    total = sum(per_body)
    if total > MAX_IMPORT_TOTAL_FACES:
        raise ValueError(
            f"This file has too much detail to open ({total:,} faces across "
            f"{len(per_body):,} bodies, the limit is {MAX_IMPORT_TOTAL_FACES:,}). "
            f"Each part is simple enough on its own, so import fewer objects at "
            f"a time."
        )
    return shape


def _read_obj_triangles(path):
    """(positions, indices) from a Wavefront OBJ, triangulated.

    Only `v` and `f` matter for a solid import: normals and texture coords are
    per-corner presentation data that the sew + unify + refacet path recomputes
    anyway, and materials carry no geometry. Handles the three things real OBJ
    files in the wild actually use beyond the basics: `f a/b/c` corner triples
    (only the vertex index is read), NEGATIVE indices (relative to the vertices
    seen so far, per the spec), and n-gon faces (fan-triangulated, which is
    correct for the convex planar faces OBJ faces are required to be).

    Raises ValueError with a user-facing message rather than returning empty, so
    a malformed file cannot silently import as nothing."""
    verts, tris = [], []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                p = line.split()
                if len(p) >= 4:
                    verts.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("f "):
                idx = []
                for tok in line.split()[1:]:
                    s = tok.split("/", 1)[0]
                    if not s:
                        continue
                    i = int(s)
                    # OBJ is 1-based; a negative index counts back from the last
                    # vertex READ SO FAR, so it must be resolved here and not later
                    idx.append(i - 1 if i > 0 else len(verts) + i)
                for k in range(1, len(idx) - 1):  # fan
                    tris.extend((idx[0], idx[k], idx[k + 1]))
    if not verts or not tris:
        raise ValueError("no triangles found in the OBJ file")
    # Bounds-checked only now: a POSITIVE index may legally forward-reference a
    # vertex that appears further down the file, so `n` is not known during parse.
    n = len(verts)
    if any(i < 0 or i >= n for i in tris):
        raise ValueError("the OBJ file references vertices that do not exist")
    pos = [c for v in verts for c in v]
    return pos, tris


def _sew_triangles(pos, idx):
    """Sew a raw triangle soup into an editable B-rep body.

    Round-trips through a temporary binary STL so it lands in _sew_mesh_file:
    the sew + unify + refacet recovery there is what turns 12 triangles back
    into a 6-faced box, and neither the OBJ nor the glTF importer wants a
    second copy of it. Both call here."""
    import mesh_writers

    fd, tmp = tempfile.mkstemp(suffix=".stl")
    os.close(fd)
    try:
        mesh_writers.write_stl(pos, idx, tmp)
        return _sew_mesh_file(tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _sew_obj_file(path):
    """Read an OBJ into a sewn, editable B-rep body via the shared mesh path."""
    pos, idx = _read_obj_triangles(path)
    ntri = len(idx) // 3
    if ntri > MAX_IMPORT_TRIANGLES:
        raise _too_dense_error(ntri)
    return _sew_triangles(pos, idx)


def _glb_dominant_color(path):
    """The base colour of the glTF's most-used material, as '#RRGGBB', or None.

    Read straight from the GLB's JSON chunk rather than through XCAF: OCCT's
    RWGltf_CafReader does not populate the colour tool for these files (measured:
    ColorTool reports zero colours after a successful Perform), and the JSON is
    unambiguous.

    "Dominant" = the material covering the most triangles, not materials[0]. A
    file whose first material is a tiny detail would otherwise dictate the colour
    of the whole import. Returns None when the file carries no materials, which
    the caller must treat as "leave the body's colour alone".
    """
    import struct

    from mesh_writers import _linear_to_srgb_hex

    try:
        with open(path, "rb") as fh:
            head = fh.read(20)
            if len(head) < 20 or struct.unpack("<I", head[:4])[0] != 0x46546C67:
                return None
            jlen = struct.unpack("<I", head[12:16])[0]
            doc = json.loads(fh.read(jlen))
    except Exception:
        return None  # advisory only: never fail an import over a colour

    materials = doc.get("materials") or []
    if not materials:
        return None
    accessors = doc.get("accessors") or []
    weight = {}
    for mesh in doc.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            mat = prim.get("material")
            if mat is None:
                continue
            acc = prim.get("indices")
            n = accessors[acc].get("count", 0) if isinstance(acc, int) and acc < len(accessors) else 0
            weight[mat] = weight.get(mat, 0) + n
    best = max(weight, key=weight.get) if weight else 0
    if not isinstance(best, int) or best >= len(materials):
        return None
    factor = (materials[best].get("pbrMetallicRoughness") or {}).get("baseColorFactor")
    if not factor or len(factor) < 3:
        return None
    return _linear_to_srgb_hex(factor)


def _read_glb(path):
    """Read a binary glTF (.glb) into a single shape via OCCT's own reader.

    glTF is Y-up and carries its own unit scale; RWGltf_CafReader does both
    conversions itself (SetSystemCoordinateSystem / SetSystemLengthUnit), which is
    why this does not hand-roll a rotation — getting that wrong lands every import
    on its side, and the file still loads, so it is easy to miss.

    The result is a faceted mesh body with the same limits as the STL/OBJ path:
    glTF carries triangles, not B-rep, so there is nothing prismatic to recover.
    """
    from OCP.Message import Message_ProgressRange
    from OCP.RWGltf import RWGltf_CafReader
    from OCP.RWMesh import RWMesh_CoordinateSystem
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document

    doc = TDocStd_Document(TCollection_ExtendedString("glb"))
    reader = RWGltf_CafReader()
    reader.SetDocument(doc)
    reader.SetParallel(True)
    reader.SetSystemLengthUnit(0.001)  # our documents are millimetres
    reader.SetSystemCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup)
    reader.SetFileCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Yup)
    if not reader.Perform(TCollection_AsciiString(path), Message_ProgressRange()):
        raise ValueError("couldn't read this glTF file — it may be corrupt or not a .glb")
    shape = reader.SingleShape()
    if shape is None or shape.IsNull():
        raise ValueError("no geometry found in the glTF file")
    # _wrap_topods, not Shape.cast: the reader hands back a raw TopoDS_COMPOUND,
    # which Shape.cast() turns into None (see its docstring).
    wrapped = _wrap_topods(shape)
    if wrapped is None:
        raise ValueError("couldn't interpret the geometry in this glTF file")
    return wrapped


def _assembly_payload(asm):
    """Turn a read STEP assembly into the flat blob shape plus its manifest.

    The blob's top-level children ARE the leaf occurrences, in order, already
    world-placed. Nesting is deliberately NOT kept in the geometry: binding
    manifest row i to child i only needs flat order to survive the BREP round
    trip, which is a far weaker property than 12 levels of nesting surviving,
    and is asserted directly by test_assembly.py.

    `_canonicalize` runs PER LEAF rather than over the whole shape. That is not
    only cheaper — it is the only version that can work at all here. Gate 4
    compares `result.volume` against `shape.volume`, and `Compound.volume`
    (composite.py) does not recurse into nested compounds, so the gate is
    structurally unpassable for any assembly shape. A single solid is exactly
    what those gates were written for.
    """
    leaves, parts = [], []
    for node_index, topods in asm.leaves:
        leaf = _wrap_topods(topods)
        if leaf is None:
            continue
        if leaf.solids():
            leaf = _canonicalize(leaf)
        else:
            # A solid-less product (a bare face or shell) fails gate 1 —
            # `len(solids) == max(1, len(shape.solids()))` compares 0 against 1
            # — so canonicalizing it can only waste time and never succeed.
            pass
        leaves.append(leaf)
        parts.append({"node": node_index, "faces": len(leaf.faces())})

    nodes = [
        {
            "name": n.name,
            "parent": n.parent,
            **({"color": n.color} if n.color else {}),
        }
        for n in asm.nodes
    ]
    return Compound(children=leaves), nodes, parts


# Peak RSS an import costs, as a multiple of the FILE size, over and above the
# already-resident OCCT/build123d libraries. MEASURED on generated STEP
# assemblies: a 13.7 MiB file grew RSS by 122.1 MiB (8.94x) and a 46.1 MiB file
# by 370.4 MiB (8.04x) — linear in file size across that range. 10x is those
# numbers with headroom, not a guess.
#
# Deliberately conservative in the SAFE direction: over-estimating the cost makes
# us refuse an import that might just have fitted, which the user can act on.
# Under-estimating it hands them an OOM kill, which arrives as "the geometry
# kernel crashed" and sends them hunting a geometry bug that does not exist.
IMPORT_RSS_PER_FILE_BYTE = 10

# Leave this much of the estimate as slack for everything else on the machine.
# An import that would consume literally all available memory takes the desktop
# down with it.
_MEMORY_HEADROOM = 1.25


def _refuse_if_memory_is_short(size, available=None):
    """Refuse an import that plainly will not fit in RAM, BEFORE OCCT starts.

    An OOM kill lands on the worker as a bare SIGKILL with no traceback, which
    the supervisor can only report as "the geometry kernel crashed" — naming a
    geometry fault for what is actually a machine limit.

    Proceeds silently when memory cannot be measured (`available_bytes()`
    returns None on an unrecognised platform or a failed probe): refusing on a
    number we could not read would be a worse failure than the one this prevents.
    """
    if size <= 0:
        return
    if available is None:
        import sysmem
        available = sysmem.available_bytes()
    if available is None:
        return  # unknown — never refuse on a number we could not read
    need = size * IMPORT_RSS_PER_FILE_BYTE
    if need * _MEMORY_HEADROOM <= available:
        return
    import sysmem
    raise ValueError(
        f"not enough memory to import this file — it needs about "
        f"{sysmem.describe(need)} and only {sysmem.describe(available)} is free. "
        f"Close some applications and try again, or import a smaller file."
    )


def import_geometry(path, fmt):
    """Read an external geometry file and return the document payload for an
    `import` feature: {brep, solid, faces, name}. STL/3MF/OBJ are read as a
    (watertight) mesh solid; STEP/BREP come in as native B-rep."""
    fmt = (fmt or "").lower()
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    cap = _import_size_cap(fmt)
    if size > cap:
        raise ValueError(
            f"file is {size / (1024 * 1024):.0f} MiB — too large to import "
            f"(limit {cap // (1024 * 1024)} MiB)."
        )
    _refuse_if_memory_is_short(size)
    manifest = None
    if fmt in ("step", "stp"):
        # Read the XCAF product tree ourselves rather than through
        # build123d.import_step: that helper mangles every product name
        # (translate(" .()" -> "____"), so "M3 Nut (x20)" arrives as
        # "M3_Nut__x20_") and its `.children` are not world-placed. Same
        # STEPCAFControl_Reader underneath, so this is one read, not two.
        # Phase-marked because these are the two multi-minute stages on a large
        # assembly: measured 90.6 s for the read and 93.9 s for _canonicalize on
        # a 356 MiB file. _canonicalize being the LARGER of the two is why a bar
        # covering only the read would sit at 100% for a minute and a half.
        import step_assembly

        _import_phase(IMPORT_PHASE_READ)
        asm = step_assembly.read_assembly(path)
        _import_phase(IMPORT_PHASE_CANONICALIZE)
        if asm.is_assembly:
            shape, nodes, parts = _assembly_payload(asm)
            manifest = {"nodes": nodes, "parts": parts}
        else:
            # An ordinary part file stays on the historical path: ONE shape,
            # canonicalized whole, no manifest. Verified geometrically identical
            # to import_step's result across every .step in this repo.
            #
            # snap near-analytic spline faces to true planes/cylinders/… ONCE at
            # import, so the canonical form is baked into the embedded BREP.
            if len(asm.roots) == 1:
                shape = _canonicalize(_wrap_topods(asm.roots[0]))
            else:
                shape = _canonicalize_roots(asm.roots)
    elif fmt == "brep":
        shape = import_brep(path)
    elif fmt in ("stl", "3mf", "obj"):
        ntri = _peek_triangle_count(path, fmt)
        if ntri and ntri > MAX_IMPORT_TRIANGLES:
            raise _too_dense_error(ntri)
        if fmt == "obj":
            # build123d's Mesher reads ONLY .3mf and .stl, so every .obj import
            # raised a raw "Unknown file format .obj" — while both file pickers
            # advertised OBJ (src/io/files.ts). Parse it here and round-trip the
            # triangles through a temporary STL, exactly as the glTF branch below
            # does, so OBJ inherits the same sew + unify + refacet recovery
            # instead of a second copy of it.
            shape = _sew_obj_file(path)
        else:
            shape = _sew_mesh_file(path)
    elif fmt == "glb":
        # OCCT's glTF reader returns ONE triangulated FACE per mesh — geometrically
        # correct but a surface body, so a GLB box arrived as 1 face / 0 solids
        # where the identical STL imports as 6 faces and a real solid. Round-trip
        # the triangles through the shared mesh path rather than duplicating (or
        # skipping) its sew + unify + refacet work.
        from tessellate import tessellate

        pos, idx, _fids = tessellate(_read_glb(path), tolerance=0.01)
        ntri = len(idx) // 3
        if ntri > MAX_IMPORT_TRIANGLES:
            raise ValueError(
                f"This glTF has ~{ntri:,} triangles — too dense to import as an editable "
                f"model (limit ~{MAX_IMPORT_TRIANGLES:,}). Reduce it first, or import a "
                f"STEP / clean CAD mesh."
            )
        shape = _sew_triangles(pos, idx)
    else:
        raise ValueError(f"unsupported import format: {fmt}")

    is_solid = len(shape.solids()) > 0
    name = os.path.splitext(os.path.basename(path))[0] or "Imported"
    _import_phase(IMPORT_PHASE_ENCODE)
    # The content hash of the geometry in the durable blob store. This REPLACED
    # an inline base64 ASCII BREP: on the 356 MiB reference assembly that field
    # alone was 541.8 MiB, i.e. 4.2x over the websocket frame cap and 6.4x over
    # the 64 MiB embedded-BREP cap re-checked on every rebuild, which is why a
    # large assembly could not be opened at all. Documents saved before this
    # still carry `brep` and are still read (see _import_shape).
    out = {
        "geom": _shape_to_blob(shape),
        "solid": is_solid,
        "faces": len(shape.faces()),
        "name": name,
    }
    # Only glTF carries a material colour worth honouring. Omitted (not null) when
    # there is none, so the frontend can tell "no colour in the file" from black.
    if fmt == "glb":
        colour = _glb_dominant_color(path)
        if colour:
            out["color"] = colour
    # The assembly tree, when the file carried one. Absent for every other
    # import, which is what keeps the historical rebuild path byte-identical.
    if manifest:
        out.update(manifest)
    return out


# --- rebuild -----------------------------------------------------------------


# Optional progress hook (set by the server's worker init): called once per
# feature so the supervisor can kill on STALL rather than wall clock. Must
# never be able to break a rebuild.
on_feature_tick = None


# Import phase codes, published through the SAME channel rebuild progress uses
# (on_feature_tick -> the parent's _HB_IDX). Display only: OCP holds the GIL for
# the whole of ReadFile+Transfer, so nothing can be observed INSIDE a phase and
# these must never be mistaken for a liveness signal.
#
# Determinate progress is not available: Message_ProgressIndicator cannot be
# constructed or subclassed in this OCP build (forcing one via __new__ and
# calling Start() segfaults), every Message_ProgressRange reports IsActive()
# False, and a watchdog thread gets zero wakeups because of the GIL. Phase
# codes are what is left.

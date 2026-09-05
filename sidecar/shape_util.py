"""Turning a shape into bytes, and cleaning up what OCCT hands back.

Split out of builder.py, which had grown past seven thousand lines. Everything
here is a LEAF: it knows about shapes and nothing about features, documents or
the rebuild, so it can be imported from anywhere in the sidecar without a cycle.
Three jobs live together because they are the same job seen from three sides:

  - serialise a body (B-rep blob in, B-rep blob out) so it can ride in a
    document or over the wire;
  - make a mesh-derived shape presentable (_refacet_clean, _drop_debris,
    _unify_body) — a triangle soup sewn into a solid has thousands of coplanar
    facets, and merging them is what makes an imported model editable;
  - answer basic topology questions the rest of the sidecar keeps asking
    (_wrap_topods, _explode_solids, _as_compound, _wrapped_or_none).

builder.py re-exports every name below, so `builder._unify_body` and the tests
that reach for it keep working unchanged.
"""

import base64
import io
import os
import tempfile

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import (
    Compound,
    Face,
    Shape,
    Shell,
    Solid,
    export_brep,
    import_brep,
)

# `_list_shapes` is re-exported: an immutable function, so a second name for it
# cannot go stale. builder.py and defeature.py both reach for it through here.
from topo_adj import FaceAdjacency, _list_shapes  # noqa: F401

# --- mesh / B-rep import -----------------------------------------------------


def _shape_to_brep_b64(shape):
    """Serialize a body to a base64 ASCII BREP string. LEGACY.

    This is how imported geometry used to be embedded in the document. Nothing
    writes it any more — v5 stores binary BREP in the blob store and the document
    carries only its content hash (`_shape_to_blob`), because on the 356 MiB
    reference assembly this encoding produced a 541.8 MiB field, over both the
    websocket frame cap and the 64 MiB embedded-BREP cap.

    Kept because `_brep_b64_to_shape` still READS pre-v5 documents, and the tests
    need to be able to construct one."""
    buf = io.BytesIO()
    export_brep(shape, buf)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _shape_to_blob(shape):
    """Store a shape's geometry in the durable blob store and return its content
    hash.

    THE HASH RULE. `blobstore.put_bytes` hashes exactly the bytes it stores, at
    the moment they are produced, and we carry that value from here into the
    document. Never re-derive a hash by re-serialising a shape: `write(read(x))
    != x` byte-wise for BREP, because reading rebuilds the shape graph in a
    different but equivalent order. A re-derived hash would change on every
    generation, so every lookup would miss.

    Raises on failure, deliberately. The document no longer carries an embedded
    copy, so a hash we could not store means a feature with NO geometry
    anywhere — and quietly handing back a document like that would lose the
    user's import in a way nothing downstream could detect. Refusing the import
    is recoverable; a silently empty document is not."""
    import geomstore
    import blobstore

    try:
        return blobstore.default_store().put_bytes(geomstore.serialize_shape(shape))
    except Exception as e:  # noqa: BLE001
        raise ValueError(
            f"could not store the imported geometry ({e}). Check free disk space "
            "and permissions on the FundaCAD data directory."
        ) from e


def _brep_b64_to_shape(b64):
    """Inverse of _shape_to_brep_b64. Validates the decoded blob looks like a real
    OCCT BREP (magic header + sane size) BEFORE handing it to the parser, so a
    crafted .funda can't aim a parser fuzz at OCCT in the worker. import_brep
    needs a real path, so we round the bytes through a temp file."""
    data = base64.b64decode(b64)
    if len(data) > MAX_BREP_BYTES:
        raise ValueError("embedded BREP payload too large to import")
    # OCCT's BRepTools::Write emits a leading newline then "CASCADE Topology V<n>".
    # Strip the expected newline and require the signature right after it.
    if not data[: len(_BREP_MAGIC) + 2].lstrip(b"\n\r ").startswith(_BREP_MAGIC):
        raise ValueError("embedded payload is not a valid BREP (bad header)")
    fd, path = tempfile.mkstemp(suffix=".brep")
    os.close(fd)
    try:
        with open(path, "wb") as fh:
            fh.write(data)
        return import_brep(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _maybe_unify(shape):
    """Best-effort merge of coplanar facets into single faces (OCCT
    UnifySameDomain). A freshly-read STL has one B-rep face per triangle; merging
    the coplanar ones recovers real planar faces (a CAD-exported box becomes 6
    selectable faces, not 12 triangles) — so the import is genuinely editable
    (press/pull, fillet, select). Curved regions (a faceted hole) stay faceted;
    recovering smooth surfaces from those is RANSAC fitting, a separate step.
    Falls back to the original shape if the upgrade yields nothing usable."""
    try:
        from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

        up = ShapeUpgrade_UnifySameDomain(shape.wrapped, True, True, True)
        up.Build()
        merged = _wrap_topods(up.Shape())
        if merged is not None and len(merged.faces()) > 0:
            return merged
    except Exception:
        pass
    return shape


def _refacet_clean(shape, tol=0.12, debug=False):
    """Collapse facet-import raggedness. STL→B-rep leaves sliver bands and
    near-coplanar "staircase" faces around every real design plane (the planar
    merge unifies only EXACT coplanarity), and that debris is what defeats face
    picking, seam hiding, and Delete Face (the true supports hide behind
    slivers). Key insight: debris deviates from the design plane by DISTANCE
    (≤ ~0.1 mm) no matter how wild its own normal is — so region-grow faces by
    max vertex distance to an anchor plane (adjacency-only, so a real 0.1 mm
    AIR GAP between parts can't merge: those faces aren't edge-connected), snap
    the mesh vertices onto the intersection of their regions' planes, and
    rebuild the solid from the snapped mesh. Crisp planes meeting at crisp
    edges. Planar-only, best-effort, hard-validated: any doubt → the original
    shape, unchanged."""
    import numpy as np

    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType

    try:
        faces = _as_compound(shape).faces()
        if not faces or any(
            BRepAdaptor_Surface(f.wrapped).GetType() != GeomAbs_SurfaceType.GeomAbs_Plane
            for f in faces
        ):
            return shape  # planar-only pipeline (curved imports keep their B-rep)
    except Exception:
        return shape

    # clean each solid independently — two imported bodies can TOUCH, and a
    # shared sewing pass would stitch them together at the contact
    parts = _explode_solids(shape)
    if len(parts) > 1:
        cleaned_parts = [_refacet_clean(p, tol, debug=debug) for p in parts]
        if all(cp is p for cp, p in zip(cleaned_parts, parts)):
            return shape
        return Compound(cleaned_parts)

    try:
        comp = _as_compound(shape)
        adj = FaceAdjacency(comp)
        n = adj.extent
        faces_by_idx = {i: adj.face(i) for i in adj.indices()}
        neighbors = adj.neighbors

        fverts = {
            i: np.array([(v.X, v.Y, v.Z) for v in f.vertices()])
            for i, f in faces_by_idx.items()
        }

        # region-grow from the biggest faces: absorb an edge-adjacent face when
        # ALL its vertices lie within tol of the ANCHOR's plane (anchored, not
        # chained, so regions can't drift step by step across the part)
        region = {}
        planes = []  # region id -> (point, normal) as np arrays
        for i in sorted(faces_by_idx, key=lambda i: -faces_by_idx[i].area):
            if i in region:
                continue
            f = faces_by_idx[i]
            c, nv = f.center(), f.normal_at(f.center())
            p0 = np.array((c.X, c.Y, c.Z))
            nn = np.array((nv.X, nv.Y, nv.Z))
            rid = len(planes)
            planes.append((p0, nn))
            region[i] = rid
            queue = [i]
            while queue:
                k = queue.pop()
                for j in neighbors(k):
                    if j in region:
                        continue
                    d = np.abs((fverts[j] - p0) @ nn)
                    if len(d) and d.max() <= tol:
                        region[j] = rid
                        queue.append(j)
        if len(planes) >= n:
            return shape  # nothing merged — no debris to clean

        # mesh the whole shape once (consistent shared edges), weld vertices,
        # tag each welded vertex with the region planes of the faces using it
        import tessellate as _tess

        positions, indices, face_ids = _tess.tessellate(comp, 0.5)
        # tessellate() numbers faces by enumerate(comp.faces()) — translate that
        # 0-based order to fmap's 1-based indices instead of assuming they align
        fid_to_idx = {k: adj.index_of(f) for k, f in enumerate(comp.faces())}
        pos = np.array(positions).reshape(-1, 3)
        tris = np.array(indices).reshape(-1, 3)
        keys = [tuple(np.round(p / 1e-4).astype(np.int64)) for p in pos]
        weld = {}
        widx = np.empty(len(pos), dtype=np.int64)
        wpos = []
        for a, k in enumerate(keys):
            if k not in weld:
                weld[k] = len(wpos)
                wpos.append(pos[a])
            widx[a] = weld[k]
        wpos = np.array(wpos)
        vregions = [set() for _ in wpos]
        for t, fid in zip(tris, face_ids):
            rid = region.get(fid_to_idx.get(fid))
            if rid is None:
                continue
            for a in t:
                vregions[widx[a]].add(rid)

        # snap each welded vertex to the intersection of its regions' planes:
        # min |x−v| s.t. n_r·x = n_r·p_r — rank-deficient (near-parallel planes)
        # solved by lstsq, so a staircase vertex lands on the merged plane
        # instead of flying off along a bad intersection line
        snapped = wpos.copy()
        for vi, rs in enumerate(vregions):
            if not rs:
                continue
            A = np.array([planes[r][1] for r in rs])
            b = np.array([planes[r][1] @ planes[r][0] for r in rs])
            v = wpos[vi]
            try:
                y, *_ = np.linalg.lstsq(A @ A.T, b - A @ v, rcond=1e-3)
                x = v + A.T @ y
            except Exception:
                continue
            if np.linalg.norm(x - v) <= 3 * tol:
                snapped[vi] = x

        # rebuild each REGION as one planar polygon face: boundary edges of the
        # region's triangles chain into closed loops (outer + holes); points are
        # projected EXACTLY onto the region plane (lstsq snap residuals exceed
        # OCCT's plane-finding precision, so MakeFace gets the plane explicitly);
        # sewing at 1e-3 merges the per-face copies of shared boundaries. This
        # avoids the mesh round-trip entirely — no degenerate-triangle repair,
        # and the output IS the ideal one-face-per-plane solid.
        from collections import Counter, defaultdict

        from OCP.BRepBuilderAPI import (
            BRepBuilderAPI_MakeFace,
            BRepBuilderAPI_MakePolygon,
            BRepBuilderAPI_Sewing,
        )
        from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
        from OCP.ShapeFix import ShapeFix_Face, ShapeFix_Shape, ShapeFix_Solid
        from OCP.TopAbs import TopAbs_SHELL
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS

        tri_w = widx[tris]
        region_tris = defaultdict(list)
        for t, fid in zip(tri_w, face_ids):
            rid = region.get(fid_to_idx.get(fid))
            if rid is not None:
                region_tris[rid].append(t)

        new_faces = []
        for rid, rtris in region_tris.items():
            p0, nn = planes[rid]
            ec = Counter()
            for a, b, c in rtris:
                for e in ((a, b), (b, c), (c, a)):
                    ec[tuple(sorted(e))] += 1
            nxt = defaultdict(list)
            for a, b, c in rtris:
                for e in ((a, b), (b, c), (c, a)):
                    if ec[tuple(sorted(e))] == 1:
                        nxt[e[0]].append(e[1])
            loops = []
            while any(nxt.values()):
                start = next(k for k, v in nxt.items() if v)
                loop, v = [start], nxt[start].pop()
                guard = sum(len(x) for x in nxt.values()) + 2
                while v != start and guard > 0:
                    loop.append(v)
                    outs = nxt.get(v)
                    if not outs:
                        loop = None
                        break
                    v = outs.pop()
                    guard -= 1
                if loop and len(loop) >= 3:
                    loops.append(loop)
            if not loops:
                if debug:
                    print(f"refacet: region {rid} has no closed boundary")
                return shape  # a region without a closed boundary — bail

            def flat(idx_loop):
                # exact in-plane projection; prune ONLY exact duplicates — any
                # smarter (collinear) pruning must be identical in BOTH regions
                # sharing a boundary, or the sew is left with open T-junction
                # seams. Segmented collinear edges are merged by the final
                # UnifySameDomain pass instead.
                pts = [snapped[i] - ((snapped[i] - p0) @ nn) * nn for i in idx_loop]
                out = []
                m = len(pts)
                for k in range(m):
                    if np.linalg.norm(pts[k] - pts[(k - 1) % m]) < 1e-6:
                        continue
                    out.append(pts[k])
                return out

            def loop_area(pts):
                s = np.zeros(3)
                for k in range(len(pts)):
                    s += np.cross(pts[k], pts[(k + 1) % len(pts)])
                return abs(s @ nn) / 2

            wires = []
            for loop in loops:
                pts = flat(loop)
                if len(pts) < 3:
                    continue  # loop collapsed by the snap — nothing to bound
                mp = BRepBuilderAPI_MakePolygon()
                for p in pts:
                    mp.Add(gp_Pnt(*p))
                mp.Close()
                if mp.IsDone():
                    wires.append((mp.Wire(), loop_area(pts)))
            if not wires:
                continue  # region fully collapsed (pure debris) — no face needed
            wires.sort(key=lambda w: -w[1])
            mf = BRepBuilderAPI_MakeFace(
                gp_Pln(gp_Pnt(*p0), gp_Dir(*nn)), wires[0][0]
            )
            for w, _ in wires[1:]:
                mf.Add(w)
            if not mf.IsDone():
                if debug:
                    print(f"refacet: MakeFace failed for region {rid}")
                return shape  # can't rebuild this region faithfully — bail
            fx = ShapeFix_Face(mf.Face())
            fx.Perform()
            new_faces.append(fx.Face())

        # sew tolerance must cover the step seams: a vertex pinched between two
        # near-parallel surviving regions (a real step ≤ tol whose wall got
        # absorbed) cannot lie on both planes, so the two regions' boundary
        # copies diverge by up to ~tol there — sewing tighter leaves open seams
        sew = BRepBuilderAPI_Sewing(1.5 * tol)
        for f in new_faces:
            sew.Add(f)
        sew.Perform()
        fixer = ShapeFix_Shape(sew.SewedShape())
        fixer.Perform()
        sewn = fixer.Shape()
        # sewing disjoint bodies yields ONE shell holding several disconnected
        # face components; SolidFromShell on that is garbage (mixed orientation,
        # nonsense volume). Split faces into edge-connected components and build
        # one solid per component.
        cadj = FaceAdjacency(sewn)
        solids = []
        for compo in cadj.components():
            part_sew = BRepBuilderAPI_Sewing(1.5 * tol)
            for k in compo:
                part_sew.Add(cadj.key(k))
            part_sew.Perform()
            sexp = TopExp_Explorer(part_sew.SewedShape(), TopAbs_SHELL)
            while sexp.More():
                sf = ShapeFix_Solid()
                solids.append(Solid(sf.SolidFromShell(TopoDS.Shell_s(sexp.Current()))))
                sexp.Next()
        if not solids:
            if debug:
                print("refacet: sew produced no solids")
            return shape
        cleaned = solids[0] if len(solids) == 1 else Compound(solids)
        # merge the facet-length collinear edge segments left on the region
        # boundaries (faces are already maximal; this unifies EDGES)
        cleaned = _maybe_unify(cleaned)

        from OCP.BRepCheck import BRepCheck_Analyzer

        if debug:
            print(f"refacet: {len(cleaned.faces())} faces (was {n}), "
                  f"solids {len(_explode_solids(cleaned))} (was {len(_explode_solids(shape))}), "
                  f"valid {BRepCheck_Analyzer(cleaned.wrapped).IsValid()}, "
                  f"vol {cleaned.volume:.2f} vs {shape.volume:.2f}")
        ok = (
            len(cleaned.faces()) < n
            and len(_explode_solids(cleaned)) == len(_explode_solids(shape))
            and BRepCheck_Analyzer(cleaned.wrapped).IsValid()
            and abs(cleaned.volume - shape.volume)
            <= max(1.0, 0.01 * abs(shape.volume))
        )
        return cleaned if ok else shape
    except Exception:
        if debug:
            raise
        return shape


def _drop_debris(shape, debug=False):
    """Drop floating boolean debris from a body shape: a solid that is
    sub-epsilon (<0.1%) of the biggest piece AND has clear distance from it
    is residue of the cuts that carved the body, not user geometry (DDR: a
    1.5 mm³ chip floating 0.6 mm off the 17200 mm³ body). Anything touching —
    even zero-measure vertex/edge contact — is kept, as are all pieces of a
    genuinely multi-piece body. Best-effort: any doubt → shape unchanged."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    try:
        shape = _as_compound(shape)
        cached = getattr(shape, "_funda_drop", None)
        if cached is not None:
            return cached  # same input object => same output OBJECT (identity
            # matters: the server's mesh cache is keyed by shape identity, and
            # rebuilding a fresh Compound here every rebuild would defeat it)
        parts = shape.solids()
        # Count FIRST. Sorting by volume computes one per solid, and a body with
        # a single solid cannot have debris — so the old order paid for a volume
        # it then threw away. Measured on the reference assembly: 42.7 s across
        # 3,071 single-solid bodies, for an answer known from the count alone.
        if len(parts) < 2:
            return shape
        parts = sorted(parts, key=lambda s: -abs(s.volume))
        main, kept = parts[0], [parts[0]]
        for s in parts[1:]:
            tiny = abs(s.volume) < 1e-3 * abs(main.volume)
            if tiny and BRepExtrema_DistShapeShape(
                s.wrapped, main.wrapped
            ).Value() > 1e-7:
                if debug:
                    print(f"drop_debris: dropping floating solid "
                          f"vol {s.volume:.3f}")
                continue
            kept.append(s)
        if len(kept) == len(parts):
            return shape
        out = kept[0] if len(kept) == 1 else Compound(kept)
        try:
            shape._funda_drop = out
        except Exception:
            pass
        return out
    except Exception:
        if debug:
            raise
        return shape


def _unify_body(shape, debug=False):
    """Fuse a body's glued/overlapping constituent solids into unified material.

    Boolean joins of ragged facet-import bodies GLUE solids together instead of
    merging them: the body ends up a compound of individually-manifold solids
    sharing interface walls (cross-solid non-manifold edges), with coincident
    skin overlaps, genuine volume interpenetration (material double-counted in
    mass properties), and sometimes an inside-out duplicate solid that poisons
    point classification. All of that lives BETWEEN solids, so the per-solid
    _refacet_clean is structurally unable to see it. Repair (measured on the
    DDR document — proving-ground/membrane/): right inside-out solids with
    ShapeFix_Solid, then ONE N-ary fuse of all constituents + SimplifyResult
    (merges the coplanar splits the fuse leaves). Genuinely-disjoint pieces
    stay separate solids — fuse never merges non-touching or zero-measure
    (vertex/edge) contact, so grouped split bodies and separate physical
    pieces keep their identity. Best-effort, hard-validated: any doubt → the
    original shape, unchanged."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import TopTools_IndexedMapOfShape, TopTools_ListOfShape

    def _vol(topods):
        p = GProp_GProps()
        BRepGProp.VolumeProperties_s(topods, p)
        return p.Mass()

    try:
        smap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(shape.wrapped, TopAbs_SOLID, smap)
        solids = [TopoDS.Solid_s(smap.FindKey(i)) for i in range(1, smap.Extent() + 1)]
        if not solids:
            return shape
        vols = [_vol(s) for s in solids]
        if len(solids) == 1 and vols[0] >= 0:
            return shape  # a single right-side-out solid has nothing to unify

        fixed = []
        for s in solids:
            fx = ShapeFix_Solid(s)
            fx.Perform()
            out = fx.Solid()
            fixed.append(s if out.IsNull() else out)

        if len(fixed) == 1:
            merged = fixed[0]  # lone inside-out solid, righted above
        else:
            args = TopTools_ListOfShape()
            args.Append(fixed[0])
            tools = TopTools_ListOfShape()
            for s in fixed[1:]:
                tools.Append(s)
            op = BRepAlgoAPI_Fuse()
            op.SetArguments(args)
            op.SetTools(tools)
            op.Build()
            if not op.IsDone():
                return shape
            try:
                op.SimplifyResult()  # cosmetic: merge coplanar fuse splits
            except Exception:
                pass
            merged = op.Shape()
            if merged.IsNull():
                return shape

        cleaned = _wrap_topods(merged)
        if cleaned is None:
            return shape

        # Debris dropped here is ≤0.1% of the max constituent per chunk,
        # well inside tol_v below, so the bracket gate needs no adjustment.
        cleaned = _drop_debris(cleaned, debug=debug)

        # The union is at least the biggest constituent and at most their sum
        # (an inside-out duplicate contributes nothing; interpenetration is
        # counted once). Outside that bracket the fuse ate or invented
        # material. NOTE: shrinking from the input compound's naive GProp mass
        # is EXPECTED — that mass double-counts overlaps; the union is the
        # physically true volume.
        hi = sum(abs(v) for v in vols)
        lo = max(abs(v) for v in vols)
        tol_v = max(1.0, 0.01 * hi)
        v_after = cleaned.volume
        n_after = len(cleaned.solids())
        valid = BRepCheck_Analyzer(cleaned.wrapped).IsValid()
        if debug:
            print(f"unify: solids {len(solids)} -> {n_after}, "
                  f"vol {sum(vols):.2f} -> {v_after:.2f} "
                  f"(bracket {lo:.2f}..{hi:.2f}), valid {valid}")
        ok = (
            valid
            and 1 <= n_after <= len(solids)
            and lo - tol_v <= v_after <= hi + tol_v
            and v_after > 0
        )
        return cleaned if ok else shape
    except Exception:
        if debug:
            raise
        return shape


def _wrap_topods(topods):
    """Wrap a raw TopoDS_Shape in the right build123d class. build123d's
    Shape.cast() returns None for some OCCT-produced solids (e.g. the output of
    UnifySameDomain), so dispatch on the concrete shape type ourselves."""
    if topods is None or topods.IsNull():
        return None
    from OCP.TopAbs import TopAbs_ShapeEnum

    t = topods.ShapeType()
    if t == TopAbs_ShapeEnum.TopAbs_SOLID:
        return Solid(topods)
    if t in (TopAbs_ShapeEnum.TopAbs_COMPOUND, TopAbs_ShapeEnum.TopAbs_COMPSOLID):
        return Compound(topods)
    if t == TopAbs_ShapeEnum.TopAbs_SHELL:
        return Shell(topods)
    if t == TopAbs_ShapeEnum.TopAbs_FACE:
        return Face(topods)
    return Shape.cast(topods)


# Untrusted-input guards for an embedded B-rep body: it comes out of a document
# the user opened, which may be hostile, so the decoded size is capped before
# OCCT is handed the bytes and the header is checked before that.
MAX_BREP_BYTES = 64 * 1024 * 1024           # decoded embedded-BREP body cap
_BREP_MAGIC = b"CASCADE Topology V"         # OCCT ASCII BREP header signature

def _loose_children(shape):
    """The DIRECT children of a compound that carry no solid of their own.

    Direct children, not `.shells()`: every solid owns a shell, so shelling the
    whole shape would count each solid twice."""
    w = getattr(shape, "wrapped", None)
    if w is None:
        return []
    from OCP.TopAbs import TopAbs_ShapeEnum
    from OCP.TopoDS import TopoDS_Iterator

    if w.ShapeType() != TopAbs_ShapeEnum.TopAbs_COMPOUND:
        return []
    out = []
    it = TopoDS_Iterator(w)
    while it.More():
        child = _wrap_topods(it.Value())
        if child is not None and not child.solids():
            out.append(child)
        it.Next()
    return out


def _explode_solids(shape):
    """Split an imported shape into individually-controllable bodies. A multi-object
    STL comes back as ONE solid with several disconnected shells (Mesher fuses
    objects); a multi-object 3MF comes back as several solids. So `.solids()` alone
    isn't enough — for each solid with >1 shell, wrap each shell in its own solid.
    A non-solid (open shell / surface) is passed through as one body."""
    solids = shape.solids()
    if not solids:
        return [shape]
    out = []
    for sd in solids:
        shells = sd.shells()
        if len(shells) <= 1:
            out.append(sd)
            continue
        from OCP.BRep import BRep_Builder
        from OCP.TopoDS import TopoDS_Solid

        for sh in shells:
            mk = TopoDS_Solid()
            bld = BRep_Builder()
            bld.MakeSolid(mk)
            bld.Add(mk, sh.wrapped)
            out.append(_maybe_unify(_wrap_topods(mk)))
    # A compound can MIX a solid with a non-solid, and the `if not solids`
    # fallback above never fires for it. A mesh file holding one watertight and
    # one non-watertight object sews to exactly that: build123d hands back a
    # Shell for anything that does not close (Mesher._get_shape returns the bare
    # outer shell when `not outer_shell.is_manifold`). Dropping those made the
    # caller's per-body face gates blind to them — measured, 60 of a compound's
    # 66 faces were counted by neither MAX_IMPORT_FACES nor the whole-file
    # backstop, so a scanned organic part rode into the document alongside a
    # clean bracket. Judge each loose child as a body in its own right.
    out.extend(_loose_children(shape))
    return out

def _as_compound(s):
    """Normalize a possibly-disjoint shape (a build123d ShapeList, e.g. a body split
    into pieces, or an extrude of several disjoint region faces) to a single
    Compound so .bounding_box() and boolean ops work. Single shapes pass through.

    A ShapeList is a `list` subclass, so we wrap by TYPE rather than by probing
    `.wrapped`: build123d >=0.11 asserts on `.wrapped` for an EMPTY single shape (an
    empty boolean result), which must pass through untouched, not be re-wrapped."""
    if _wrapped_or_none(s) is not None:
        return s  # a real, non-empty single shape
    if isinstance(s, (list, tuple)):
        return Compound(list(s))  # a ShapeList of disjoint shapes
    return s  # an empty single shape (0.11 asserts on .wrapped) — pass through

def _wrapped_or_none(sh):
    """`sh.wrapped` (the single TopoDS shape) or None, tolerating two cases: a
    ShapeList has no single wrapped shape, and build123d >=0.11 makes `.wrapped` a
    property that ASSERTS on an empty shape (`_wrapped is None`) where 0.10 left the
    attribute simply absent. Both mean 'no usable solid here'."""
    try:
        return sh.wrapped
    except (AttributeError, AssertionError):
        return None

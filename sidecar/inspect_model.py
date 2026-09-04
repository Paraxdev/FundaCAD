"""What is actually in the model, in the terms a caller can act on.

The frontend measures off the MESH, because a browser has nothing else. The
sidecar has the B-rep, so the exact quantities — volume, surface area, centre of
mass, what kind of surface each face actually is — are one OCCT call away, and
this is where they are asked for.

Two things here are not measurements and matter more than the measurements:

  * every face and edge comes back with a ready-made SELECTOR, authored by
    geom_select's own fingerprint functions. A caller that has never clicked on
    anything can still say "fillet that edge", because the selector it needs is
    in the reply it just read. Handing back a bare point instead would push the
    caller into by:"nearest", which refuses an ambiguous pick and silently
    resolves a marginal one.

  * an edge says which FACES it lies between. Two entries that are the same
    index mean a seam, i.e. a face that wraps all the way round and closes on
    itself. That is exactly the edge ChFi3d will not blend and the face a linear
    press/pull has no direction for, so the caller can see the refusal coming
    instead of reading it out of an exception string.

Sizes are capped. A 60,000-face import must not turn one question into a
40 MB answer, so faces and edges are truncated and the reply says so.
"""

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from geom_select import edge_fingerprint, face_fingerprint
from shape_util import _as_compound
from topo_adj import FaceAdjacency, face_wraps

#: Default caps. Generous enough that every hand-built model is complete, small
#: enough that an imported mesh body cannot produce a reply nobody can read.
MAX_FACES = 400
MAX_EDGES = 800


def _xyz(p):
    """Three plain floats out of a point, whichever kind it is.

    build123d exposes X/Y/Z as PROPERTIES and raw OCCT exposes them as METHODS,
    and both kinds arrive here — the fingerprints come back through build123d,
    the extrema and mass properties come back as gp_Pnt. Getting this wrong is
    silent: every call site is inside a try that turns the TypeError into a
    missing field, so the reply simply loses the point rather than failing."""
    out = []
    for name in ("X", "Y", "Z"):
        v = getattr(p, name)
        out.append(float(v() if callable(v) else v))
    return out


def _round3(v):
    """Coordinates to 6 decimals. Micron-scale noise in the 12th place is not
    information, and it triples the size of every reply that carries it."""
    return [round(float(x), 6) for x in v]


def _point_on(face):
    """A point that genuinely lies ON `face` — the centroid projected onto the
    surface.

    The centroid itself does not: on an annulus it sits in the hole, on a bent
    face it sits behind it. by:"nearest" scores by true point-to-surface
    distance, so a centroid handed back as "the point on this face" is a point
    whose nearest face may be a different one. Returns None if the projection
    fails, and then the caller simply has no point for that face — the selector
    is the part that has to work."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.gp import gp_Pnt

    try:
        c = face.center()
        v = BRepBuilderAPI_MakeVertex(gp_Pnt(float(c.X), float(c.Y), float(c.Z))).Vertex()
        d = BRepExtrema_DistShapeShape(face.wrapped, v)
        d.Perform()
        if not d.IsDone() or d.NbSolution() < 1:
            return None
        return _round3(_xyz(d.PointOnShape1(1)))
    except Exception:
        return None


def _axis_of(face):
    """The axis direction of a surface of revolution (cylinder, cone, torus,
    surface of revolution), or None for anything without one."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType

    try:
        s = BRepAdaptor_Surface(face.wrapped)
        t = s.GetType()
        if t == GeomAbs_SurfaceType.GeomAbs_Cylinder:
            ax = s.Cylinder().Axis()
        elif t == GeomAbs_SurfaceType.GeomAbs_Cone:
            ax = s.Cone().Axis()
        elif t == GeomAbs_SurfaceType.GeomAbs_Torus:
            ax = s.Torus().Axis()
        elif t == GeomAbs_SurfaceType.GeomAbs_SurfaceOfRevolution:
            ax = s.AxeOfRevolution()
        else:
            return None
        d = ax.Direction()
        return _round3([d.X(), d.Y(), d.Z()])
    except Exception:
        return None


def _face_entry(i, face, adj, renum, body_id, part):
    fp = face_fingerprint(face, part)
    e = {
        "i": i,
        "surface": fp.get("surface"),
        "area": round(float(fp.get("area") or 0.0), 6),
        "centroid": _round3(fp["centroid"]),
        "normal": _round3(fp["normal"]),
        "wraps": face_wraps(face),
        "neighbors": sorted(renum(j) for j in adj.neighbors(adj.index_of(face))
                            if renum(j) is not None),
        "selector": {"kind": "face", "by": "match", "fp": fp, "body": body_id},
    }
    p = _point_on(face)
    if p is not None:
        e["point"] = p
    if "radius" in fp:
        e["radius"] = round(float(fp["radius"]), 6)
    ax = _axis_of(face)
    if ax is not None:
        e["axis"] = ax
    return e


def _edge_entry(i, edge, adj, renum, body_id, part):
    fp = edge_fingerprint(edge, part)
    faces = [renum(j) for j in adj.faces_of_edge(edge)]
    faces = [j for j in faces if j is not None]
    e = {
        "i": i,
        "curve": fp.get("curve"),
        "length": round(float(fp.get("length") or 0.0), 6),
        "mid": _round3(fp["mid"]),
        "dir": _round3(fp["dir"]),
        "faces": faces,
        "selector": {"kind": "edge", "by": "match", "fp": fp, "body": body_id},
    }
    # A seam lists ONE face twice; a free boundary lists one face once. Both are
    # edges a blend will refuse, and they are refused for different reasons, so
    # they are named separately rather than lumped together as "bad edge".
    if len(faces) == 2 and faces[0] == faces[1]:
        e["seam"] = True
    elif len(faces) < 2:
        e["openBoundary"] = True
    if "radius" in fp:
        e["radius"] = round(float(fp["radius"]), 6)
    if "center" in fp:
        e["center"] = _round3(fp["center"])
    return e


def _mass_props(shape):
    """(volume mm3, area mm2, centre of mass). Any of them may be None: a shell
    or a bare face has no volume, and a degenerate shape has nothing at all."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    vol = area = com = None
    try:
        g = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape.wrapped, g)
        v = float(g.Mass())
        if abs(v) > 1e-12:
            vol = round(abs(v), 6)
            com = _round3(_xyz(g.CentreOfMass()))
    except Exception:
        pass
    try:
        g = GProp_GProps()
        BRepGProp.SurfaceProperties_s(shape.wrapped, g)
        area = round(float(g.Mass()), 6)
        if com is None:
            com = _round3(_xyz(g.CentreOfMass()))
    except Exception:
        pass
    return vol, area, com


def _bbox(shape):
    try:
        bb = shape.bounding_box()
        return {"min": _round3([bb.min.X, bb.min.Y, bb.min.Z]),
                "max": _round3([bb.max.X, bb.max.Y, bb.max.Z]),
                "size": _round3([bb.size.X, bb.size.Y, bb.size.Z])}
    except Exception:
        return None


def inspect_bodies(bodies, detail=True, max_faces=MAX_FACES, max_edges=MAX_EDGES):
    """The report, for a list of built bodies ({"id", "name", "shape"} dicts).

    Pure of the wire and of the document: this is the half a test can drive with
    two boxes and no rebuild at all."""
    out = []
    for b in bodies:
        shape = b.get("shape")
        if shape is None:
            out.append({"id": b.get("id"), "name": b.get("name"), "empty": True})
            continue
        comp = _as_compound(shape)
        vol, area, com = _mass_props(comp)
        entry = {
            "id": b.get("id"),
            "name": b.get("name"),
            "bbox": _bbox(comp),
            "volume": vol,
            "area": area,
            "centerOfMass": com,
        }
        faces = list(comp.faces())
        edges = list(comp.edges())
        entry["faceCount"] = len(faces)
        entry["edgeCount"] = len(edges)
        entry["solidCount"] = len(list(comp.solids()))
        if detail:
            adj = FaceAdjacency(comp)
            # FaceAdjacency numbers faces the way OCCT's shape map does; `i`
            # here is the position in comp.faces(). Measured, the two orders
            # agree on every shape tried (box, cylinder, washer, a cut, a fuse,
            # a two-solid compound) — which is why there is no test that fails
            # without this map. It is here because nothing DOCUMENTS that they
            # agree: it is a coincidence of two libraries both walking a
            # TopExp_Explorer, and a face index that silently means a different
            # face is the kind of wrong nobody would find from the reply.
            renum_map = {adj.index_of(f): k for k, f in enumerate(faces)}
            renum = renum_map.get
            fs, es = faces[:max_faces], edges[:max_edges]
            # `i` is the face's position in comp.faces(), which is the index the
            # tessellator, the owners map and the frontend's face ids all use.
            # Anything else here would be a second numbering nobody could join.
            entry["faces"] = [_face_entry(k, f, adj, renum, b.get("id"), comp)
                              for k, f in enumerate(fs)]
            entry["edges"] = [_edge_entry(k, e, adj, renum, b.get("id"), comp)
                              for k, e in enumerate(es)]
            if len(faces) > len(fs) or len(edges) > len(es):
                entry["truncated"] = {"faces": len(faces) - len(fs),
                                      "edges": len(edges) - len(es)}
        out.append(entry)
    return out

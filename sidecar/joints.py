"""Joints: place one body by mating a frame on it to a frame on another."""

import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py
from build123d import (
    Compound,
    Location,
    Plane,
    Vector,
)
from booleans import _skip_feature
from errors import BAD_REQUEST, GeomError
from geom_select import (
    _edge_dir,
    _edge_mid,
    _face_normal,
    resolve_edges,
    resolve_faces,
)
from shape_util import _wrapped_or_none


def _joint_body_shape(ctx, bid):
    """The single OCCT shape of a body a joint connector names, or None. A
    disjoint body is a ShapeList with no single `.wrapped`, so normalize to a
    Compound first, the way _handle_move does before it transforms one."""
    b = ctx.find_body(bid)
    if b is None:
        return None
    sh = b.get("shape")
    if sh is None:
        return None
    return sh if _wrapped_or_none(sh) is not None else Compound(list(sh))


def _joint_frame(spec, ctx, fid):
    """Resolve a mate connector to a Plane: an origin plus a z axis (the mating
    direction) and an x axis (the rotational reference). A connector is one of:
      - explicit  {"origin":[x,y,z], "zdir":[...], "xdir":[...]}   world frame
      - a datum   {"datum": <datumId>}                            follows the datum
      - a face    {"body": <id>, "face": <selector>}   centre + outward normal
      - an edge   {"body": <id>, "edge": <selector>}   midpoint + direction
    A connector on geometry is a REFERENCE, re-resolved every rebuild, so the
    joint follows the parts as they change (the whole point of a mate over a
    baked Move). Returns None when a geometry reference no longer resolves, the
    caller then leaves the moving body where it is rather than failing the build.
    """
    def plane(o, z, x=None):
        z = Vector(*z)
        if z.length < 1e-9:
            raise GeomError("joint: a connector's axis is zero length", BAD_REQUEST)
        if x is not None:
            xv = Vector(*x)
            if xv.length > 1e-9:
                return Plane(origin=tuple(o), x_dir=tuple(xv.normalized()),
                             z_dir=tuple(z.normalized()))
        return Plane(origin=tuple(o), z_dir=tuple(z.normalized()))

    if "origin" in spec:
        return plane(spec["origin"], spec.get("zdir", [0, 0, 1]), spec.get("xdir"))

    if spec.get("datum") is not None:
        d = ctx.datums.get(spec["datum"])
        if not d:
            return None  # the datum was removed or has not built; leave the body put
        return plane(d["origin"], d.get("normal") or d.get("dir") or [0, 0, 1], d.get("xdir"))

    shape = _joint_body_shape(ctx, spec.get("body"))
    if shape is None:
        return None
    if spec.get("face") is not None:
        faces = resolve_faces(shape, spec["face"], ctx.diagnostics, fid)
        if not faces:
            return None
        fc = faces[0]
        c, n = fc.center(), _face_normal(fc)
        return plane((c.X, c.Y, c.Z), (n.X, n.Y, n.Z))
    if spec.get("edge") is not None:
        edges = resolve_edges(shape, spec["edge"], ctx.diagnostics, fid)
        if not edges:
            return None
        e = edges[0]
        m, dr = _edge_mid(e), _edge_dir(e)
        return plane((m.X, m.Y, m.Z), (dr.X, dr.Y, dr.Z))

    raise GeomError(
        "joint: a connector needs one of origin, datum, face or edge", BAD_REQUEST)


def _handle_joint(f, ctx):
    """Position one body relative to another by aligning a mate connector on each.

    The MOVING body is rigidly re-placed so its connector meets the fixed
    connector; nothing else about it changes and no other body is touched. The
    two connectors are brought together facing each other (their z axes opposed,
    so two outward face normals meet flush), unless `flush` asks for the axes to
    point the same way. `offset` then slides the moving body along the mate axis
    and `angle` spins it about that axis, which is what a slider and a revolute
    joint drive respectively; `mode` records which of those the joint is so the
    UI knows which handle to offer, the placement math is the same for all three.
    """
    mv = ctx.find_body(f.get("moving"))
    if mv is None or mv.get("shape") is None:
        _skip_feature(ctx.diagnostics, f, "joint",
                      "the body to position is missing or was consumed")
        return

    f_move = _joint_frame(f["mate"], ctx, f.get("id"))
    f_fix = _joint_frame(f["to"], ctx, f.get("id"))
    if f_move is None or f_fix is None:
        _skip_feature(ctx.diagnostics, f, "joint",
                      "a mate reference no longer resolves, the body was left in place")
        return

    # Publish the mate axis (the fixed connector's origin + z) so the frontend can
    # stand its offset/angle handles on the real line the joint slides and turns
    # about, wherever the parts have moved it. Rides the existing datum-mark
    # channel keyed by feature id, so no new wire plumbing: an axis mark on a
    # joint id, which the datum-plane sync ignores (it only reads datum features).
    if ctx.datum_marks is not None:
        o, z = f_fix.origin, f_fix.z_dir
        ctx.datum_marks[f["id"]] = {
            "kind": "axis",
            "origin": [o.X, o.Y, o.Z],
            "dir": [z.X, z.Y, z.Z],
        }

    offset = ctx.val(f.get("offset", 0))
    angle = ctx.val(f.get("angle", 0))
    # The adjustment lives in the FIXED connector's local frame: translate along
    # its z by offset, spin about its z by angle, and (unless flush) turn the
    # moving connector to face it by a half turn about x. Composed onto the fixed
    # frame and stripped of the moving frame, this is the world placement to
    # apply to the moving body.
    adj = Location((0, 0, offset), (0, 0, angle))
    if not f.get("flush"):
        adj = adj * Location((0, 0, 0), (180, 0, 0))
    move_loc = (f_fix.location * adj) * f_move.location.inverse()

    sh = mv["shape"]
    if _wrapped_or_none(sh) is None:
        sh = Compound(list(sh))
    mv["shape"] = move_loc * sh

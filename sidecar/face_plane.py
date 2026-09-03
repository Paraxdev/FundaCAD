"""The plane a picked face implies, re-derived from the B-rep at rebuild time.

A datum plane made from a face used to store the face's plane as three frozen
vectors. That is a note about where a face USED TO BE: change the box's height
and the datum stays behind, along with every sketch placed on it. Storing the
face SELECTOR instead and resolving it each rebuild is what makes it a
construction plane, and this module is the second half of that, turning a
resolved face back into {origin, normal, xdir}.

Everything here is a deliberate mirror of features/planeMath.ts, which answers
the same question in the browser at pick time. The two must agree to the digit:
the frontend's answer is cached on the feature and drawn as the datum's quad,
and this one is what sketches are actually placed on, so a disagreement is a
sketch that jumps the first time anything upstream is touched. Each rule below
names its counterpart. Kept out of builder.py because that file cannot be
imported without a geometry kernel, and these rules are worth testing without
one.
"""

import math

# Matches planeMath.PLANAR_DOT's neighbourhood: a direction shorter than this is
# not a direction.
EPS = 1e-9

# planeMath.planeXDir's threshold. World +Z is the reference for the in-plane x
# axis unless the plane is nearly horizontal, where +Z has almost nothing left
# to project.
Z_REF_LIMIT = 0.9


def _unit(v):
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return None if n < EPS else (v[0] / n, v[1] / n, v[2] / n)


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _scale(v, k):
    return (v[0] * k, v[1] * k, v[2] * k)


def plane_x_dir(normal):
    """The in-plane x axis, chosen the one way planeMath.planeXDir chooses it.

    A normal supplies no x direction, so the choice is arbitrary and its only
    requirement is to be the SAME arbitrary choice every time: derived one way
    at pick time and another at rebuild is a sketch that rotates about its own
    normal, moving every coordinate stored in it.

    Note the discontinuity this inherits. A face whose normal crosses the 0.9
    threshold swaps reference axes and its x direction jumps a quarter turn.
    That is the existing rule rather than something introduced here, and it is
    the same jump the frontend would make on the same face; a datum on a face
    tilting through ~26 degrees from horizontal is where to look if a sketch
    ever appears to spin in place.
    """
    n = _unit(normal)
    if n is None:
        return None
    ref = (0.0, 0.0, 1.0) if abs(n[2]) < Z_REF_LIMIT else (1.0, 0.0, 0.0)
    return _unit(_sub(ref, _scale(n, _dot(ref, n))))


def plane_from_point_normal(point, normal):
    """planeMath.planeFromPointNormal.

    The origin is NOT the point picked: it is the world origin projected onto
    the plane. Grid snapping rounds in plane-local coordinates, so the origin
    decides where the snap lattice falls in world space, and anchoring it on the
    pick would give every sketch-on-face its own lattice offset by wherever the
    cursor happened to be. Two parallel planes share one lattice because of it.
    """
    n = _unit(normal)
    x = plane_x_dir(n) if n else None
    if n is None or x is None:
        return None
    o = _scale(n, _dot(n, point))
    return {"origin": list(o), "normal": list(n), "xdir": list(x)}


def tangent_plane_on_cylinder(axis_point, axis_dir, radius, at, facing=None):
    """planeMath.tangentPlaneOnCylinder.

    A cylinder has no plane of its own, so a datum made from one is the tangent
    plane where it was touched, which is why the pick point is stored alongside
    the face reference rather than being incidental to it.

    The origin sits ON the surface (axis point, then out by the radius) rather
    than at the pick, so the datum is not buried a hair inside the material. The
    x axis is the cylinder's own axis, so a sketch has "along the shaft" as its
    horizontal, which is the only in-plane frame the geometry itself supplies.

    `facing` decides which way the normal points: away from the axis on a shaft,
    toward it on a bore, where the face's own normal points into the void.
    """
    ax = _unit(axis_dir)
    if ax is None:
        return None
    rel = _sub(at, axis_point)
    along = _dot(rel, ax)
    radial = _unit(_sub(rel, _scale(ax, along)))
    if radial is None:
        return None  # the pick is on the axis, where "outward" means nothing
    touch = _add(_add(axis_point, _scale(ax, along)), _scale(radial, radius))
    n = _scale(radial, -1) if facing is not None and _dot(radial, facing) < 0 else radial
    return {"origin": list(touch), "normal": list(n), "xdir": list(ax)}


def agree_with(plane, reference):
    """Flip `plane` to point the same way as `reference`, keeping where it sits.

    A B-rep face's normal direction is a property of the face's orientation in
    its shell, and that can come back reversed across a rebuild without the
    geometry having moved at all: a boolean re-manufactures faces, and the
    surface a cut leaves behind is naturally oriented opposite to the one it cut
    into. Nothing about the plane's POSITION changes when that happens, but the
    datum's normal is the direction its `offset` runs along, so a silent flip
    turns "5mm above this face" into "5mm inside the part".

    The cached plane the frontend stored at pick time is the reference, since it
    is the direction the user saw and accepted. Where the plane sits is taken
    from the freshly resolved face either way, which is the whole point of
    resolving it.

    The x axis is carried across untouched, which is right for both kinds of
    plane and needs the reason spelled out because "recompute it from the new
    normal" looks equally right. A tangent plane's x axis is the cylinder's own
    axis and has nothing to do with the normal. And for a flat face,
    plane_x_dir(n) and plane_x_dir(-n) are the same vector anyway: the reference
    axis is chosen on |n.z|, which negation does not change, and
    ref - n(ref.n) is even in n. So recomputing could only differ by rounding,
    and only ever costs the cylinder its frame.
    """
    if not plane or not reference:
        return plane
    ref_n = _unit(tuple(reference["normal"]))
    n = _unit(tuple(plane["normal"]))
    if ref_n is None or n is None or _dot(n, ref_n) >= 0:
        return plane
    return {
        "origin": list(plane["origin"]),
        "normal": list(_scale(n, -1)),
        "xdir": list(plane["xdir"]),
    }


def with_x_dir(plane, x_hint):
    """Re-seat `plane` on a SAVED x axis, re-orthogonalised against its normal.

    Only a sketch needs this, and it needs it absolutely. A sketch's entities are
    stored as (u, v) in the plane's own basis, so the x axis is not decoration:
    change it and every line in the sketch turns about the normal. plane_x_dir
    picks the axis from |n.z| against a 0.9 threshold, which is stable for a face
    that only SLIDES along its normal but jumps a quarter turn the moment a
    normal drifts across that threshold. Carrying the axis the sketch was drawn
    in costs nothing when it has not moved and is the whole answer when it has.

    A datum plane deliberately does NOT use this: agree_with explains why its
    axis is better left alone (a tangent plane's is the cylinder's own).

    Returns `plane` unchanged when the hint is missing, or is parallel to the
    normal and so leaves nothing in the plane to point along.
    """
    if not plane or not x_hint:
        return plane
    n = _unit(tuple(plane["normal"]))
    if n is None:
        return plane
    x = _unit(_sub(tuple(x_hint), _scale(n, _dot(n, tuple(x_hint)))))
    if x is None:
        return plane
    return {"origin": list(plane["origin"]), "normal": list(n), "xdir": list(x)}

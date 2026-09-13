"""Revolve, including the screw revolve that climbs by a pitch."""

import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py
from build123d import (
    Axis,
    Compound,
    Edge,
    Plane,
    Solid,
    Vector,
    Wire,
    revolve,
)
from geom_select import (
    _edge_curve,
    _edge_dir,
    _edge_mid,
    resolve_edges,
)
from handler_util import _combine, _require_sketch
from plane_spec import AXES
from progress import progress_tick
from shape_util import _as_compound, _wrap_topods
from sketch_build import _region_target


def _handle_revolve(f, ctx):
    entry = _require_sketch(ctx, f.get("sketch"), "revolve")
    # The selected areas, the same way extrude reads them (_region_cells says how
    # they are cut). Absent means the whole sketch, which is what every revolve
    # saved before the tool started recording its selection means, and what it
    # did with a selection, which is the bug.
    sk = _region_target(f.get("regions"), entry, ctx)
    if sk is None:
        sk = entry["sketch"]
    if sk is None:
        raise ValueError("sketch has no closed profile to revolve")
    angle = ctx.val(f.get("angle", 360))
    # A zero-degree revolve swept nothing yet still produced a body, so the
    # timeline showed a healthy feature that had done nothing at all.
    if angle == 0:
        raise ValueError("Revolve: angle must not be 0, nothing would be swept")
    pitch = ctx.val(f.get("pitch", 0) or 0)
    axis = _revolve_axis(f, ctx)
    if pitch:
        _combine(f, ctx, _screw_revolve(sk, axis, angle, pitch))
        return
    # Past a full turn a flat revolve only re-sweeps ground it has already
    # covered. OCCT wraps such an arc back onto the same solid by itself
    # (measured: 360, 720 and 1080 all give the identical shape), so clamping
    # here changes no result, it states the intent where the value is read,
    # instead of leaving a document that says 1080 and a body that means 360.
    # Winding on is only meaningful once there is a pitch to separate one turn
    # from the next, and the branch above owns that case.
    if angle > 360:
        angle = 360
    elif angle < -360:
        angle = -360
    try:
        solid = revolve(sk, axis=axis, revolution_arc=angle)
    except Exception as ex:
        # OCCT reports a profile that straddles the axis as a bare
        # `StdFail_NotDone` ("BRep_API: command not done"), which tells the user
        # nothing. Name the overwhelmingly likely cause instead; a profile may
        # TOUCH the axis, but it may not cross it.
        raise ValueError(
            "Revolve failed, the profile probably crosses the axis of "
            f"revolution ({f.get('axis', 'Z')}). Move it fully to one side "
            f"(it may touch the axis, but not cross it). [{type(ex).__name__}]"
        )
    _combine(f, ctx, solid)


def _turn_clearance(tall):
    """How much room one turn of a screw revolve must leave the next.

    Absolute at small sizes so a 0.2 mm thread is not scaled away, proportional
    above 10 mm so a coarse thread gets a clearance in the same ratio."""
    return max(1e-3, 1e-4 * tall)


def _axial_scale(shape, factor, direction, hold):
    """Scale `shape` by `factor` along `direction` only, holding the plane whose
    axial coordinate (measured along `direction` from the world origin) is
    `hold`. Every dimension across the axis is left exactly as drawn.

    A true non-uniform scale, so a profile keeps its vertex count: no offset, no
    slivers, nothing for the sweep to choke on."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
    from OCP.gp import gp_GTrsf, gp_Mat, gp_XYZ

    d = Vector(*direction).normalized()
    k = factor - 1.0
    # I + k * d d^T, the identity across the axis, `factor` along it.
    m = gp_Mat(*[1.0 * (i == j) + k * d.to_tuple()[i] * d.to_tuple()[j]
                 for i in range(3) for j in range(3)])
    g = gp_GTrsf()
    g.SetVectorialPart(m)
    g.SetTranslationPart(gp_XYZ(*tuple(d * (-k * hold))))
    return _wrap_topods(BRepBuilderAPI_GTransform(shape.wrapped, g, True).Shape())


def _screw_revolve(profile, axis, angle, pitch):
    """A revolve that climbs the axis while it turns: one turn rises `pitch`.

    This is the whole of thread cutting. Draw the thread's cross section in a
    plane through the axis, give it the thread's pitch, wind the angle past 360
    for as many turns as the thread is long, and Join it to the shank or Cut it
    out of the bore. Nothing else about the feature changes, which is the point:
    a thread is a revolve that does not close on itself.

    Built as a pipe sweep along a helix, with the binormal PINNED to the axis
    direction. That pin is what makes it a revolve rather than a pipe: with a
    fixed binormal, OCCT builds each section's frame from the tangent and that
    direction, so the section's plane always contains the axis. It stays a
    meridian section all the way round, exactly as a revolve's does, instead of
    tipping to stay square to the helix (which is what Frenet framing does, and
    which would thin the profile by the cosine of the helix angle).

    The motion from the profile's own position to any point of the sweep is then
    a pure screw: rotate about the axis, rise along it. So the spine's RADIUS is
    free and cancels out (verified: a spine at r=0.3 and one at the profile's own
    radius give the same volume and the same bounding box to 1e-6). Its start
    DIRECTION does not cancel: the profile is carried from wherever the spine
    starts, so a spine that starts a quarter turn away lifts the whole result by
    a quarter of the pitch. The spine is therefore built on the meridian the
    profile is already on, which leaves the first section exactly where it was
    drawn.

    The volume is a Pappus identity and is what the tests measure: the axial
    travel shears the section within its own plane, which adds nothing, so a
    section of area A whose centroid sits at radius r sweeps A * r * angle
    (radians) no matter what the pitch is.
    """
    from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell
    from OCP.gp import gp_Dir

    D = Vector(*axis.direction).normalized()
    O = Vector(*axis.position)

    faces = list(profile.faces()) if hasattr(profile, "faces") else [profile]
    if not faces:
        raise ValueError("Revolve: no closed profile to sweep")

    # Consecutive turns run into each other when the section is taller along the
    # axis than one turn's climb. OCCT builds that happily and hands back a
    # self-intersecting solid that measures as if nothing were wrong, so the
    # first sign of it would be a boolean failing much later, somewhere else.
    # One turn has no neighbour to hit, hence the angle test.
    if abs(angle) > 360:
        local = Plane(origin=tuple(O), z_dir=tuple(D)).to_local_coords(
            Compound(faces) if len(faces) > 1 else faces[0])
        bb = local.bounding_box()
        tall = bb.max.Z - bb.min.Z
        clear = _turn_clearance(tall)
        if tall > abs(pitch) + clear:
            raise ValueError(
                f"Revolve: the profile is {tall:.4g} mm tall along the axis but "
                f"climbs only {abs(pitch):.4g} mm each turn, so every turn would "
                "run into the one before. Raise the pitch, or draw a shorter "
                "profile, or stay within one turn."
            )
        # A profile as tall as the climb is the thread everyone actually draws:
        # crest lands on root, no flat between the turns. It is also the one
        # shape a B-rep kernel cannot use. A V section meeting the next V section
        # touches along a LINE, so the solid is non-manifold, BRepCheck calls it
        # valid and every boolean against it then quietly does nothing (measured:
        # cutting a block that should lose 610.4 mm3 lost 0.410).
        #
        # Welding the turns is the intuitive repair and it does not work: the
        # overlap between two crests is a lens whose width vanishes with its
        # height, so no amount of it gives OCCT a real intersection to find
        # (per-turn sweeps fused at 1e-3..5e-2 of overlap all came back with
        # NEGATIVE volume). Clearance does work, and by a lot: stop the crest a
        # hair short of the next root and the sweep stays one clean five-faced
        # solid that cuts to within 0.06% of the hand-computed answer.
        #
        # 1e-3 mm is ten times the measured floor (below 1e-4 mm the booleans go
        # back to doing nothing) and a thousandth of a printed layer, so the
        # thread it makes is the thread that was drawn.
        if tall > abs(pitch) - clear:
            faces = [_axial_scale(f, (abs(pitch) - clear) / tall,
                                  D, O.dot(D) + (bb.min.Z + bb.max.Z) / 2)
                     for f in faces]

    turns = angle / 360.0
    rise = turns * pitch

    out = None
    for face in faces:
        progress_tick()
        rel = face.center() - O
        axial = rel.dot(D)
        radial = rel - D * axial
        r = radial.length
        if r < 1e-6:
            raise ValueError(
                "Revolve: a climbing revolve needs a profile that sits off to "
                "one side of the axis. This one is centred on it, so there is "
                "no direction for it to start from."
            )
        # `lefthand` and the flipped normal between them cover all four sign
        # pairs: the sweep turns the way the angle says, and rises the way the
        # pitch says, independently. Both are checked in the orientation tests.
        helix = Edge.make_helix(
            pitch=abs(pitch), height=abs(rise), radius=r,
            center=(0, 0, 0), normal=(0, 0, 1), lefthand=(pitch < 0))
        frame = Plane(origin=tuple(O + D * axial), x_dir=tuple(radial.normalized()),
                      z_dir=tuple(D if rise >= 0 else -D))
        path = frame * helix
        spine = path if isinstance(path, Wire) else Wire(path.edges())

        def swept(wire, _spine=spine):
            mps = BRepOffsetAPI_MakePipeShell(_spine.wrapped)
            mps.SetMode(gp_Dir(*tuple(D)))
            mps.Add(wire.wrapped, False, False)
            mps.Build()
            if not mps.IsDone():
                raise ValueError(
                    "Revolve: the climbing sweep failed. A profile that is very "
                    "close to the axis, or a pitch far larger than the profile, "
                    "can make a surface that crosses itself."
                )
            mps.MakeSolid()
            return Solid(mps.Shape())

        solid = swept(face.outer_wire())
        for hole in face.inner_wires():
            solid = solid - swept(hole)
        out = solid if out is None else out + solid
    return _as_compound(out)


def _revolve_axis(f, ctx):
    """The axis to spin about: one of the three world axes, an arbitrary line, or
    the line of the EDGE the revolve was aimed at, re-resolved against the bodies
    as they stand now.

    Re-resolving is what makes a picked edge a reference rather than a note about
    where an edge used to be. Resolution is GLOBAL across bodies for the reason
    recorded on _face_anchor_plane: a body id can come to name a different piece,
    and a body-scoped match would silently re-aim the
    revolve at some distant edge on the wrong piece.

    An edge that stops resolving is not an error. The axis falls back to the
    cached line, where the user last saw it, because the alternative is a
    failed feature and a body that disappears with it. So is an edge that is no
    longer straight: an axis is a line, and a curve cannot be one.
    """
    axis = f.get("axis", "Z")
    sel = f.get("axisEdge")
    if sel:
        found = None
        for b in getattr(ctx, "bodies", None) or []:
            shape = b.get("shape")
            if shape is None:
                continue
            try:
                edges = resolve_edges(shape, sel, getattr(ctx, "diagnostics", None), f.get("id"))
            except Exception:
                continue
            for e in edges or []:
                if e is not None and _edge_curve(e) == "line":
                    found = e
                    break
            if found is not None:
                break
        if found is not None:
            a, d = _edge_mid(found), _edge_dir(found)
            return Axis((a.X, a.Y, a.Z), (d.X, d.Y, d.Z))
    if isinstance(axis, dict):
        o, d = axis.get("origin") or [0, 0, 0], axis.get("dir") or [0, 0, 1]
        try:
            return Axis(tuple(float(v) for v in o), tuple(float(v) for v in d))
        except Exception:
            return AXES["Z"]
    return AXES.get(axis, AXES["Z"])

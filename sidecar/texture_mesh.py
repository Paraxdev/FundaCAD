"""Getting a mesh fine enough, and aligned enough, to carry a texture.

Split out of texture.py. Displacing a face means pushing its triangulation
along the normal, and OCCT's triangulation is nothing like fine enough for a
sub-millimetre pattern — so this half refines it, and does so in the pattern's
own frame.

That alignment is the whole point. A triangle whose edge does not lie ON a
crease of the height field gets a crease running diagonally across its face,
which prints as a rounded smear instead of a sharp line. So the refinement lays
its grid along the pattern's axes (_pattern_axes), splits every triangle that a
crease crosses (_flip_to_creases, _segment_crossings), and forces cell diagonals
to agree with the direction the pattern runs.

The mapping from (u, v) parameters to real millimetres lives here too, because a
period on a cylinder is an arc length, not a parameter span, and getting that
wrong scales the whole texture.
"""

import math

import numpy as np

from texture_height import _HEX_CORNERS, _hex_wall_width, _is_facet, _wave_phases

def _revolved_reference_radius(surf):
    """The radius the pattern is sized at, taken from the FACE's own parameter
    bounds so it cannot drift between calls (the two callers pass different point
    sets, and a reference derived from those would give two different charts)."""
    from OCP.GeomAbs import GeomAbs_Cone

    if surf.GetType() == GeomAbs_Cone:
        cone = surf.Cone()
        v_mid = 0.5 * (surf.FirstVParameter() + surf.LastVParameter())
        return max(abs(cone.RefRadius() + v_mid * math.sin(cone.SemiAngle())), 1e-9)
    return max(surf.Cylinder().Radius(), 1e-9)


def _turn_mm(surf, period):
    """Arc length assigned to ONE FULL TURN of a cylinder or cone.

    Two fixes in one number, because they are the same change.

    ANCHORED to a fixed reference radius, not the local `r(v)`. The old chart
    used `u_mm = u * r(v)`, so a crest at constant u_mm sat at angle u_mm/r(v) —
    and r varies with height on a cone, so the crest SPIRALLED. The shear grew
    with distance from u=0: measured on a 30->20mm frustum, +1.9 degrees at the
    first crest and +57.3 by the thirtieth. Zero at the seam, worst at the far
    side, which is exactly the "starts nice, distorts as you go round" report.
    Anchoring makes a crest a true generator: dead vertical, everywhere.

    ROUNDED to a whole number of periods, so the pattern meets itself at the UV
    seam instead of colliding with a different phase. That also makes the seam
    weldable (see _weld_coincident): the columns at u=0 and u=2pi then carry
    IDENTICAL field values, so merging them cannot move the surface.

    The cost, which is geometry and not a bug: on a taper the cell width scales
    with radius. You cannot hold both constant width in mm and constant
    orientation on a cone — its circumference changes. Cells are `period` wide at
    the reference radius and vary from there. On a cylinder there is no cost at
    all: constant size, generator-aligned and seamless together."""
    circ = 2.0 * math.pi * _revolved_reference_radius(surf)
    if not period or period <= 0.0:
        return circ
    return max(1, int(round(circ / period))) * period


def _face_uv_to_mm(surf, u, v, period=None):
    """Convert native (u,v) surface parameters to a locally mm-consistent
    coordinate pair, so a periodic pattern (period = `scale` mm) looks the same
    size whether it's on a flat face or wrapped around a cylinder. Exact closed
    form for plane/cylinder/cone (verified against BRepAdaptor_Surface.D1 — see
    the module docstring's design notes); every other surface type (sphere,
    torus, bspline/freeform) gets a single-Jacobian-sample approximation at the
    face's UV centroid — a documented stretch/compression approximation on
    strongly curved freeform faces, not a printability defect (accepted v1
    limitation, see the plan's risk table)."""
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane
    from OCP.gp import gp_Pnt, gp_Vec

    t = surf.GetType()
    if t == GeomAbs_Plane:
        return u.copy(), v.copy()  # gp_Pln U,V params ARE mm distances
    if t in (GeomAbs_Cylinder, GeomAbs_Cone):
        # U is an angle; one full turn is _turn_mm of arc. V is already axial mm
        # on a cylinder and slant-arc-length mm on a cone.
        return u * (_turn_mm(surf, period) / (2.0 * math.pi)), v.copy()

    u0 = float(np.mean(u))
    v0 = float(np.mean(v))
    p, d1u, d1v = gp_Pnt(), gp_Vec(), gp_Vec()
    surf.D1(u0, v0, p, d1u, d1v)
    su = max(d1u.Magnitude(), 1e-9)
    sv = max(d1v.Magnitude(), 1e-9)
    return (u - u0) * su, (v - v0) * sv


# --- mesh refinement + displacement ------------------------------------------


def _points_in_polygon(pts, ring_a, ring_b, chunk=4096):
    """Even-odd ray-cast of 2D points against a polygon given as edge segment
    arrays (E,2)+(E,2) — handles multiple rings/holes for free since even-odd
    doesn't care about ring grouping. Chunked over points to bound the (C,E)
    broadcast."""
    inside = np.zeros(len(pts), dtype=bool)
    ay, by = ring_a[:, 1][None, :], ring_b[:, 1][None, :]
    ax, bx = ring_a[:, 0][None, :], ring_b[:, 0][None, :]
    dy = np.where(np.abs(by - ay) < 1e-30, 1e-30, by - ay)
    for s in range(0, len(pts), chunk):
        P = pts[s:s + chunk]
        py = P[:, 1][:, None]
        straddles = (ay <= py) != (by <= py)
        t = (py - ay) / dy
        xint = ax + t * (bx - ax)
        hits = straddles & (xint > P[:, 0][:, None])
        inside[s:s + chunk] = (hits.sum(axis=1) % 2).astype(bool)
    return inside


def _cell_lattice_points(kind, spec, scale, lo_u, hi_u, lo_v, hi_v, wrap_u=None):
    """Explicit vertex set for the CELLULAR kinds, whose creases do not lie on
    families of parallel lines and so cannot be expressed as a line grid.

    Returned in mm-chart coordinates (the offset shift already applied by the
    caller's bbox), because hex and voronoi ignore `angle` — their lattice has
    its own orientation and `height_field` never rotates their input."""
    if kind != "hex":
        return None
    a = scale
    root3 = math.sqrt(3.0)
    w = _hex_wall_width(a, spec.get("sharpness", 0.5))
    r_out = a / root3                      # circumradius of the cell
    r_in = max(a * 0.5 - w, 1e-6) * 2.0 / root3   # circumradius of the flat top
    # sites covering the bbox with a ring of margin, in lattice coordinates
    pad = a
    j0 = int(math.floor((lo_v - pad) / (a * root3 * 0.5)))
    j1 = int(math.ceil((hi_v + pad) / (a * root3 * 0.5)))
    rows = []
    for j in range(j0, j1 + 1):
        sy = j * a * root3 * 0.5
        i0 = int(math.floor((lo_u - pad) / a - j * 0.5))
        i1 = int(math.ceil((hi_u + pad) / a - j * 0.5))
        if i1 < i0:
            continue
        i = np.arange(i0, i1 + 1, dtype=np.float64)
        rows.append(np.column_stack([i * a + j * a * 0.5, np.full(len(i), sy)]))
    if not rows:
        return None
    sites = np.concatenate(rows)
    # cell corners (h = 0, the groove) and flat-top corners (h = 1); the wall
    # between a matching pair is one planar facet, and the spoke joining them is
    # the crease where two walls meet
    outer = sites[:, None, :] + r_out * _HEX_CORNERS[None, :, :]
    inner = sites[:, None, :] + r_in * _HEX_CORNERS[None, :, :]
    outer_next = np.roll(outer, -1, axis=1)
    # POINTS ALONG EVERY CELL EDGE. The groove along a shared edge is the
    # sharpest crease in the pattern (h drops to 0 and rises again), and with
    # only its two endpoints present Delaunay joins one cell's flat top straight
    # to its neighbour's, bridging the groove and interpolating h=1 where the
    # truth is 0 — measured 0.36mm on a 0.4mm texture.
    #
    # A midpoint alone is not enough. The bridge forms near the CORNERS, where
    # three cells meet and two neighbouring flat-top corners sit only ~2w apart
    # while the groove between them is a thin wedge; Delaunay takes the short
    # edge. So also plant a groove vertex a wall-width in from each end, which
    # puts a competing point at the same scale as the bridge it has to beat.
    edge_len = r_out                       # a regular hexagon's edge == its circumradius
    frac = min(0.4, max(0.5 * w / max(edge_len, 1e-9), 0.015))
    step = outer_next - outer
    along = [outer + step * f for f in (frac, 0.5, 1.0 - frac)]
    pts = np.concatenate([outer.reshape(-1, 2), inner.reshape(-1, 2)]
                         + [p.reshape(-1, 2) for p in along])
    if wrap_u:
        # PERIODIC IN U — a closed cylinder or cone. The two sides of the UV seam
        # must carry an IDENTICAL vertex set, or they cannot weld and the seam
        # stays a mesh boundary that the taper pins flat. Clipping a padded box
        # does not give that: a cell corner just outside u=0 is culled while its
        # twin just inside u=turn survives (measured 56 vertices on one side of a
        # cone's seam against 64 on the other). Folding into [0, turn) and then
        # re-emitting both copies makes the set symmetric by construction.
        folded = pts.copy()
        folded[:, 0] = np.mod(folded[:, 0], wrap_u)
        folded = np.unique(np.round(folded, 9), axis=0)
        # BOTH neighbouring copies, then clip: emitting only [0, turn) and
        # [turn, 2*turn) leaves the padding below u=0 empty while the padding
        # above turn is populated, which is the same asymmetry by another route.
        pts = np.concatenate([folded - np.array([wrap_u, 0.0]), folded,
                              folded + np.array([wrap_u, 0.0])])
        pts = pts[(pts[:, 0] >= lo_u) & (pts[:, 0] <= hi_u)]
    return np.unique(np.round(pts, 9), axis=0)


def _crease_phases(land):
    """Gradient breakpoints of _trapezoid inside one period, as fractions of it.

    `tri = 1-|2t-1|` is clipped at BOTH ends. The lower clip flattens the trough,
    so the ramp only starts at t = k/4 and ends at t = 1-k/4; the upper clip
    flattens the crest into a real LAND spanning t = 0.5 -/+ k/4. That is FOUR
    corners per period, not two. Sampling that misses the upper pair rounds the
    crest off, which is most of why a "faceted" texture still read as soft — a
    uniform 4-samples-per-wavelength grid can only ever hit two of the four.

    Degenerates to the pure V (trough, crest) when there is no land."""
    k = max(0.0, min(0.98, float(land)))
    if k <= 1e-9:
        return (0.0, 0.5)
    return (k / 4.0, 0.5 - k / 4.0, 0.5 + k / 4.0, 1.0 - k / 4.0)


def _pattern_axes(kind, spec):
    """Sample-line phases per pattern axis: (pu_phases, pv_phases), or None when
    the kind has no lattice and must keep the uniformly sampled grid.

    An axis mapped to None carries no crease — the field does not vary along it,
    so any spacing there is exact and the caller picks one for mesh quality
    alone.

    Pattern-frame convention, verified against the height fields themselves:
    ribs/waves vary along pu (`u1` in _rotate terms), and knurl is a min() of two
    trapezoids along pv and pu, because `_rotate(u, v, angle+90)` maps its second
    groove direction (`v2`) back onto pu.

    Excluded on purpose: `round` profiles are smooth by design; hex and voronoi
    are curved fields today (a clipped cosine sum and a conical distance field),
    so no set of lines can make them exact; noise and image are not periodic."""
    if not _is_facet(spec):
        return None
    land = float(spec.get("sharpness", 0.5))
    if kind == "ribs":
        return (_crease_phases(land), None)
    if kind == "waves":
        # a faceted sine turns a corner at every join, not at four breakpoints —
        # so it needs its own, denser phase set. Sharing ribs' would chord across
        # the curve and lose the roundness it exists for. Land-independent.
        return (_wave_phases(), None)
    if kind == "knurl":
        # both grooves, so both axes carry the same breakpoints. The min() of the
        # two ALSO creases along a line inside each ramp-by-ramp cell; that one
        # is not a lattice line and is handled by choosing the cell's diagonal.
        return (_crease_phases(land), _crease_phases(land))
    if kind == "hex":
        # CELLULAR: creases run round hexagons and out along spokes, not along
        # parallel lines, so there are no axis phases — the vertex set comes
        # from _cell_lattice_points instead.
        return "cells"
    return None


def _axis_lines(phases, period, lo, hi):
    """Sample lines covering [lo, hi] along one pattern axis.

    With phases, one line per crease per period, so every facet corner is a mesh
    vertex and the linear interpolation between them IS the true surface. Without
    them (a crease-free axis), one line per period: the spacing is free
    geometrically, but not for the rim, where the taper ramps to zero and a
    triangle spanning the whole face would interpolate that ramp across it."""
    if phases is None:
        phases = (0.0,)
    n0 = int(math.floor(lo / period)) - 1
    n1 = int(math.ceil(hi / period)) + 1
    vals = np.array([(n + t) * period for n in range(n0, n1 + 1) for t in phases])
    vals = np.unique(np.round(vals, 9))
    return vals[(vals >= lo) & (vals <= hi)]


def _segment_crossings(a, b, phases, period):
    """Parameters t in (0,1) at which the pattern's crease lines cross a segment
    whose pattern coordinate runs affinely from `a` to `b`.

    Used to plant a ring vertex on every crease that reaches the face boundary,
    so the rim band is triangulated with the creases as edges instead of across
    them."""
    if phases is None or period <= 0.0:
        return []
    span = b - a
    if abs(span) < 1e-12:
        return []
    lo, hi = (a, b) if a < b else (b, a)
    out = []
    for n in range(int(math.floor(lo / period)) - 1, int(math.ceil(hi / period)) + 2):
        for ph in phases:
            c = (n + ph) * period
            if lo < c < hi:
                out.append((c - a) / span)
    return out


# Points strictly inside a triangle, in barycentric coordinates — the probe set
# used to decide whether a triangle reproduces the height field. Corner-ish and
# edge-ish samples as well as the centroid, because the failure being looked for
# is a facet cut off between the vertices, which the centroid can straddle.
_FLIP_BARY = np.array([
    [1 / 3, 1 / 3, 1 / 3],
    [0.60, 0.20, 0.20], [0.20, 0.60, 0.20], [0.20, 0.20, 0.60],
    [0.45, 0.45, 0.10], [0.10, 0.45, 0.45], [0.45, 0.10, 0.45],
])


def _force_cell_diagonals(tris, V_mm, quads, want_main):
    """Impose the KNOWN diagonal on each complete lattice cell.

    A square cell with no point inside it is triangulated by Delaunay with one of
    its two diagonals, chosen arbitrarily because the four corners are
    co-circular. Which one is right is not arbitrary: knurl is min() of two
    crossed trapezoids, and where both are on their ramps the min switches along
    exactly one of them. So flip the wrong ones deterministically instead of
    hoping an error-descent pass finds them — from a Delaunay start descent
    stalls in a local minimum (measured: 620 inexact triangles down to 40, and
    the rest unreachable by any single flip)."""
    tris = np.asarray(tris, dtype=np.int64).copy()
    where = {}
    for ti, (a, b, c) in enumerate(tris):
        for i, j in ((a, b), (b, c), (c, a)):
            where.setdefault((i, j) if i < j else (j, i), []).append(ti)
    for (a, b, c, d), main in zip(quads, want_main):
        have, want = ((b, d), (a, c)) if main else ((a, c), (b, d))
        if len(where.get((min(want), max(want)), ())) == 2:
            continue  # the diagonal we want is already there
        share = where.get((min(have), max(have)), ())
        if len(share) != 2:
            continue  # cell is not a clean two-triangle quad; leave it alone
        t0, t1 = share
        if sorted(set(tris[t0]) | set(tris[t1])) != sorted((a, b, c, d)):
            continue  # something else meets here
        tris[t0] = (want[0], want[1], have[0])
        tris[t1] = (want[0], want[1], have[1])
    return tris


def _segments_cross(P, p, q, r, s):
    """True when segment p-q properly crosses segment r-s, i.e. the quad p-r-q-s
    is convex and swapping its diagonal is a legal flip."""
    def side(a, b, c):
        return ((P[b][0] - P[a][0]) * (P[c][1] - P[a][1])
                - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]))
    return (side(p, q, r) * side(p, q, s) < 0) and (side(r, s, p) * side(r, s, q) < 0)


def _flip_to_creases(tris, V_mm, field, n_ring=0, tol=1e-9, max_passes=8,
                     ring_fixable=None):
    """Repair triangles that cut ACROSS a crease instead of running along it.

    Complete lattice cells get their diagonal imposed directly, but the band
    stitching the lattice to the boundary ring is an unconstrained Delaunay: it
    maximises the minimum angle and knows nothing about the field, so where a
    crease crosses the band it can bridge straight over. scipy has no constrained
    Delaunay, so repair instead of prevent — score each triangle against the true
    field and flip a shared edge wherever that strictly reduces the error.

    Triangles touching a RING vertex are excluded from scoring. Their outer
    corners are pinned at zero displacement by the boundary taper, so they can
    never match the raw field however they are triangulated; scoring them makes
    the pass chase an unreachable target and, worse, spend its one-flip-per-pair
    budget on pairs that cannot improve, blocking neighbours that could.

    `ring_fixable` (bool mask over the first n_ring vertices) marks ring
    vertices that DO displace with the field — the UV-seam columns, which the
    taper exempts. Triangles touching only those are scored and repaired like
    interior ones: the seam strip is where a spoke crease crosses the band with
    both flanks on the ring, and skipping it leaves the crease bridged (a
    0.195-of-depth notch on every hex row along the seam)."""
    tris = np.asarray(tris, dtype=np.int64).copy()
    hv = field(V_mm)
    fixable_full = None
    if ring_fixable is not None and n_ring:
        fixable_full = np.zeros(len(V_mm), dtype=bool)
        fixable_full[:n_ring] = ring_fixable

    def err_of(t):
        """Worst deviation at points strictly INSIDE each triangle. The centroid
        alone is not enough to score a flip by: a triangle bridging a crease can
        match exactly at its centre and be wrong either side of it, so a
        centroid-scored pass both misses real breaks and flips already-correct
        triangles into worse ones (measured: it broke ribs at 17 degrees, which
        the lattice had got right)."""
        pts = np.einsum("sb,tbc->tsc", _FLIP_BARY, V_mm[t]).reshape(-1, 2)
        interp = hv[t] @ _FLIP_BARY.T
        return np.abs(interp - field(pts).reshape(len(t), -1)).max(axis=1)

    for _ in range(max_passes):
        scored = err_of(tris)
        excluded = tris < n_ring  # pinned by the taper, not fixable
        if fixable_full is not None:
            excluded &= ~fixable_full[tris]
        scored[excluded.any(axis=1)] = 0.0
        bad = np.nonzero(scored > tol)[0]
        if not len(bad):
            break
        edges = {}
        for ti, (a, b, c) in enumerate(tris):
            for i, j in ((a, b), (b, c), (c, a)):
                edges.setdefault((i, j) if i < j else (j, i), []).append(ti)
        settled = set()
        flipped = False
        for ti in bad:
            if ti in settled:
                continue
            a, b, c = tris[ti]
            for i, j, opp in ((a, b, c), (b, c, a), (c, a, b)):
                share = edges.get((i, j) if i < j else (j, i), ())
                if len(share) != 2:
                    continue  # a boundary edge has nothing to flip against
                tj = share[0] if share[1] == ti else share[1]
                if tj in settled:
                    continue
                rest = [v for v in tris[tj] if v not in (i, j)]
                if len(rest) != 1 or not _segments_cross(V_mm, i, j, opp, rest[0]):
                    continue
                cand = np.array([[opp, rest[0], i], [rest[0], opp, j]], dtype=np.int64)
                if err_of(cand).sum() < err_of(tris[[ti, tj]]).sum() - 1e-15:
                    tris[ti], tris[tj] = cand[0], cand[1]
                    settled.add(ti)
                    settled.add(tj)
                    flipped = True
                    break
        if not flipped:
            break
    return tris


def _aligned_grid_triangulation(base_pts, base_uv, base_tris, u_mm, v_mm,
                                angle_deg, target_edge_mm, max_tris,
                                pattern_period=0.0, phases=None, offset=0.0, field=None,
                                unchart=None, cell_points=None, wrap_u=None):
    """PLANAR faces: retessellate with a regular sample grid ROTATED to the
    pattern angle, instead of subdividing the axis-aligned base triangulation.
    A diagonal pattern sampled on an axis-aligned grid beats against it — the
    crest apex lands sometimes on a vertex, sometimes between two, so ridges
    come out visibly "roped" at practical densities. With the grid aligned to
    the pattern, crests run exactly along grid rows and are straight at the
    SAME triangle budget. Boundary ring vertices are kept verbatim (the
    crack-free zero-taper invariant needs them bit-identical); the interior
    grid + ring are Delaunay-triangulated in mm space and triangles whose
    centroid falls outside the face polygon are dropped (handles holes and
    concavity without a constrained triangulation). Raises on anything
    unexpected — the caller falls back to _refine_face_triangulation."""
    from scipy.spatial import Delaunay, cKDTree

    edge_count = _boundary_edges([tuple(t) for t in base_tris])
    boundary = [k for k, n in edge_count.items() if n == 1]
    if len(boundary) < 3:
        raise ValueError("degenerate boundary")
    P_mm = np.stack([np.asarray(u_mm), np.asarray(v_mm)], axis=1)
    ring_a = P_mm[[e[0] for e in boundary]]
    ring_b = P_mm[[e[1] for e in boundary]]

    # budget-aware spacing: the target sample step, widened if the face's area
    # can't afford it (the wavelength clamp downstream then keeps it clean)
    tri_idx = np.asarray(base_tris, dtype=np.int64)
    e1 = P_mm[tri_idx[:, 1]] - P_mm[tri_idx[:, 0]]
    e2 = P_mm[tri_idx[:, 2]] - P_mm[tri_idx[:, 0]]
    area = float(np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]).sum() * 0.5)
    spacing = max(target_edge_mm, math.sqrt(2.2 * area / max(max_tris, 100)))

    # Lock the spacing to a whole number of samples per pattern PERIOD. Without
    # this the grid and the pattern beat against each other: a ridge lands at a
    # drifting phase between two samples and gets sliced off flat at whatever
    # height the samples happen to bracket, so crests come out uneven and
    # rounded. Snapping puts every crest and trough exactly ON a grid line.
    # Only when we can already afford >=2 samples per period — below that,
    # snapping would multiply the triangle count, and displace_face's wavelength
    # clamp already handles under-sampling by showing a coarser pattern.
    period = float(pattern_period or 0.0)
    if period > 0.0 and spacing <= period * 0.5:
        spacing = period / max(2, round(period / spacing))

    # Pattern chart convention MUST match _rotate() in the height fields:
    # u1 = u·cosθ − v·sinθ (crest lines of waves/ribs run along constant u1), so
    # pattern coords are ((u+offset)·c − v·s, (u+offset)·s + v·c).
    #
    # `offset` rides in the chart rather than being added afterwards, because it
    # is what phase-locks the lines to the pattern: displace_face evaluates the
    # field at u_mm + offset, so lines placed without it sit at a drifting phase
    # and slice the crests off exactly like an unaligned grid does.
    ang = math.radians(angle_deg)
    ca, sa = math.cos(ang), math.sin(ang)
    rp_u = (P_mm[:, 0] + offset) * ca - P_mm[:, 1] * sa
    rp_v = (P_mm[:, 0] + offset) * sa + P_mm[:, 1] * ca

    # DENSIFY THE BOUNDARY RING to the sample spacing. Kept verbatim from the base
    # triangulation it is a handful of nodes — measured on a filleted body, 20 ring
    # vertices with the longest edge 18mm against a 2mm pattern period. The mesh
    # then has NO vertices along that edge to carry the pattern, so the strip
    # between the rim and the first interior row comes out flat however fine the
    # interior is: the visible "band" around a textured face.
    #
    # With a lattice the ring also gets a vertex wherever a crease line CROSSES the
    # boundary, since the band is stitched by a Delaunay pass that has no reason to
    # respect a crease it has no vertex on.
    #
    # Crack-free either way: every new point is a linear interpolation along the
    # EXISTING boundary polyline, so it lies exactly on the segment the neighbouring
    # face spans (and this chart is affine — fit_err enforces it — so lerping uv/xyz
    # is exact). They stay boundary vertices, so the taper leaves them undisplaced.
    base_uv0 = np.asarray(base_uv, dtype=np.float64)
    base_xyz0 = np.asarray(base_pts, dtype=np.float64)
    bnd_ids = np.unique(np.asarray(boundary, dtype=np.int64).ravel())
    # originals first and verbatim (bit-identical, which the invariant needs)
    r_mm = [P_mm[bnd_ids]]
    r_uv = [base_uv0[bnd_ids]]
    r_xyz = [base_xyz0[bnd_ids]]
    cells_mode = cell_points is not None and len(cell_points) >= 4
    lattice = (phases is not None or cells_mode) and period > 0.0
    # On a closed face the seam columns are boundary only as an artifact of the
    # chart cut. Densifying them UNIFORMLY plants ring points at non-crease
    # heights, and the near-ring cull below then eats the lattice's own on-seam
    # corners — and a lost corner is a crushed cell no edge flip can rebuild
    # (the staggered half-broken seam cells the viewport showed on a hex
    # cylinder: whether a cell survived depended on the accidental alignment of
    # uniform ring steps with lattice heights). Densify seam segments with the
    # lattice's own on-seam points instead: those ARE the crease geometry, and
    # periodicity hands both columns an identical v-set so the two sides stay
    # coincident under displacement.
    seam_vs = None
    if cells_mode and wrap_u:
        cp = np.asarray(cell_points, dtype=np.float64)
        on_cut = (np.abs(cp[:, 0]) < 1e-9) | (np.abs(cp[:, 0] - wrap_u) < 1e-9)
        if on_cut.any():
            seam_vs = np.unique(cp[on_cut][:, 1])
    for i0, i1 in boundary:
        u0p, u1p = P_mm[i0, 0], P_mm[i1, 0]
        seam_seg = (seam_vs is not None
                    and ((abs(u0p) < 1e-6 and abs(u1p) < 1e-6)
                         or (abs(u0p - wrap_u) < 1e-6 and abs(u1p - wrap_u) < 1e-6)))
        if seam_seg:
            va, vb = P_mm[i0, 1], P_mm[i1, 1]
            lo_s, hi_s = (va, vb) if va <= vb else (vb, va)
            vs = seam_vs[(seam_vs > lo_s + 1e-9) & (seam_vs < hi_s - 1e-9)]
            ts = list((vs - va) / (vb - va))
        else:
            seg_len = float(np.hypot(*(P_mm[i1] - P_mm[i0])))
            n_sub = int(math.ceil(seg_len / spacing))
            ts = list(np.arange(1, n_sub, dtype=np.float64) / n_sub) if n_sub >= 2 else []
            if lattice and phases is not None:
                ts += _segment_crossings(rp_u[i0], rp_u[i1], phases[0], period)
                ts += _segment_crossings(rp_v[i0], rp_v[i1], phases[1], period)
        if not ts:
            continue  # already shorter than a sample step, and no crease crosses
        t = np.unique(np.round(np.asarray(ts, dtype=np.float64), 12))
        t = t[(t > 1e-12) & (t < 1.0 - 1e-12)][:, None]  # strictly interior
        if not len(t):
            continue
        r_mm.append(P_mm[i0] + (P_mm[i1] - P_mm[i0]) * t)
        r_uv.append(base_uv0[i0] + (base_uv0[i1] - base_uv0[i0]) * t)
        r_xyz.append(base_xyz0[i0] + (base_xyz0[i1] - base_xyz0[i0]) * t)
    ring_mm = np.concatenate(r_mm)
    ring_uv = np.concatenate(r_uv)
    ring_xyz = np.concatenate(r_xyz)

    # Sample lines over the face bbox, kept strictly interior.
    lo_u, hi_u = rp_u.min() - spacing, rp_u.max() + spacing
    lo_v, hi_v = rp_v.min() - spacing, rp_v.max() + spacing
    if cells_mode:
        # CELLULAR kinds bring their own vertex set, already in mm coordinates
        # (they ignore `angle`, so there is no pattern frame to map back from).
        G_all = np.asarray(cell_points, dtype=np.float64)
        if len(G_all) > 4 * max(max_tris, 100):
            raise ValueError("cell lattice overshoots budget")
        gx = gy = None
        ni = nj = 0
    else:
        if lattice:
            gx = _axis_lines(phases[0], period, lo_u, hi_u)
            gy = _axis_lines(phases[1], period, lo_v, hi_v)
        else:
            gx = np.arange(lo_u, hi_u, spacing)
            gy = np.arange(lo_v, hi_v, spacing)
        if len(gx) < 2 or len(gy) < 2:
            raise ValueError("too few sample lines")
        if len(gx) * len(gy) > 4 * max(max_tris, 100):
            raise ValueError("grid overshoots budget")
        GX, GY = np.meshgrid(gx, gy, indexing="ij")
        gu, gv = GX.ravel(), GY.ravel()
        # inverse rotation, undoing the offset shift applied above
        G_all = np.stack([gu * ca + gv * sa - offset, -gu * sa + gv * ca], axis=1)
        ni, nj = len(gx), len(gy)
    inside = _points_in_polygon(G_all, ring_a, ring_b)
    if wrap_u:
        # Points sitting exactly ON the UV seam are INSIDE — the seam is an
        # artificial cut, not an edge. Even-odd ray casting cannot tell: it fires
        # along +u, so a point on the u=0 edge crosses the far side and counts as
        # inside while its twin on the u=turn edge crosses nothing and counts as
        # outside. That drops one of the two columns, leaving the survivors on
        # the chart's hull with nothing to weld to, and the taper then pins them
        # flat — the seam stripe again, by a subtler route.
        v_lo, v_hi = ring_mm[:, 1].min(), ring_mm[:, 1].max()
        on_seam = ((np.abs(G_all[:, 0]) < 1e-6) | (np.abs(G_all[:, 0] - wrap_u) < 1e-6))
        if seam_vs is not None:
            # the on-seam lattice points ride in the RING now (seam-aware
            # densification above); keeping interior copies as well would hand
            # Delaunay duplicate points
            inside &= ~on_seam
        elif cells_mode:
            inside |= on_seam & (G_all[:, 1] > v_lo - 1e-9) & (G_all[:, 1] < v_hi + 1e-9)
    ring_cull_ref = ring_mm
    if seam_vs is not None:
        # the seam ring IS lattice geometry now; culling lattice points for
        # sitting near it would eat the very corners the seam strip needs.
        # Cull only against the real rims.
        ring_on_cut = (np.abs(ring_mm[:, 0]) < 1e-6) | (np.abs(ring_mm[:, 0] - wrap_u) < 1e-6)
        if (~ring_on_cut).any():
            ring_cull_ref = ring_mm[~ring_on_cut]
    d_bnd, _ = cKDTree(ring_cull_ref).query(G_all, workers=-1)
    # Cull grid points sitting essentially on the ring, which would make Delaunay
    # slivers. The lattice needs a far smaller margin than the sampled grid: its
    # points are not interchangeable samples but the pattern's own corners, and
    # dropping one costs a facet outright. Measured at 0.6: a knurl cell 0.277mm
    # from the rim lost the corner its crease needed, and NO edge flip could
    # recover it, because the vertex was simply not in the mesh.
    cull = 0.15 if lattice else 0.6
    keep_pt = inside & (d_bnd > cull * spacing)
    n_ring = len(ring_mm)
    if cells_mode:
        # an explicit cell vertex set has no (i, j) structure to index
        kept = gidx = None
        G = G_all[keep_pt]
    else:
        kept = keep_pt.reshape(ni, nj)
        gidx = np.full((ni, nj), -1, dtype=np.int64)
        gidx[kept] = n_ring + np.arange(int(kept.sum()))
        G = G_all.reshape(ni, nj, 2)[kept]
    V_mm = np.concatenate([ring_mm, G])
    if len(V_mm) < 4:
        raise ValueError("too few vertices")

    def _drop_outside(t, cells=None):
        """Keep triangles inside the face and non-degenerate (and, when the
        structured interior already tiled them, outside the full cells)."""
        c = V_mm[t].mean(axis=1)
        f1 = V_mm[t[:, 1]] - V_mm[t[:, 0]]
        f2 = V_mm[t[:, 2]] - V_mm[t[:, 0]]
        ok = (_points_in_polygon(c, ring_a, ring_b)
              & (np.abs(f1[:, 0] * f2[:, 1] - f1[:, 1] * f2[:, 0]) > spacing * spacing * 1e-4))
        if cells is not None:
            # cell test in pattern coords. searchsorted, not a division: the
            # lattice's lines are NOT evenly spaced, so the arithmetic index a
            # uniform grid allows would land in the wrong column.
            pu = (c[:, 0] + offset) * ca - c[:, 1] * sa
            pv = (c[:, 0] + offset) * sa + c[:, 1] * ca
            pi = np.clip(np.searchsorted(gx, pu) - 1, 0, ni - 2)
            pj = np.clip(np.searchsorted(gy, pv) - 1, 0, nj - 2)
            ok &= ~cells[pi, pj]
        return t[ok]

    if lattice:
        # ONE Delaunay over every vertex, for all lattice kinds. Tiling then
        # holds by construction — Delaunay covers its hull exactly once, so
        # neither overlap nor holes are possible. The structured interior +
        # stitched band it replaces cannot promise that: the band is an
        # unconstrained Delaunay that bridges concave notches in the full-cell
        # region, and the centroid test meant to catch that both over- and
        # under-fires. Measured 2mm^2 of double coverage on a 400mm^2 face one
        # way, and 0.65mm^2 of holes the other.
        #
        # What the structured path bought was a deliberate diagonal per cell.
        # That is imposed afterwards where it matters, which is strictly better:
        # the right diagonal is a property of the pattern, not of the grid.
        tris = _drop_outside(Delaunay(V_mm).simplices)
        if not cells_mode and phases[1] is not None:
            # both axes carry creases, so cells are square and min()'s switch
            # line IS a diagonal — see _force_cell_diagonals
            full = kept[:-1, :-1] & kept[1:, :-1] & kept[1:, 1:] & kept[:-1, 1:]
            ii, jj = np.nonzero(full)
            if len(ii):
                quads = np.stack([gidx[ii, jj], gidx[ii + 1, jj],
                                  gidx[ii + 1, jj + 1], gidx[ii, jj + 1]], axis=1)
                h = field(V_mm[quads.ravel()]).reshape(-1, 4)
                centre = field(V_mm[quads].mean(axis=1))
                # the cell centre lies on BOTH candidate diagonals, so the height
                # a diagonal implies there is the mean of its two endpoints
                want_main = np.abs((h[:, 0] + h[:, 2]) * 0.5 - centre) <= \
                    np.abs((h[:, 1] + h[:, 3]) * 0.5 - centre)
                tris = _force_cell_diagonals(tris, V_mm, quads, want_main)
        # mop up the rim band, where the stitching can still bridge a crease.
        # Seam ring vertices displace with the field (taper-exempt), so the
        # seam strip is scored and repaired too — see _flip_to_creases.
        tris = _flip_to_creases(
            tris, V_mm, field, n_ring=n_ring,
            ring_fixable=((np.abs(ring_mm[:, 0]) < 1e-6)
                          | (np.abs(ring_mm[:, 0] - wrap_u) < 1e-6))
            if wrap_u else None)
    else:
        # STRUCTURED interior triangulation with one consistent diagonal per
        # cell. (Delaunay on a regular grid is co-circular — its arbitrary
        # tie-break flips diagonals cell to cell, and the between-row surface
        # tents differently per cell: visible "roped" beading along
        # otherwise-straight crests. A fixed diagonal removes that entirely.)
        # Delaunay is only used for the irregular band stitching the grid region
        # to the boundary ring. Cells here are near-square, which is the regime
        # the centroid-only overlap test is sound in.
        full = kept[:-1, :-1] & kept[1:, :-1] & kept[1:, 1:] & kept[:-1, 1:]
        ii, jj = np.nonzero(full)
        a = gidx[ii, jj]; b_ = gidx[ii + 1, jj]; c = gidx[ii + 1, jj + 1]; d = gidx[ii, jj + 1]
        interior_tris = np.concatenate([np.stack([a, b_, c], axis=1),
                                        np.stack([a, c, d], axis=1)])

        # band = ring verts + kept grid points NOT fully surrounded by full cells
        # (a point with all 4 adjacent cells full is interior-only; everything
        # else participates in the stitching band)
        surrounded = np.zeros((ni, nj), dtype=bool)
        core = full[:-1, :-1] & full[1:, :-1] & full[1:, 1:] & full[:-1, 1:]
        surrounded[1:-1, 1:-1] = core
        band_ids = np.concatenate([np.arange(n_ring), gidx[kept & ~surrounded]])
        band_tris = band_ids[Delaunay(V_mm[band_ids]).simplices]
        tris = np.concatenate([interior_tris, _drop_outside(band_tris, cells=full)])
    if len(tris) == 0:
        raise ValueError("empty after filtering")

    # Map back. Ring verts carry their exact on-edge uv/xyz either way (originals
    # verbatim, densified ones lerped along the same segments, which is what
    # keeps the seam flush).
    base_uv_arr = np.asarray(base_uv, dtype=np.float64)
    base_pts_arr = np.asarray(base_pts, dtype=np.float64)
    if unchart is None:
        # PLANE: uv and xyz are both affine in the mm chart, so one least-squares
        # fit places every grid point with no per-point OCCT evaluation at all.
        # The residual doubles as the planarity assertion.
        M = np.column_stack([P_mm, np.ones(len(P_mm))])
        A_uv, res_uv, _rk, _sv = np.linalg.lstsq(M, base_uv_arr, rcond=None)
        A_xyz, res_xyz, _rk2, _sv2 = np.linalg.lstsq(M, base_pts_arr, rcond=None)
        fit_err = np.abs(M @ A_xyz - base_pts_arr).max()
        if fit_err > max(1e-4, spacing * 1e-3):
            raise ValueError("non-affine chart (not a plane?)")
        GM = np.column_stack([G, np.ones(len(G))])
        grid_uv, grid_xyz = GM @ A_uv, GM @ A_xyz
    else:
        # CYLINDER / CONE: the chart is exact but curved, so invert it in closed
        # form and evaluate the surface directly. Only interior grid points go
        # through this — the ring deliberately does NOT, because its points must
        # stay on the neighbouring face's chords rather than on the true surface.
        grid_uv, grid_xyz = unchart(G)
    uv_out = np.concatenate([ring_uv, grid_uv])
    pts_out = np.concatenate([ring_xyz, grid_xyz])

    # winding: match the base triangulation's outward orientation
    n_ref = np.cross(base_pts_arr[tri_idx[0, 1]] - base_pts_arr[tri_idx[0, 0]],
                     base_pts_arr[tri_idx[0, 2]] - base_pts_arr[tri_idx[0, 0]])
    n_new = np.cross(pts_out[tris[:, 1]] - pts_out[tris[:, 0]],
                     pts_out[tris[:, 2]] - pts_out[tris[:, 0]])
    wrong = (n_new @ n_ref) < 0
    tris[wrong] = tris[wrong][:, [0, 2, 1]]

    return ([tuple(p) for p in pts_out], [tuple(p) for p in uv_out],
            [tuple(int(i) for i in t) for t in tris])


LATTICE_SURFACES = ("plane", "cylinder", "cone")


def _surface_kind(surf):
    """plane / cylinder / cone — the surfaces `_face_uv_to_mm` charts EXACTLY,
    and therefore the ones a lattice can be placed on. Everything else gets a
    single-Jacobian approximation of the chart, which is fine for sampling a
    field but not for claiming a vertex sits on a crease."""
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane

    t = surf.GetType()
    if t == GeomAbs_Plane:
        return "plane"
    if t == GeomAbs_Cylinder:
        return "cylinder"
    if t == GeomAbs_Cone:
        return "cone"
    return None


def _uncharter(surf, period=None):
    """Return `unchart(mm) -> (uv, xyz)`, the inverse of `_face_uv_to_mm` plus
    the surface evaluation, for the exactly-chartable surfaces.

    Closed form and vectorised rather than a per-point `surf.Value` call: a
    knurled cylinder places tens of thousands of lattice points, and OCCT
    evaluates one at a time. Both parametrisations are OCCT's own —
    P(u,v) = Loc + (R + v·sinA)·(cos u·X + sin u·Y) + v·cosA·Z, with A = 0 for a
    cylinder."""
    kind = _surface_kind(surf)
    if kind == "plane":
        return None  # affine in the mm chart; the caller's lstsq fit is exact

    if kind == "cylinder":
        cyl = surf.Cylinder()
        ax, radius, half = cyl.Position(), cyl.Radius(), 0.0
    else:
        cone = surf.Cone()
        ax, radius, half = cone.Position(), cone.RefRadius(), cone.SemiAngle()

    loc = np.array([ax.Location().X(), ax.Location().Y(), ax.Location().Z()])
    xd = np.array([ax.XDirection().X(), ax.XDirection().Y(), ax.XDirection().Z()])
    yd = np.array([ax.YDirection().X(), ax.YDirection().Y(), ax.YDirection().Z()])
    zd = np.array([ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()])
    sin_a, cos_a = math.sin(half), math.cos(half)
    per_turn = _turn_mm(surf, period)

    def unchart(mm):
        v = mm[:, 1]
        # invert the ANCHORED chart: u_mm is arc measured at the reference
        # radius, so the angle is a plain proportion of one full turn
        u = mm[:, 0] * (2.0 * math.pi) / per_turn
        # the POINT still sits at the surface's true local radius
        r = radius + v * sin_a
        xyz = (loc[None, :]
               + (r[:, None] * np.cos(u)[:, None]) * xd[None, :]
               + (r[:, None] * np.sin(u)[:, None]) * yd[None, :]
               + (v * cos_a)[:, None] * zd[None, :])
        return np.column_stack([u, v]), xyz

    return unchart


def _dist3(a, b):
    dx, dy, dz = a[0] - b[0], a[1] - b[1], a[2] - b[2]
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def _refine_face_triangulation(surf, pts, uv, tris, target_edge_mm, max_tris):
    """Uniform 1-to-4 subdivision: every triangle splits at its edge midpoints in
    the SAME pass, so neighbors always split identically — no T-junctions, by
    construction (a true adaptive/non-uniform quad-tree would need extra
    edge-balancing logic to avoid cracks; this trades a bit of triangle economy
    for guaranteed crack-freedom with much simpler code). Each new vertex lands
    on the TRUE surface via surf.Value(u,v) at the midpoint's UV — never a lerp
    of the coarse triangle, which is what keeps curved faces exact. Edge-key
    dedup means a shared edge is only evaluated once per pass."""
    pts = list(pts)
    uv = list(uv)
    tris = [tuple(t) for t in tris]
    while True:
        if len(tris) * 4 > max_tris:
            break
        max_edge = 0.0
        for a, b, c in tris:
            max_edge = max(
                max_edge, _dist3(pts[a], pts[b]), _dist3(pts[b], pts[c]), _dist3(pts[c], pts[a])
            )
        if max_edge <= target_edge_mm:
            break
        mid = {}
        # Which edges bound the face — recomputed each pass, since splitting a
        # boundary edge yields two more of them.
        counts = _boundary_edges(tris)
        on_boundary = {k for k, n in counts.items() if n == 1}

        def midpoint(i, j):
            key = (i, j) if i < j else (j, i)
            hit = mid.get(key)
            if hit is not None:
                return hit
            um = (uv[i][0] + uv[j][0]) * 0.5
            vm = (uv[i][1] + uv[j][1]) * 0.5
            if key in on_boundary:
                # CHORD, not the true surface. The neighbouring untextured face
                # still spans this edge as a straight segment, so putting the new
                # vertex on the real surface bulges this face off that segment by
                # up to the chord's sagitta and opens a seam. Measured on a
                # knurled r=10 cylinder: 4,032 of 4,224 boundary vertices adrift,
                # by up to 0.048mm, against a polyline the two faces otherwise
                # share bit-identically. Splitting the edge is still required —
                # leaving it unsplit while its neighbours divide would create a
                # T-junction, which cracks the mesh from the inside instead.
                p = ((pts[i][0] + pts[j][0]) * 0.5,
                     (pts[i][1] + pts[j][1]) * 0.5,
                     (pts[i][2] + pts[j][2]) * 0.5)
            else:
                pp = surf.Value(um, vm)
                p = (pp.X(), pp.Y(), pp.Z())
            idx = len(pts)
            pts.append(p)
            uv.append((um, vm))
            mid[key] = idx
            return idx

        new_tris = []
        for a, b, c in tris:
            ab, bc, ca = midpoint(a, b), midpoint(b, c), midpoint(c, a)
            new_tris.append((a, ab, ca))
            new_tris.append((ab, b, bc))
            new_tris.append((ca, bc, c))
            new_tris.append((ab, bc, ca))
        tris = new_tris
    return pts, uv, tris


def _smoothstep(t):
    return t * t * (3.0 - 2.0 * t)


def _boundary_edges(tris):
    from collections import Counter

    edge_count = Counter()
    for a, b, c in tris:
        for i, j in ((a, b), (b, c), (c, a)):
            key = (i, j) if i < j else (j, i)
            edge_count[key] += 1
    return edge_count


def _boundary_taper(pts_arr, tris, inset_mm, exempt=None):
    """0 at the face boundary, smoothstepping to 1 over `inset_mm` — this is what
    keeps boundary vertices bit-identical to the untextured mesh (zero
    displacement) so a neighboring untextured face needs no special handling and
    no crack can form at the seam.

    Distance is to the nearest boundary-edge ENDPOINT (cKDTree), not the exact
    segment: boundary edges are subdivided to ~the texture sample length, so the
    error is bounded by half a segment — invisible inside a 1mm smoothstep — and
    boundary vertices themselves are endpoints, so their distance (and taper) is
    EXACTLY zero, preserving the crack-free invariant. (The exact all-pairs
    point-to-segment pass this replaces was >90% of textured-tessellation time.)"""
    edge_count = _boundary_edges(tris)
    boundary = [k for k, n in edge_count.items() if n == 1]
    if exempt is not None:
        # A closed surface's UV SEAM is an artificial cut, not an edge, and
        # pinning it leaves a flat stripe running the height of every textured
        # cylinder and cone (measured: 78 vertices in one line, all undisplaced).
        # Nothing is welded to achieve this — now that a full turn is a whole
        # number of pattern periods, the two sides evaluate the SAME field and
        # displace identically, so they stay coincident on their own. Leaving the
        # triangulation alone is what keeps the crease-exactness intact; welding
        # after the flip repair instead broke 1-5% of the triangles near the seam.
        boundary = [k for k in boundary if not (exempt[k[0]] and exempt[k[1]])]
    if not boundary:
        return np.ones(len(pts_arr)), edge_count
    from scipy.spatial import cKDTree

    endpoints = pts_arr[np.unique(np.asarray(boundary, dtype=np.int64).ravel())]
    d, _ = cKDTree(endpoints).query(pts_arr, workers=-1)  # exact same results, all cores
    if inset_mm <= 1e-9:
        return (d > 1e-9).astype(np.float64), edge_count
    return _smoothstep(np.clip(d / inset_mm, 0.0, 1.0)), edge_count


def _manifold_check(edge_count):
    """Every edge of a single face's local triangulation is either INTERIOR
    (shared by exactly 2 triangles) or on the face's outer boundary (exactly 1) —
    anything else means the subdivision/dedup logic produced a T-junction or
    degenerate triangle. Cheap edge-share count pass; never a hard failure, just
    a diagnostic (per the plan's risk table)."""
    bad = sum(1 for n in edge_count.values() if n not in (1, 2))
    return bad == 0, bad


def _face_frame(surf, uv_arr, flip):
    """Per-vertex surface frame: (normals, tu, tv) — exact normal plus UNIT
    tangents along the u/v parameter directions, all (N,3). The tangents feed
    the analytic displaced-normal gradient (shading), so orthogonality is only
    approximate on skewed freeform parameterizations — fine for lighting.

    Uses BRepLProp_SLProps (NOT GeomLProp_SLProps, which needs a raw
    untransformed Geom_Surface plus manual location correction; BRepLProp takes
    the already-transformed BRepAdaptor_Surface and gives world-space vectors,
    verified against face.normal_at() on rotated + translated faces). Sign-flip
    matches tessellate.py's REVERSED-face winding flip. A PLANE has a constant
    frame — evaluated once and broadcast, skipping the per-vertex Python loop
    entirely for the most common case."""
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane

    n = uv_arr.shape[0]
    normals = np.zeros((n, 3), dtype=np.float64)
    tu = np.zeros((n, 3), dtype=np.float64)
    tv = np.zeros((n, 3), dtype=np.float64)
    sign = -1.0 if flip else 1.0

    def eval_at(u, v):
        props = BRepLProp_SLProps(surf, float(u), float(v), 1, 1e-6)
        if not props.IsNormalDefined():
            return None
        nv = props.Normal()
        du = props.D1U()
        dv = props.D1V()
        lu = du.Magnitude() or 1.0
        lv = dv.Magnitude() or 1.0
        return (
            (nv.X() * sign, nv.Y() * sign, nv.Z() * sign),
            (du.X() / lu, du.Y() / lu, du.Z() / lu),
            (dv.X() / lv, dv.Y() / lv, dv.Z() / lv),
        )

    if surf.GetType() == GeomAbs_Plane:
        got = eval_at(uv_arr[:, 0].mean(), uv_arr[:, 1].mean())
        if got is not None:
            normals[:], tu[:], tv[:] = got
        return normals, tu, tv

    if surf.GetType() == GeomAbs_Cylinder:
        # closed form: S(u,v) = L + R(cos u·X + sin u·Y) + v·Z — radial normal,
        # tangents from the same frame, fully vectorized. One exact evaluation
        # at the centroid calibrates the normal's sign (Ax3 handedness +
        # REVERSED-face flip) instead of reasoning about orientation flags.
        got = eval_at(uv_arr[:, 0].mean(), uv_arr[:, 1].mean())
        if got is not None:
            ax = surf.Cylinder().Position()
            X = np.array([ax.XDirection().X(), ax.XDirection().Y(), ax.XDirection().Z()])
            Y = np.array([ax.YDirection().X(), ax.YDirection().Y(), ax.YDirection().Z()])
            Z = np.array([ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()])
            u = uv_arr[:, 0]
            cu, su = np.cos(u)[:, None], np.sin(u)[:, None]
            radial = cu * X + su * Y
            um = float(u.mean())
            n_ref = np.cos(um) * X + np.sin(um) * Y
            s = 1.0 if float(np.dot(np.asarray(got[0]), n_ref)) >= 0.0 else -1.0
            normals[:] = s * radial
            tu[:] = -su * X + cu * Y  # d/du direction (unit: R factor drops)
            tv[:] = Z
        return normals, tu, tv

    for i in range(n):
        try:
            got = eval_at(uv_arr[i, 0], uv_arr[i, 1])
            if got is not None:
                normals[i], tu[i], tv[i] = got
        except Exception:
            pass  # degenerate point (pole/singularity) — zero frame: no displacement
    return normals, tu, tv


def _face_normals(surf, uv_arr, flip):
    """Back-compat wrapper: normals only (see _face_frame)."""
    return _face_frame(surf, uv_arr, flip)[0]


# Displacement-geometry skeleton cache: while a texture param is scrubbed
# (depth/sharpness/seed/direction...), the face, its refined sampling grid,
# boundary taper and surface frame are all IDENTICAL — only the height field
# changes. Caching the skeleton turns a scrub tick's tessellation cost into a
# few vectorized height evaluations. Keyed on the face's TShape (same identity
# trick tessellate.py's _EDGE_MEMO uses) plus the base-triangulation counts +
# first node (a re-mesh at a different tolerance mutates the triangulation in
# place, which must miss) and every geometry-shaping param. Small LRU: entries
# hold a few MB of numpy arrays each.

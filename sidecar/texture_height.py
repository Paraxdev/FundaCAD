"""The height fields a printed texture is made of.

Split out of texture.py. Everything here is pure numpy: (u, v) in millimetres
goes in, a [0,1] "raggedness" field comes out, and nothing knows what a face or
a triangulation is. That makes every kind — knurl, hex, waves, ribs, voronoi,
noise, an image heightmap — testable on a grid of numbers.

The recurring theme is FACETS. A sub-millimetre sinusoid is something a printer
rounds off into mush, so the default profile is hard-surface: triangle and
trapezoid waves instead of sines, terraced plateaus instead of slopes, and a
sharpness control that shapes the facet rather than bending it into a curve
(`_sharpen` is for round profiles only, and applying it to a faceted one is the
single biggest facet-destroyer there is).
"""

import math

import numpy as np

# --- height fields (kind -> vectorized numpy [0,1] "raggedness" field) -------


def _rotate(u, v, angle_deg):
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    return u * ca - v * sa, u * sa + v * ca


def _tri_wave(x, period):
    t = (x % period) / period
    return 1.0 - np.abs(2.0 * t - 1.0)


def _sharpen(h, sharpness):
    # sharpness in [0,1]; higher = crisper peaks/valleys, via a power curve.
    # ROUND profiles only: a power curve bends a piecewise-linear ramp into a
    # cubic, so applying it to a faceted profile is the single biggest
    # facet-destroyer in this file. Faceted kinds shape themselves instead.
    return h ** (1.0 + 4.0 * max(0.0, min(1.0, sharpness)))


def _is_facet(spec):
    """Hard-surface (faceted) profile is the DEFAULT: planar facets and real
    creases print far better than a sub-millimetre sinusoid, which a printer
    just rounds off. `profile: "round"` restores the original smooth fields."""
    return spec.get("profile", "facet") != "round"


def _trapezoid(x, period, land):
    """Triangle wave with a flat LAND of width `land` (0..1 of the half-period)
    at both the crest and the trough — the profile an actual knurling wheel or
    form tool leaves. land=0 is a pure V; land→1 is a square wave."""
    t = (x % period) / period
    tri = 1.0 - np.abs(2.0 * t - 1.0)  # 0..1..0
    k = max(0.0, min(0.98, float(land)))
    if k <= 1e-9:
        return tri
    # rescale the ramp so it saturates `k/2` in from each end, then clamp: the
    # ramps stay straight (still planar facets) and the ends go flat.
    return np.clip((tri - k * 0.5) / max(1.0 - k, 1e-9), 0.0, 1.0)


def _terrace(h, steps):
    """Quantise a continuous field into `steps` flat levels with vertical
    risers between them — how a smooth field (noise, an image heightmap)
    becomes hard-surface: plateaus a nozzle can actually lay down, instead of a
    slope it rounds into mush.

    The top bucket is clamped to steps-1 so h == 1.0 lands ON the top level
    rather than one past it — without that the result exceeds 1.0 and breaks the
    [0,1] contract every caller relies on."""
    n = max(2, int(round(steps)))
    q = np.minimum(np.floor(np.clip(h, 0.0, 1.0) * n), n - 1)
    return q / (n - 1.0)


def _steps_from(sharpness):
    """The Sharp slider doubles as the terrace count for the quantised kinds:
    0 → 2 coarse plateaus, 1 → 12 fine ones."""
    s = max(0.0, min(1.0, float(sharpness)))
    return int(round(2 + s * 10))


def _height_knurl(u, v, scale, angle, sharpness, facet=True):
    # crossed triangle-wave ridges (angle, angle+90) — classic diamond knurl.
    _, v1 = _rotate(u, v, angle)
    _, v2 = _rotate(u, v, angle + 90.0)
    if facet:
        # MIN of the two groove profiles, not their product. A product of two
        # linear ramps is a BILINEAR SADDLE — every cell curves, which is what
        # made this read as soft bumps instead of knurling. min() is what two
        # crossed V-grooves actually cut: planar facets, straight ridges.
        return np.minimum(_trapezoid(v1, scale, sharpness), _trapezoid(v2, scale, sharpness))
    h = _tri_wave(v1, scale) * _tri_wave(v2, scale)
    return _sharpen(h, sharpness)


# The honeycomb is the Voronoi diagram of a TRIANGULAR lattice, so a cell's six
# neighbour directions are its six half-plane constraints, and its six corners
# sit half a step round from them.
_HEX_DIRS = np.array([[math.cos(math.radians(60 * k)), math.sin(math.radians(60 * k))]
                      for k in range(6)])
_HEX_CORNERS = np.array([[math.cos(math.radians(30 + 60 * k)), math.sin(math.radians(30 + 60 * k))]
                         for k in range(6)])


def _hex_wall_width(scale, sharpness):
    """Wall width in mm, from the shared `sharpness` slider — crisper means a
    narrower wall and a broader flat top, matching what the slider does for every
    other kind. Expressed against the cell's inradius so it scales with `scale`.

    The floor is 0.14 of the inradius, not 0.10. Below roughly an eighth of the
    cell the wall stops being meshable exactly: two neighbouring flat tops end up
    closer to each other than to the groove between them, and an unconstrained
    Delaunay takes the short edge and bridges the crease (measured 0.24mm on a
    0.4mm texture at 0.10). It is not a real loss — a wall that narrow is a
    near-vertical cliff no nozzle resolves anyway."""
    s = max(0.0, min(1.0, float(sharpness)))
    return (0.14 + 0.31 * (1.0 - s)) * (scale * 0.5)


def _hex_nearest_site(u, v, a):
    """Nearest site of the triangular lattice site(i,j) = (i·a + j·a/2, j·a·√3/2),
    whose Voronoi cells ARE the honeycomb.

    The lattice's fundamental domain is a rhombus, so the nearest site to any
    point is one of that rhombus's four corners — checking those four is exact,
    not an approximation (the tests assert it by requiring every point to fall
    inside its own cell)."""
    root3 = math.sqrt(3.0)
    jf = v / (a * root3 * 0.5)
    i_f = u / a - jf * 0.5
    i0, j0 = np.floor(i_f), np.floor(jf)
    best_x = best_y = best_d = None
    for di in (0.0, 1.0):
        for dj in (0.0, 1.0):
            sx = (i0 + di) * a + (j0 + dj) * a * 0.5
            sy = (j0 + dj) * a * root3 * 0.5
            d2 = (u - sx) ** 2 + (v - sy) ** 2
            if best_d is None:
                best_x, best_y, best_d = sx, sy, d2
            else:
                m = d2 < best_d
                best_x = np.where(m, sx, best_x)
                best_y = np.where(m, sy, best_y)
                best_d = np.where(m, d2, best_d)
    return best_x, best_y


def _height_hex(u, v, scale, sharpness=0.5, facet=True):
    if not facet:
        # 3-direction cosine interference sum — a closed-form honeycomb pattern
        # (no lattice nearest-neighbor search needed), normalized to [0,1].
        root3 = math.sqrt(3.0)
        a = np.cos(2 * np.pi * u / scale)
        b = np.cos(2 * np.pi * (u * 0.5 - v * root3 * 0.5) / scale)
        c = np.cos(2 * np.pi * (u * 0.5 + v * root3 * 0.5) / scale)
        return np.clip((a + b + c) / 3.0 * 0.5 + 0.5, 0.0, 1.0)

    # FACETED: a real hexagonal mesa — flat top, six planar walls, creases along
    # the cell edges and along the six spokes where two walls meet.
    #
    # This replaces a clipped cosine sum. That version's walls followed a
    # COSINE level set, so they were curved: no arrangement of sample points can
    # reproduce them, and the mesh was measured 41% of the texture's own depth
    # off. Distance to the cell boundary is piecewise linear instead, which is
    # both exactly meshable and what the code always claimed to draw ("flat
    # topped mesas with straight walls").
    sx, sy = _hex_nearest_site(u, v, scale)
    du, dv = u - sx, v - sy
    # distance to each of the six bounding half-planes; the cell's inradius is
    # half the centre-to-centre step
    d_edge = (scale * 0.5
              - (du[..., None] * _HEX_DIRS[:, 0] + dv[..., None] * _HEX_DIRS[:, 1])).min(axis=-1)
    return np.clip(d_edge / max(_hex_wall_width(scale, sharpness), 1e-9), 0.0, 1.0)


# Joins per period in the faceted wave. Fixed, and 8 is not a taste call: the
# lattice plants a sample line per crease, so the facet count sets the grid's
# ASPECT against the free axis (one line per period). At 8 the cells are 1:8 and
# the assembly is exact everywhere; at 12 and 16 the seam strip on a cylinder
# starts handing Delaunay cells so slivered it bridges two crease columns at
# once (measured: 5 and 37 interior triangles off by up to 0.026mm, all within
# 1.2mm of the seam). Finer is also pointless for the printer — 16 facets on a
# 2mm wave is 0.125mm each, under any nozzle. So the slider shapes the profile
# BETWEEN these joins instead of adding more of them.
_WAVE_JOINS = 8


def _wave_levels():
    """The faceted wave's height at each of its `_WAVE_JOINS` joins.

    There is deliberately NO shape parameter. Every way of flattening or peaking
    a one-dimensional profile on this few joins lands back on the trapezoid /
    triangle family — which IS ribs, only phase-shifted — so a "roundness"
    slider would spend its travel walking waves back into the kind it exists to
    differ from. Tried and rejected: a gain about mid-height clipped the crest
    flat by slider position 0.21 and then did nothing for the remaining 80%. The
    sine is the distinction, and it has no free parameter; the panel hides the
    control for this kind rather than showing a dead one."""
    i = np.arange(_WAVE_JOINS)
    return 0.5 + 0.5 * np.sin(2 * np.pi * i / _WAVE_JOINS)


def _wave_phases():
    """Gradient breakpoints of the faceted wave, as fractions of one period.

    NOT every join: the sine is antisymmetric about its two INFLECTIONS, and the
    joins are symmetric about them too, so the chords either side share a slope
    and the polyline runs dead straight through. Those two turn no corner, and a
    line there would buy nothing but triangles — a quarter of them. Read off the
    levels rather than hardcoded, by comparing the slope arriving with the one
    leaving."""
    lv = _wave_levels()
    d = np.roll(lv, -1) - lv  # slope of the segment starting at join i
    return tuple(i / _WAVE_JOINS for i in range(_WAVE_JOINS)
                 if abs(float(d[i - 1] - d[i])) > 1e-12)


def _facet_wave(x, period):
    """The faceted wave: linear interpolation between `_wave_levels`.

    Faceted kinds must be piecewise linear to be MESHABLE EXACTLY — a curved
    level set cannot be reproduced by any arrangement of sample points, which is
    what left the old cosine-walled hex measured 41% of its own depth off. So
    the rounded look is built from real planar facets and real creases rather
    than approximated by sampling a curve."""
    lv = _wave_levels()
    n = len(lv)
    t = (x % period) / period * n
    i = np.floor(t)
    f = t - i
    i = i.astype(np.int64) % n
    lo = lv[i]
    return lo + (lv[(i + 1) % n] - lo) * f


def _height_waves(u, v, scale, angle, sharpness, facet=True):
    u1, _ = _rotate(u, v, angle)
    if facet:
        # a faceted SINE, not a trapezoid: rounded undulation against ribs' flat
        # -topped prisms. Both kinds used to return _trapezoid here, which made
        # them byte-identical under the default profile (measured max|w-r| = 0).
        # `sharpness` is deliberately unused — see _wave_levels.
        return _facet_wave(u1, scale)
    h = 0.5 + 0.5 * np.sin(2 * np.pi * u1 / scale)
    return _sharpen(h, sharpness)


def _height_ribs(u, v, scale, angle, sharpness, facet=True):
    u1, _ = _rotate(u, v, angle)
    if facet:
        return _trapezoid(u1, scale, sharpness)
    return _sharpen(_tri_wave(u1, scale), sharpness)


def _hash01(i, j, seed, salt):
    """Deterministic [0,1) value from a CELL INDEX, not from an array position.

    The sites used to be jittered with a single `default_rng(seed)` stream walked
    across a grid sized from the QUERY's own bounding box, which quietly made the
    pattern depend on which points you asked about: displace_face evaluates the
    field four extra times at +/-eps to get its shading gradient, and each of
    those has a slightly different extent, so it was differentiating a DIFFERENT
    pattern from the one it displaced. Hashing the cell index pins each site to
    its place on the plane instead."""
    h = ((i.astype(np.int64) * 73856093)
         ^ (j.astype(np.int64) * 19349663)
         ^ (np.int64(seed) * 83492791)
         ^ (np.int64(salt) * 2971215073))
    h = (h ^ (h >> 13)) * np.int64(1274126177)
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF) / float(0x1000000)


def _voronoi_sites(scale, seed, lo_u, hi_u, lo_v, hi_v):
    """One jittered site per `scale`-sized cell covering the box, anchored to the
    plane so the same region always yields the same sites."""
    i0, i1 = int(math.floor(lo_u / scale)) - 1, int(math.ceil(hi_u / scale)) + 1
    j0, j1 = int(math.floor(lo_v / scale)) - 1, int(math.ceil(hi_v / scale)) + 1
    ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1), indexing="ij")
    ii, jj = ii.ravel(), jj.ravel()
    ju = 0.2 + 0.6 * _hash01(ii, jj, seed, 1)
    jv = 0.2 + 0.6 * _hash01(ii, jj, seed, 2)
    return np.stack([(ii + ju) * scale, (jj + jv) * scale], axis=1)


def _height_voronoi(u, v, scale, seed, sharpness=0.5, facet=True):
    """Clipped distance to the nearest SITE: a flat plate with a conical dimple
    punched into each cell.

    NOT exactly meshable, and knowingly so. The cone is curved, so no arrangement
    of vertices reproduces it — measured 95% of the texture's own depth off, the
    worst of any kind. The fix is the same one hex got (distance to the cell
    BOUNDARY, which is a min of half-planes and therefore piecewise linear), but
    a Voronoi cell is irregular, and insetting an irregular convex polygon is not
    just "move every edge inward": edges vanish at different widths, and the
    straight skeleton grows nodes a naive inset puts in the wrong place. That
    needs a real straight-skeleton pass, so it is left for its own change rather
    than shipped half-done — a redefinition that changed every existing voronoi
    model without delivering exactness would be the worst of both."""
    from scipy.spatial import cKDTree

    sites = _voronoi_sites(scale, int(seed),
                           float(np.min(u)) - 3 * scale, float(np.max(u)) + 3 * scale,
                           float(np.min(v)) - 3 * scale, float(np.max(v)) + 3 * scale)
    P = np.stack([np.asarray(u).ravel(), np.asarray(v).ravel()], axis=1)
    d, _i = cKDTree(sites).query(P, workers=-1)
    h = np.clip(d / (scale * 0.5), 0.0, 1.0).reshape(np.shape(u))
    if not facet:
        return h
    k = 0.15 + 0.45 * (1.0 - max(0.0, min(1.0, sharpness)))
    return np.clip(h / max(k, 1e-9), 0.0, 1.0)


def _lerp(a, b, t):
    return a + t * (b - a)


def _perlin2(x, y, perm):
    """Vectorized 2D gradient noise (Perlin-style), 4-direction diagonal gradients —
    the standard cheap simplification (full 8/12-direction gradient sets buy
    smoothness we don't need for a bump texture)."""
    xi = np.floor(x).astype(np.int64) & 255
    yi = np.floor(y).astype(np.int64) & 255
    xf = x - np.floor(x)
    yf = y - np.floor(y)
    u = xf * xf * xf * (xf * (xf * 6 - 15) + 10)  # quintic fade
    v = yf * yf * yf * (yf * (yf * 6 - 15) + 10)

    def grad(h, gx, gy):
        h = h & 3
        sx = np.where((h & 1) == 0, 1.0, -1.0)
        sy = np.where((h & 2) == 0, 1.0, -1.0)
        return sx * gx + sy * gy

    aa = perm[perm[xi] + yi]
    ba = perm[perm[xi + 1] + yi]
    ab = perm[perm[xi] + yi + 1]
    bb = perm[perm[xi + 1] + yi + 1]

    x1 = _lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u)
    x2 = _lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u)
    return _lerp(x1, x2, v)


def _height_noise(u, v, scale, seed, octaves):
    rng = np.random.default_rng(int(seed))
    p = rng.permutation(256).astype(np.int64)
    perm = np.concatenate([p, p])
    total = np.zeros_like(u)
    amp = 1.0
    freq = 1.0
    max_amp = 0.0
    for _ in range(octaves):
        total = total + amp * _perlin2(u / scale * freq, v / scale * freq, perm)
        max_amp += amp
        amp *= 0.5
        freq *= 2.0
    total = total / max_amp
    return np.clip(total * 0.5 + 0.5, 0.0, 1.0)


def _height_image(u, v, image_path, u_range, v_range):
    from PIL import Image

    with Image.open(image_path) as im:
        arr = np.asarray(im.convert("L"), dtype=np.float64) / 255.0
    h_img, w_img = arr.shape
    umin, umax = u_range
    vmin, vmax = v_range
    uu = np.clip((u - umin) / max(umax - umin, 1e-9), 0.0, 1.0)
    vv = np.clip((v - vmin) / max(vmax - vmin, 1e-9), 0.0, 1.0)
    fx = uu * (w_img - 1)
    fy = (1.0 - vv) * (h_img - 1)  # image row 0 is the TOP; v grows "up"
    x0 = np.floor(fx).astype(np.int64)
    x1 = np.clip(x0 + 1, 0, w_img - 1)
    y0 = np.floor(fy).astype(np.int64)
    y1 = np.clip(y0 + 1, 0, h_img - 1)
    tx = fx - x0
    ty = fy - y0
    top = arr[y0, x0] * (1 - tx) + arr[y0, x1] * tx
    bot = arr[y1, x0] * (1 - tx) + arr[y1, x1] * tx
    return top * (1 - ty) + bot * ty


def height_field(kind, spec, u_mm, v_mm, u_range=None, v_range=None):
    """Return a [0,1] "raggedness" field (0=valley, 1=peak) for the given kind, as a
    plain vectorized numpy computation over the u_mm/v_mm coordinate arrays.

    `spec["profile"]` selects hard-surface (`"facet"`, the default — planar
    facets and real creases, which is what survives a 3D print) or the original
    smooth fields (`"round"`). `sharpness` is reused per profile rather than
    adding a control: under facet it is the flat-LAND fraction for the periodic
    kinds, the FACET COUNT for waves, the wall width for the cellular ones, and
    the terrace count for the continuous ones."""
    scale = max(float(spec.get("scale", 2.0)), 0.05)
    angle = float(spec.get("angle", 0.0))
    sharpness = float(spec.get("sharpness", 0.5))
    facet = _is_facet(spec)
    if kind == "knurl":
        return _height_knurl(u_mm, v_mm, scale, angle, sharpness, facet)
    if kind == "hex":
        return _height_hex(u_mm, v_mm, scale, sharpness, facet)
    if kind == "waves":
        return _height_waves(u_mm, v_mm, scale, angle, sharpness, facet)
    if kind == "ribs":
        return _height_ribs(u_mm, v_mm, scale, angle, sharpness, facet)
    if kind == "voronoi":
        return _height_voronoi(u_mm, v_mm, scale, spec.get("seed", 0), sharpness, facet)
    if kind == "noise":
        h = _height_noise(u_mm, v_mm, scale, spec.get("seed", 0), spec.get("octaves", 3))
        return _terrace(h, _steps_from(sharpness)) if facet else h
    if kind == "image":
        h = _height_image(u_mm, v_mm, spec["imagePath"], u_range, v_range)
        return _terrace(h, _steps_from(sharpness)) if facet else h
    raise ValueError(f"unknown texture kind: {kind}")


# --- UV -> mm (first fundamental form) ---------------------------------------


def _u_period(spec, scale):
    """The pattern's translation period ALONG U — what a full turn has to be a
    whole number of, for the pattern to meet itself at the seam.

    Rotating changes it. A rib pattern at angle θ repeats every `scale` across
    its crests, but travelling along u you cross a crest every `scale/cos θ`, so
    snapping the turn to whole `scale` units closes it only at θ = 0. Returns 0
    for "no constraint": at θ = 90° the crests run along u and the pattern is
    already invariant, so any turn closes.

    knurl and hex are 2D lattices and get `scale` regardless, which is exact only
    at multiples of 90°. Closing a rotated 2D lattice on a cylinder needs the
    turn to be a lattice vector in BOTH directions at once — possible only when
    tan θ is rational — so at a general angle they cannot close, and the seam
    carries a phase joint. That is geometry, not a defect to fix here."""
    if spec["kind"] not in ("ribs", "waves"):
        return scale
    c = abs(math.cos(math.radians(float(spec.get("angle", 0.0)))))
    return scale / c if c > 1e-6 else 0.0

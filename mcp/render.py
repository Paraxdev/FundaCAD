"""A picture of the model, drawn without a browser.

An agent that can build geometry but cannot look at it is working blind, and
"looks right" is a question no list of numbers answers. The app's own renderer
is the authority on what a HUMAN sees, but reaching it means a vite server, a
browser binary and a GPU — for a picture. The rebuild reply already carries
triangles and edge polylines, so a z-buffered flat render is a page of numpy,
and it runs on a machine with no display at all.

Deliberately NOT a pretty renderer. It is a shaded solid, a dark outline, an
orthographic camera and a fixed light, because what it has to answer is "is
there a hole where I asked for a hole" and not "is this attractive". Flat
shading is part of that: smooth normals hide facet-sized mistakes, and a facet-
sized mistake in CAD is a mistake.

Pure of the wire, of files and of PIL: everything here is arrays in, array out,
so the whole of it is testable by counting pixels.
"""

import math

import numpy as np

#: Where the light is, in VIEW space (x right, y up, z toward the viewer). Just
#: off the camera axis: dead-on is flat and unreadable, far off leaves half the
#: model in the dark.
LIGHT = np.array([0.35, 0.45, 1.0])
LIGHT = LIGHT / np.linalg.norm(LIGHT)

#: Never fully black. An unlit face still has to show its silhouette against
#: the background and its edges against itself.
AMBIENT = 0.28

BACKGROUND = (24, 27, 32)
EDGE_COLOR = (16, 18, 22)

#: One colour per body, cycled. Distinct in hue rather than in brightness,
#: because brightness is what the shading is already saying.
BODY_COLORS = [
    (158, 176, 196),
    (196, 158, 158),
    (158, 196, 168),
    (196, 188, 148),
    (176, 158, 196),
    (148, 188, 196),
]

#: What a highlighted face is painted. Chosen to survive the shading multiply
#: and to be a hue no body colour uses.
HIGHLIGHT_COLOR = (255, 150, 40)

#: Named directions to look FROM, in world space. Z-up, Y "into the screen" on
#: the front view — the same convention the app's view cube uses.
NAMED_VIEWS = {
    "iso": (1.0, -1.0, 0.8),
    "front": (0.0, -1.0, 0.0),
    "back": (0.0, 1.0, 0.0),
    "left": (-1.0, 0.0, 0.0),
    "right": (1.0, 0.0, 0.0),
    "top": (0.0, 0.0, 1.0),
    "bottom": (0.0, 0.0, -1.0),
}


def direction_for(view=None, azimuth=None, elevation=None):
    """The unit vector to look FROM, from either a name or a pair of angles.

    Angles win when both are given, so a caller can nudge a named view without
    having to work out the vector. Azimuth runs anticlockwise from +X in the XY
    plane and elevation up from it, which is how every CAD turntable states it."""
    if azimuth is not None or elevation is not None:
        az = math.radians(float(azimuth or 0.0))
        el = math.radians(float(elevation or 0.0))
        v = np.array([math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)])
    else:
        v = np.array(NAMED_VIEWS.get((view or "iso").lower(), NAMED_VIEWS["iso"]), dtype=float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else np.array([1.0, -1.0, 0.8]) / math.sqrt(2.64)


def view_basis(direction):
    """The camera's (right, up, back) as a 3x3 whose ROWS take world to view.

    `back` is the direction the camera looks FROM, so a point's view-space z
    grows toward the viewer and the depth test is a plain greater-than.

    World up is +Z; looking straight down it, +Z is no longer a usable
    reference, so the fallback is +Y. Without that a top view degenerates to a
    zero-length cross product and the whole image collapses to one pixel."""
    back = np.asarray(direction, dtype=float)
    back = back / np.linalg.norm(back)
    up_world = np.array([0.0, 0.0, 1.0])
    if abs(float(np.dot(back, up_world))) > 0.999:
        up_world = np.array([0.0, 1.0, 0.0])
    right = np.cross(up_world, back)
    right = right / np.linalg.norm(right)
    up = np.cross(back, right)
    return np.stack([right, up, back])


def fit_scale(pts_view, width, height, margin=0.06):
    """(centre_xy, pixels-per-mm) that puts every point on screen with a border.

    An empty or degenerate set still has to produce a usable camera rather than
    a division by zero, so a zero span falls back to one millimetre."""
    if len(pts_view) == 0:
        return np.zeros(2), 1.0
    lo = pts_view[:, :2].min(axis=0)
    hi = pts_view[:, :2].max(axis=0)
    centre = (lo + hi) / 2.0
    span = np.maximum(hi - lo, 1e-9)
    usable = (1.0 - 2.0 * margin)
    scale = min(width * usable / span[0], height * usable / span[1])
    if not np.isfinite(scale) or scale <= 0:
        scale = 1.0
    return centre, float(scale)


def project(points, basis, centre, scale, width, height):
    """World points -> (x_px, y_px, depth). Screen y runs DOWN, world up runs up,
    hence the negation: getting it wrong flips every render upside down and
    nothing else about the image looks wrong."""
    v = points @ basis.T
    x = (v[:, 0] - centre[0]) * scale + width / 2.0
    y = height / 2.0 - (v[:, 1] - centre[1]) * scale
    return np.stack([x, y, v[:, 2]], axis=1)


def polyline_points(poly):
    """An edge polyline as an (N, 3) array, whatever shape it arrived in.

    The sidecar sends {"points": [...], "body": id}; a test writes a bare list;
    and the points themselves are sometimes flat and sometimes triples. All
    three mean the same thing, and none of them is worth a branch at the call
    site. Returns an empty (0, 3) for anything that is not a polyline."""
    if isinstance(poly, dict):
        poly = poly.get("points")
    a = np.asarray(poly if poly is not None else [], dtype=np.float64).ravel()
    if a.size < 6 or a.size % 3:
        return np.zeros((0, 3))
    return a.reshape(-1, 3)


#: Which way a named section axis points. `at` is then a coordinate on that
#: axis, and "keep" says which side survives.
SECTION_AXES = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}


def section_plane(spec, bbox):
    """(normal, offset) for a section request, or None.

    `spec` is {"axis": "X"|"Y"|"Z"|[x,y,z], "at": mm, "keep": "below"|"above"}.
    `at` defaults to the middle of the model on that axis, which is what somebody
    asking to "cut it in half" means, and is the only default that needs no
    knowledge of where the part happens to sit."""
    if not spec:
        return None
    axis = spec.get("axis", "x")
    if isinstance(axis, str):
        n = np.array(SECTION_AXES.get(axis.lower(), SECTION_AXES["x"]))
    else:
        n = np.asarray(axis, dtype=float)
    ln = np.linalg.norm(n)
    if ln < 1e-12:
        return None
    n = n / ln
    at = spec.get("at")
    if at is None:
        lo, hi = np.asarray(bbox[0], dtype=float), np.asarray(bbox[1], dtype=float)
        at = float(n @ ((lo + hi) / 2.0))
    keep = str(spec.get("keep", "below")).lower()
    # The kept half is always "n . p <= d"; asking to keep the far side just
    # flips the plane, which keeps the clipper down to one case.
    return (-n, -float(at)) if keep in ("above", "over", "+") else (n, float(at))


def clip_triangle(p0, p1, p2, normal, offset):
    """The part of a triangle on the kept side of a plane, as 0, 1 or 2 triangles.

    Sutherland-Hodgman on three vertices. There is no cap: a sectioned solid
    renders hollow, showing its own inside surfaces, which is what makes this
    worth having — the question it answers is "is the thread in there", and a
    capped section would hide exactly that."""
    pts = (p0, p1, p2)
    s = [float(np.dot(normal, p)) - offset for p in pts]
    keep = [v <= 0 for v in s]
    n_keep = sum(keep)
    if n_keep == 3:
        return [(p0, p1, p2)]
    if n_keep == 0:
        return []
    poly = []
    for i in range(3):
        j = (i + 1) % 3
        if keep[i]:
            poly.append(pts[i])
        if keep[i] != keep[j]:
            t = s[i] / (s[i] - s[j])
            poly.append(pts[i] + (pts[j] - pts[i]) * t)
    if len(poly) < 3:
        return []
    return [(poly[0], poly[k], poly[k + 1]) for k in range(1, len(poly) - 1)]


def clip_segment(a, b, normal, offset):
    """The kept part of a line segment, or None."""
    sa = float(np.dot(normal, a)) - offset
    sb = float(np.dot(normal, b)) - offset
    if sa <= 0 and sb <= 0:
        return a, b
    if sa > 0 and sb > 0:
        return None
    t = sa / (sa - sb)
    mid = a + (b - a) * t
    return (a, mid) if sa <= 0 else (mid, b)


class Canvas:
    """A colour buffer and a depth buffer, and the two things that write to them.

    Kept as a class only because the pair must stay in step; there is no state
    here that outlives one image."""

    def __init__(self, width, height, background=BACKGROUND):
        self.w, self.h = int(width), int(height)
        self.color = np.zeros((self.h, self.w, 3), dtype=np.uint8)
        self.color[:, :] = background
        self.depth = np.full((self.h, self.w), -np.inf, dtype=np.float64)

    def triangle(self, p0, p1, p2, rgb):
        """One flat-shaded triangle, depth-tested per pixel.

        Rasterised over the triangle's own pixel bounding box with barycentric
        coordinates, which is a handful of numpy ops on a small window rather
        than a scanline walk in Python. Back-facing and degenerate triangles are
        dropped by the sign test on the edge function, so a closed solid draws
        roughly half its triangles."""
        xs = np.array([p0[0], p1[0], p2[0]])
        ys = np.array([p0[1], p1[1], p2[1]])
        x0 = max(int(np.floor(xs.min())), 0)
        x1 = min(int(np.ceil(xs.max())) + 1, self.w)
        y0 = max(int(np.floor(ys.min())), 0)
        y1 = min(int(np.ceil(ys.max())) + 1, self.h)
        if x1 <= x0 or y1 <= y0:
            return
        area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1])
        if abs(area) < 1e-12:
            return
        gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        w0 = ((p1[0] - p0[0]) * (gy - p0[1]) - (gx - p0[0]) * (p1[1] - p0[1])) / area
        w1 = ((gx - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (gy - p0[1])) / area
        inside = (w0 >= 0) & (w1 >= 0) & (w0 + w1 <= 1)
        if not inside.any():
            return
        depth = p0[2] + w1 * (p1[2] - p0[2]) + w0 * (p2[2] - p0[2])
        sub = self.depth[y0:y1, x0:x1]
        hit = inside & (depth > sub)
        if not hit.any():
            return
        sub[hit] = depth[hit]
        self.color[y0:y1, x0:x1][hit] = rgb

    def line(self, a, b, rgb, bias=0.0):
        """A one-pixel line, depth-tested with a bias toward the viewer.

        The bias is what makes an outline visible at all: an edge polyline lies
        exactly ON the two faces that meet there, so at equal depth it loses the
        test on one of them and the outline comes out dashed. The bias is in
        VIEW-space millimetres, so the caller scales it with the model."""
        n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1]))) + 1
        if n > 4 * (self.w + self.h):
            return  # a line this long is off-screen garbage, not geometry
        t = np.linspace(0.0, 1.0, n)
        x = np.rint(a[0] + (b[0] - a[0]) * t).astype(int)
        y = np.rint(a[1] + (b[1] - a[1]) * t).astype(int)
        z = a[2] + (b[2] - a[2]) * t + bias
        ok = (x >= 0) & (x < self.w) & (y >= 0) & (y < self.h)
        if not ok.any():
            return
        x, y, z = x[ok], y[ok], z[ok]
        pass_ = z >= self.depth[y, x]
        if not pass_.any():
            return
        x, y, z = x[pass_], y[pass_], z[pass_]
        self.depth[y, x] = z
        self.color[y, x] = rgb


#: How much darker the INSIDE of a surface is drawn. Only ever seen through a
#: section, and the whole value of a section is telling inside from outside: with
#: both shaded alike a bore and a boss look identical and the picture answers
#: nothing.
INSIDE = 0.55


def shade(base, normal_view):
    """Lambert against LIGHT, with the normal flipped toward the viewer, and the
    back of a surface drawn darker.

    Flipping is not cheating: a body whose triangle winding disagrees with its
    face normals would otherwise render half black, and the winding is not
    something the caller controls or should have to. But the flip also erases
    the one thing a cutaway is for, so the sign it threw away comes back as the
    INSIDE factor. On a closed solid with no section this changes nothing — a
    back face is never the nearest thing to the camera."""
    n = normal_view
    ln = float(np.linalg.norm(n))
    if ln < 1e-12:
        return base
    n = n / ln
    facing = 1.0 if n[2] >= 0 else INSIDE
    if n[2] < 0:
        n = -n
    k = facing * (AMBIENT + (1.0 - AMBIENT) * max(0.0, float(np.dot(n, LIGHT))))
    return tuple(int(min(255, max(0, c * k))) for c in base)


def model_bounds(meshes):
    """(min, max) over every vertex of every mesh, or None when there are none."""
    lo = hi = None
    for m in meshes:
        pos = np.asarray(m.get("positions") or [], dtype=np.float64)
        if pos.size < 3:
            continue
        pos = pos.reshape(-1, 3)
        a, b = pos.min(axis=0), pos.max(axis=0)
        lo = a if lo is None else np.minimum(lo, a)
        hi = b if hi is None else np.maximum(hi, b)
    return None if lo is None else (lo, hi)


def render(meshes, width=640, height=480, view="iso", azimuth=None, elevation=None,
           highlight=None, draw_edges=True, background=BACKGROUND, section=None,
           bodies=None, focus=None):
    """The image, as an (H, W, 3) uint8 array.

    `meshes` is one dict per body: {"id", "positions": [x,y,z,...],
    "indices": [...], "faceIds": [one per TRIANGLE], "edges": [polyline, ...]}.
    That is exactly the shape the sidecar's rebuild reply hands over, so nothing
    has to be reshaped on the way in.

    `bodies` is a list of ids to draw; everything else is left out. `section`
    cuts the model open (see section_plane). Both exist for the same reason: the
    thing an agent most often needs to see is INSIDE, and a general view of the
    outside of an assembly says nothing about it.

    `focus` is {"at": [x,y,z], "size": mm} and replaces the automatic fit with a
    window that size around that point. A 1.5mm thread on a 200mm spool is four
    pixels of a fitted view: without a way to look closer, "did the thread come
    out" is a question the picture cannot answer however many times it is asked.

    `highlight` is {body_id: {face indices}} — the triangles of those faces are
    painted in HIGHLIGHT_COLOR instead of the body colour, still shaded. It is
    how a caller asks "which one is face 7" and gets an answer it can see.

    The body COLOUR is keyed on a body's position in the full list, not in the
    filtered one, so a body is the same colour whether or not its neighbours are
    being drawn."""
    canvas = Canvas(width, height, background)
    basis = view_basis(direction_for(view, azimuth, elevation))

    wanted = set(bodies) if bodies else None
    drawn = [(bi, m) for bi, m in enumerate(meshes)
             if wanted is None or m.get("id") in wanted]
    if not drawn:
        return canvas.color

    plane = section_plane(section, model_bounds([m for _, m in drawn])) if section else None

    # Every triangle that will actually be drawn, in world space, with the body
    # it came from and the colour it wants. Built up front because the camera
    # has to be fitted to what SURVIVES the section, not to what was sent: a
    # cutaway fitted to the whole model wastes half the frame on empty space.
    tris = []
    segs = []
    for bi, m in drawn:
        pos = np.asarray(m.get("positions") or [], dtype=np.float64)
        if pos.size < 9:
            continue
        pos = pos.reshape(-1, 3)
        idx = np.asarray(m.get("indices") or [], dtype=np.int64).reshape(-1, 3)
        face_ids = m.get("faceIds") or []
        want = (highlight or {}).get(m.get("id"))
        base = BODY_COLORS[bi % len(BODY_COLORS)]
        for t in range(len(idx)):
            a, b, c = idx[t]
            colour = base
            if want and t < len(face_ids) and face_ids[t] in want:
                colour = HIGHLIGHT_COLOR
            if plane is None:
                tris.append((pos[a], pos[b], pos[c], colour))
            else:
                for p0, p1, p2 in clip_triangle(pos[a], pos[b], pos[c], *plane):
                    tris.append((p0, p1, p2, colour))
        if draw_edges:
            for poly in (m.get("edges") or []):
                pts = polyline_points(poly)
                for k in range(len(pts) - 1):
                    if plane is None:
                        segs.append((pts[k], pts[k + 1]))
                    else:
                        cut = clip_segment(pts[k], pts[k + 1], *plane)
                        if cut is not None:
                            segs.append(cut)

    pool = [v for t in tris for v in t[:3]] + [v for sgm in segs for v in sgm]
    if not pool:
        return canvas.color
    stacked = np.asarray(pool) @ basis.T
    if focus and focus.get("at") is not None:
        at = np.asarray(focus["at"], dtype=float) @ basis.T
        size = float(focus.get("size") or 10.0)
        centre = at[:2]
        scale = min(width, height) / max(size, 1e-6)
    else:
        centre, scale = fit_scale(stacked, width, height)
    # The outline bias is a fixed fraction of the model's own depth range, so it
    # is the same visual nudge on a 2mm part and a 2m one.
    span_z = float(stacked[:, 2].max() - stacked[:, 2].min()) or 1.0
    bias = span_z * 1e-3

    for p0, p1, p2, colour in tris:
        world = np.stack([p0, p1, p2])
        v = world @ basis.T
        scr = project(world, basis, centre, scale, width, height)
        n = np.cross(v[1] - v[0], v[2] - v[0])
        canvas.triangle(scr[0], scr[1], scr[2], shade(colour, n))

    for a, b in segs:
        scr = project(np.stack([a, b]), basis, centre, scale, width, height)
        canvas.line(scr[0], scr[1], EDGE_COLOR, bias)
    return canvas.color

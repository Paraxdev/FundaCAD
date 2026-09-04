"""Turning a report into something worth reading.

The `inspect` reply is a few hundred kilobytes of exact numbers. Handed over
whole it costs an agent most of its context to learn that a box is a box, so
this is the summary layer: what the model IS, in a few dozen lines, with the
full detail available on request for the one body that turned out to matter.

Every line here is derived, none of it is measured — that is the point of
keeping it separate from inspect_model.py, which does the measuring and knows
nothing about how anyone wants to read it.
"""


def _fmt(x, places=3):
    if x is None:
        return "?"
    if isinstance(x, (list, tuple)):
        return ", ".join(_fmt(v, places) for v in x)
    v = round(float(x), places)
    return f"{v:g}"


def surface_census(body):
    """{surface type: how many}, biggest group first. The shape of a body in one
    line: "6 plane" is a box, "1 cylinder, 2 plane" is a rod, and anything with a
    bspline in it came from a loft or an import."""
    counts = {}
    for f in body.get("faces") or []:
        counts[f.get("surface") or "?"] = counts.get(f.get("surface") or "?", 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))


def body_line(body):
    if body.get("empty"):
        return f"{body['id']} ({body.get('name')}): did not build"
    bb = body.get("bbox") or {}
    size = bb.get("size")
    bits = [f"{body['id']} \"{body.get('name')}\""]
    if size:
        bits.append(f"{_fmt(size[0])} x {_fmt(size[1])} x {_fmt(size[2])} mm")
    if body.get("volume") is not None:
        bits.append(f"vol {_fmt(body['volume'], 1)} mm3")
    bits.append(f"{body.get('faceCount')} faces, {body.get('edgeCount')} edges")
    if (body.get("solidCount") or 1) > 1:
        bits.append(f"{body['solidCount']} disjoint solids")
    census = surface_census(body)
    if census:
        bits.append(", ".join(f"{n} {k}" for k, n in census.items()))
    return " | ".join(bits)


def warnings_for(body):
    """The things about a body that will bite a LATER feature.

    Not errors — every one of these is a perfectly valid solid. They are listed
    because each one is a refusal waiting to happen: a seam edge cannot be
    filleted, a wrapping face has no single direction to be pushed in, and a
    body that is several disjoint solids will surprise anything that assumes
    one."""
    out = []
    seams = [e for e in (body.get("edges") or []) if e.get("seam")]
    if seams:
        out.append(f"{len(seams)} seam edge(s) ({', '.join('E' + str(e['i']) for e in seams[:6])}"
                   f"{'...' if len(seams) > 6 else ''}) — a fillet or chamfer on one of these "
                   "will be refused: both sides are the same face")
    wrapping = [f for f in (body.get("faces") or []) if f.get("wraps")]
    if wrapping:
        out.append(f"{len(wrapping)} face(s) wrap all the way round "
                   f"({', '.join('F' + str(f['i']) for f in wrapping[:6])}"
                   f"{'...' if len(wrapping) > 6 else ''}) — press/pull thickens these along "
                   "the surface rather than pushing them in a direction")
    open_edges = [e for e in (body.get("edges") or []) if e.get("openBoundary")]
    if open_edges:
        out.append(f"{len(open_edges)} edge(s) bound only ONE face — this body is a surface, "
                   "not a closed solid")
    if (body.get("solidCount") or 1) > 1:
        out.append(f"this body is {body['solidCount']} solids that do not touch")
    if body.get("truncated"):
        t = body["truncated"]
        out.append(f"the report was truncated: {t.get('faces', 0)} more faces, "
                   f"{t.get('edges', 0)} more edges. Ask for one body at a time.")
    return out


def face_line(f):
    bits = [f"F{f['i']} {f.get('surface')}", f"area {_fmt(f.get('area'), 2)}"]
    if f.get("radius") is not None:
        bits.append(f"r {_fmt(f['radius'])}")
    if f.get("point"):
        bits.append(f"at ({_fmt(f['point'])})")
    bits.append(f"normal ({_fmt(f.get('normal'))})")
    if f.get("wraps"):
        bits.append("WRAPS")
    return "  " + " | ".join(bits)


def edge_line(e):
    bits = [f"E{e['i']} {e.get('curve')}", f"len {_fmt(e.get('length'), 2)}"]
    if e.get("radius") is not None:
        bits.append(f"r {_fmt(e['radius'])}")
    bits.append(f"mid ({_fmt(e.get('mid'))})")
    bits.append(f"between F{e['faces'][0]}" + (f" and F{e['faces'][1]}"
                                               if len(e.get("faces") or []) > 1 else ""))
    if e.get("seam"):
        bits.append("SEAM")
    if e.get("openBoundary"):
        bits.append("OPEN")
    return "  " + " | ".join(bits)


def describe(report, detail=False):
    """The whole report as text. `detail` adds the per-face and per-edge lines,
    which is what a caller asks for once it knows which body it cares about."""
    lines = []
    bodies = report.get("bodies") or []
    if not bodies:
        lines.append("No bodies. The document built nothing.")
    for b in bodies:
        lines.append(body_line(b))
        for w in warnings_for(b):
            lines.append("  ! " + w)
        if detail and not b.get("empty"):
            lines.append("  faces:")
            lines.extend(face_line(f) for f in (b.get("faces") or []))
            lines.append("  edges:")
            lines.extend(edge_line(e) for e in (b.get("edges") or []))
    for e in report.get("errors") or []:
        where = f" (feature {e['feature_id']})" if e.get("feature_id") else ""
        lines.append(f"ERROR{where}: {e.get('message')}")
    return "\n".join(lines)

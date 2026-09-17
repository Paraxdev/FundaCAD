"""Checking a fastener spec and bringing it to millimetres.

The required fields come from catalogue/fields.json, the same file the window's form and its
check (spec.ts) read. `sanity` mirrors spec.ts `sanityProblems`.
"""

import json
import math
import os

_FIELDS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "catalogue", "fields.json")

with open(_FIELDS_PATH, encoding="utf-8") as _fh:
    FIELDS = json.load(_fh)

KINDS = FIELDS["kinds"]
PARTS = FIELDS["parts"]
PART_LABELS = {
    "head": "head", "drive": "drive", "point": "point", "shoulder": "shoulder", "thread": "thread",
    "nut": "nut", "washer": "washer", "insert": "insert",
}
INCH = 25.4


class SpecError(ValueError):
    pass


def _get(obj, path):
    cur = obj
    for k in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _positive(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def field_phrase(part_name, label):
    text = label.lower()
    return text if PART_LABELS[part_name] in text else f"{PART_LABELS[part_name]} {text}"


def missing_fields(spec):
    if not isinstance(spec, dict):
        return ["the whole spec"]
    kind = KINDS.get(spec.get("kind"))
    if kind is None:
        return ["the fastener kind"]
    out = []
    if spec.get("units") not in FIELDS["units"]:
        out.append("the units (mm or in)")
    if not str(spec.get("name") or "").strip():
        out.append("a name")
    for part_name in kind["parts"]:
        part = spec.get(part_name)
        types = PARTS[part_name]
        if not isinstance(part, dict) or part.get("type") not in types:
            out.append(f"{PART_LABELS[part_name]} type")
            continue
        for field, label in types[part["type"]]["fields"]:
            if not _positive(part.get(field)):
                out.append(field_phrase(part_name, label))
    for path, label in kind["fields"]:
        if not _positive(_get(spec, path)):
            out.append(label.lower())
    thread = spec.get("thread")
    if isinstance(thread, dict) and thread.get("hand") not in (None, *FIELDS["hands"]):
        out.append("thread hand (right or left)")
    return out


def _n(v):
    return float(v) if _positive(v) else float("nan")


def sanity(spec):
    out = []
    t = spec.get("thread") or {}
    d = _n(t.get("diameter"))
    head = spec.get("head")
    drive = spec.get("drive")
    kind = spec["kind"]
    if t and not (_n(t.get("pitch")) * 0.6134 < d / 2 * 0.8):
        out.append("the pitch is too coarse for the thread diameter")
    if kind in ("screw", "shoulderScrew"):
        length = _n(spec.get("length"))
        shank = _n((spec.get("shoulder") or {}).get("diameter")) if kind == "shoulderScrew" else d
        if kind == "shoulderScrew" and not shank > d:
            out.append("the shoulder must be wider than the thread")
        htype = head["type"]
        across = _n(head.get("acrossFlats")) if htype in ("hex", "hexFlange") else _n(head.get("diameter"))
        if htype != "none" and not across > shank:
            out.append("the head must be wider than the shank")
        if htype == "hexFlange":
            if not _n(head["flangeDiameter"]) > _n(head["acrossFlats"]):
                out.append("the flange must be wider than the hex")
            if not _n(head["flangeThickness"]) < _n(head["height"]):
                out.append("the flange must be thinner than the head")
        if htype == "knurled":
            if not (shank < _n(head["collarDiameter"]) <= _n(head["diameter"])):
                out.append("the collar must be wider than the shank and no wider than the knurl")
            if not _n(head["collarHeight"]) < _n(head["height"]):
                out.append("the collar must be lower than the head")
        sunk = _n(head["height"]) if htype == "countersunk" else 0.0
        if sunk and not sunk < length:
            out.append("the countersunk head must be shorter than the overall length")
        if kind == "screw" and _n(t.get("length")) > length - sunk + 1e-9:
            out.append("the thread cannot be longer than the shank")
        if drive["type"] != "none":
            size = _n(drive["size"])
            room = across if htype != "none" else d
            reach = size * 1.1547 if drive["type"] == "hex" else size * 1.4142 if drive["type"] == "square" else size
            fits = size < room / 2 if drive["type"] == "slot" else reach < room
            if not fits:
                out.append("the drive does not fit in the head")
            allowed = _n(head.get("height")) + d / 2 if htype != "none" else length * 0.6
            if not _n(drive["depth"]) < allowed:
                out.append("the drive recess is too deep")
        point = spec.get("point") or {}
        if point.get("type") in ("flat", "cup") and not _n(point.get("diameter")) < d:
            out.append("the point diameter must be smaller than the thread")
    if kind == "nut":
        nut = spec["nut"]
        if not _n(nut["acrossFlats"]) > d * 1.05:
            out.append("the nut must be wider than its thread")
        if nut["type"] == "nyloc" and not _n(nut["hexHeight"]) < _n(nut["height"]):
            out.append("the hex must be lower than the whole nut")
        if nut["type"] == "flange":
            if not _n(nut["flangeDiameter"]) > _n(nut["acrossFlats"]):
                out.append("the flange must be wider than the hex")
            if not _n(nut["flangeThickness"]) < _n(nut["height"]):
                out.append("the flange must be thinner than the nut")
    if kind == "washer":
        w = spec["washer"]
        if not _n(w["outer"]) > _n(w["inner"]):
            out.append("the outer diameter must be larger than the inner")
    if kind == "insert":
        if not _n(spec["insert"]["outer"]) > d * 1.1:
            out.append("the insert must be wider than its thread")
    return out


_LENGTH_KEYS = {
    "diameter", "height", "acrossFlats", "flangeDiameter", "flangeThickness", "collarDiameter",
    "collarHeight", "size", "depth", "pitch", "length", "hexHeight", "inner", "outer", "thickness",
}


def _to_mm(part, scale):
    out = dict(part)
    for k, v in part.items():
        if k in _LENGTH_KEYS and _positive(v):
            out[k] = float(v) * scale
    return out


def checked(spec):
    """The spec in millimetres, or SpecError naming everything that is wrong with it."""
    missing = missing_fields(spec)
    if missing:
        raise SpecError("Fastener: missing " + ", ".join(missing))
    problems = sanity(spec)
    if problems:
        raise SpecError("Fastener: " + "; ".join(problems))
    scale = INCH if spec["units"] == "in" else 1.0
    out = {"kind": spec["kind"], "name": spec["name"]}
    if _positive(spec.get("length")):
        out["length"] = float(spec["length"]) * scale
    for part_name in KINDS[spec["kind"]]["parts"]:
        out[part_name] = _to_mm(spec[part_name], scale)
    thread = out.get("thread")
    if thread is not None:
        thread["hand"] = thread.get("hand") or "right"
        thread["modelled"] = bool(thread.get("modelled"))
    return out

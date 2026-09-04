"""The document an agent is editing: features, parameters, and the edits to both.

A FundaCAD document is a declarative feature list plus a parameter table, and
nothing here knows how to build it — that is the sidecar's job. What lives here
is everything that has to be true BEFORE a rebuild is worth asking for: ids are
unique, a feature that references a sketch references one that exists, a
parameter table has no cycle in it.

Deliberately all pure functions over plain dicts. The MCP server holds one
document and mutates it; a test holds three and does not, and both run exactly
this code.

Parameters are the reason this is more than a list. `doc["paramDefs"]` is the
source of truth (name -> {expr, value, unit}) and `doc["parameters"]` is the
derived name -> number cache the SIDECAR reads — the sidecar has no expression
evaluator and never will, so the cache is not an optimisation, it is the
interface. Writing one without the other is how a document builds at the old
value after an edit that looked like it landed.
"""

import re

from expr import CONSTANTS, ExprError, eval_node, is_reserved_name, parse_expr, refs_of

#: PI resolves without anyone defining it, so it is never an unknown reference.
CONST_NAMES = frozenset(CONSTANTS)

FORMAT_VERSION = 9


def new_document():
    return {"version": FORMAT_VERSION, "parameters": {}, "paramDefs": {}, "features": []}


def feature_ids(doc):
    return [f.get("id") for f in doc.get("features", [])]


def find_feature(doc, fid):
    for i, f in enumerate(doc.get("features", [])):
        if f.get("id") == fid:
            return i, f
    return -1, None


def next_id(doc, prefix):
    """`prefix` + the lowest free number. Ids are the ONLY way a later feature
    names an earlier one, so they have to be unique across the whole document
    and stable across edits — never positional."""
    used = set(feature_ids(doc))
    n = 1
    while f"{prefix}{n}" in used:
        n += 1
    return f"{prefix}{n}"


class DocumentError(ValueError):
    """An edit that would leave the document unbuildable. Raised BEFORE anything
    is written, so a refused edit changes nothing."""


_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def add_feature(doc, feature, at=None):
    """Append (or insert at `at`) one feature, returning its id.

    Order is the timeline: a feature can only reference what is ABOVE it, so an
    insert in the middle is a real operation and not a convenience."""
    if not isinstance(feature, dict) or not feature.get("type"):
        raise DocumentError("a feature needs a `type`")
    f = dict(feature)
    fid = f.get("id")
    if fid is None:
        fid = next_id(doc, _prefix_for(f["type"]))
        f["id"] = fid
    elif not _ID_RE.match(str(fid)):
        raise DocumentError(f"bad feature id {fid!r}: letters, digits and _ only")
    elif fid in feature_ids(doc):
        raise DocumentError(f"feature id {fid!r} is already used")
    feats = doc.setdefault("features", [])
    if at is None or at >= len(feats):
        feats.append(f)
    else:
        feats.insert(max(0, int(at)), f)
    return fid


_PREFIXES = {
    "sketch": "sk", "extrude": "ex", "revolve": "rev", "fillet": "fil",
    "chamfer": "cha", "press-pull": "pp", "box": "bx", "cylinder": "cy",
    "sphere": "sp", "shell": "sh", "boolean": "bo", "mirror": "mir",
    "loft": "lo", "sweep": "sw", "datumPlane": "pl", "move": "mv",
    "patternCircular": "pc", "patternLinear": "pln", "split": "spl",
}


def _prefix_for(kind):
    return _PREFIXES.get(kind, "f")


def update_feature(doc, fid, patch, replace=False):
    """Merge `patch` into a feature (or replace its body wholesale).

    A merge cannot remove a field, which matters: `upTo` on a press/pull and
    `axisEdge` on a revolve are both fields whose PRESENCE changes what the
    feature means. `replace=True` is how they come off. A None in a merge patch
    deletes that key, for the same reason."""
    i, f = find_feature(doc, fid)
    if f is None:
        raise DocumentError(f"no feature {fid!r} — have {feature_ids(doc)}")
    if replace:
        out = dict(patch)
        out["id"] = fid
        out.setdefault("type", f.get("type"))
    else:
        out = dict(f)
        for k, v in patch.items():
            if v is None:
                out.pop(k, None)
            else:
                out[k] = v
        out["id"] = fid
    doc["features"][i] = out
    return out


def remove_feature(doc, fid):
    i, f = find_feature(doc, fid)
    if f is None:
        raise DocumentError(f"no feature {fid!r} — have {feature_ids(doc)}")
    doc["features"].pop(i)
    return f


def move_feature(doc, fid, to):
    i, f = find_feature(doc, fid)
    if f is None:
        raise DocumentError(f"no feature {fid!r} — have {feature_ids(doc)}")
    feats = doc["features"]
    feats.pop(i)
    feats.insert(max(0, min(int(to), len(feats))), f)
    return f


# --- parameters ---------------------------------------------------------------


def set_parameter(doc, name, expr, unit="mm", comment=None):
    """Define or redefine one parameter and recompute the whole table.

    `expr` may be a number or a string; both are stored as the string the user
    (or agent) wrote, because that string is the parametric part — storing 12.5
    where `hub_d/2` was meant severs the link the moment hub_d changes."""
    if not _ID_RE.match(str(name)):
        raise DocumentError(f"bad parameter name {name!r}")
    if is_reserved_name(name):
        raise DocumentError(f"{name!r} is a reserved name (a function, unit or constant)")
    defs = doc.setdefault("paramDefs", {})
    before = defs.get(name)
    defs[name] = {"expr": str(expr), "value": 0.0, "unit": unit}
    if comment:
        defs[name]["comment"] = comment
    issues = recompute_parameters(doc)
    if name in issues:
        # Put the table back exactly as it was: a refused edit that left a
        # broken definition behind would break every LATER edit too.
        if before is None:
            defs.pop(name, None)
        else:
            defs[name] = before
        recompute_parameters(doc)
        raise DocumentError(f"{name} = {expr!r}: {issues[name]}")
    return defs[name]


def remove_parameter(doc, name):
    defs = doc.setdefault("paramDefs", {})
    if name not in defs:
        raise DocumentError(f"no parameter {name!r} — have {sorted(defs)}")
    users = [n for n, d in defs.items()
             if n != name and name in _safe_refs(d.get("expr"))]
    if users:
        raise DocumentError(f"{name} is used by {', '.join(sorted(users))}")
    defs.pop(name)
    recompute_parameters(doc)


def _safe_refs(src):
    try:
        return refs_of(parse_expr(src))
    except ExprError:
        return set()


def recompute_parameters(doc):
    """Evaluate every definition in dependency order, write the derived cache,
    and return {name: why} for the ones that could not be evaluated.

    Resolution is iterative rather than a topological sort on purpose: what is
    left over when no further definition can be resolved IS the cycle, so
    cycle detection costs nothing extra and names every member of it.

    A broken definition keeps its last good value in the cache. That is the
    frontend's rule and it matters for the same reason: a document that is being
    edited passes through states where one parameter is momentarily unresolvable,
    and dropping its value there would take the geometry down with it."""
    defs = doc.setdefault("paramDefs", {})
    cache = {}
    issues = {}
    nodes = {}
    for name, d in defs.items():
        try:
            nodes[name] = parse_expr(d.get("expr", ""))
        except ExprError as ex:
            nodes[name] = None
            issues[name] = str(ex)

    pending = {n for n, node in nodes.items() if node is not None}
    while pending:
        progressed = False
        for name in sorted(pending):
            node = nodes[name]
            if not refs_of(node) <= set(cache) | set(CONST_NAMES):
                continue
            try:
                v = eval_node(node, cache)
            except ExprError as ex:
                issues[name] = str(ex)
                pending.discard(name)
                progressed = True
                break
            if v != v or v in (float("inf"), float("-inf")):
                issues[name] = "does not evaluate to a finite number"
            else:
                cache[name] = v
                defs[name]["value"] = v
            pending.discard(name)
            progressed = True
            break
        if not progressed:
            for name in sorted(pending):
                unknown = refs_of(nodes[name]) - set(defs) - set(CONST_NAMES)
                issues[name] = (f"unknown parameter {', '.join(sorted(unknown))}"
                                if unknown else "is part of a reference cycle")
            break

    # Broken definitions keep their last value, so the cache the sidecar reads
    # is always complete.
    for name, d in defs.items():
        cache.setdefault(name, float(d.get("value") or 0.0))
    doc["parameters"] = {k: cache[k] for k in sorted(cache)}
    return issues


# --- validation ---------------------------------------------------------------

#: A feature field naming another feature, and what it must name.
_REFERENCE_FIELDS = {
    "extrude": [("sketch", "sketch")],
    "revolve": [("sketch", "sketch")],
    "sweep": [("profile", "sketch"), ("path", "sketch")],
    "loft": [("sketches", "sketch")],
}


def validate(doc):
    """Everything wrong with the document that can be seen without building it.

    Returns a list of plain strings. It is not a gate — the caller may build a
    document with problems and see what the kernel says — but every entry here
    is a rebuild error that would arrive later with less context."""
    problems = []
    feats = doc.get("features", [])
    seen = set()
    by_id = {}
    for i, f in enumerate(feats):
        fid = f.get("id")
        if not fid:
            problems.append(f"feature #{i} ({f.get('type')}) has no id")
            continue
        if fid in seen:
            problems.append(f"duplicate feature id {fid!r}")
        seen.add(fid)
        by_id[fid] = i
        if not f.get("type"):
            problems.append(f"feature {fid!r} has no type")

    for i, f in enumerate(feats):
        for field, want in _REFERENCE_FIELDS.get(f.get("type"), []):
            val = f.get(field)
            if val is None:
                continue
            for ref in (val if isinstance(val, list) else [val]):
                name = ref.get("sketch") if isinstance(ref, dict) else ref
                if name is None:
                    continue
                j = by_id.get(name)
                if j is None:
                    problems.append(
                        f"{f.get('id')}: {field} names {name!r}, which is not in the document")
                elif j > i:
                    problems.append(
                        f"{f.get('id')}: {field} names {name!r}, which comes AFTER it in the "
                        "timeline (a feature can only use what is above it)")
                elif feats[j].get("type") != want:
                    problems.append(
                        f"{f.get('id')}: {field} names {name!r}, which is a "
                        f"{feats[j].get('type')} and not a {want}")

    for name, why in recompute_parameters(doc).items():
        problems.append(f"parameter {name}: {why}")

    # A string in a numeric field must name a parameter: the sidecar resolves
    # names against doc["parameters"] and raises on anything else, which arrives
    # as a red feature with no clue which field caused it.
    params = set(doc.get("parameters") or {})
    for f in feats:
        for k, v in f.items():
            if isinstance(v, str) and k not in ("id", "type", "name", "operation",
                                                "sketch", "profile", "path", "body",
                                                "target", "keep", "axis", "text",
                                                "planeId", "plane", "format"):
                if v in params:
                    continue
                # An EXPRESSION in a feature field is the mistake worth naming
                # separately, because it looks like it ought to work. The app
                # evaluates expressions in the parameter table and writes plain
                # numbers into fields, so the sidecar only ever resolves a bare
                # NAME; "d/2" reaches it as an unresolved string and the error
                # it raises names the string rather than the rule.
                try:
                    refs = refs_of(parse_expr(v))
                except ExprError:
                    refs = set()
                if refs and refs <= params:
                    problems.append(
                        f"{f.get('id')}: {k} is the expression {v!r}. A field takes a "
                        "number or a parameter NAME, never an expression — define a "
                        f"parameter for it (param_set) and put its name in {k}.")
                else:
                    problems.append(
                        f"{f.get('id')}: {k} is the string {v!r}, which is not a "
                        f"parameter — known parameters are {sorted(params) or 'none'}")
    return problems

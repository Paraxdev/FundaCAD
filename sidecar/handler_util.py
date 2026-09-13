"""Helpers every feature handler shares: merging a new solid into the model, and refusing bad inputs by name."""

import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py
from booleans import _boolean_into_bodies


def _combine(f, ctx, solid, hidden=None, name=None):
    """Merge a solid a feature just made into the model, the way `f` asks.

    The one place `operation` and `targets` are read, so the two of them mean
    the same thing on every feature that creates material rather than on five
    out of six of them. `name` is the label a primitive wants to keep on the
    body it makes; a join takes the name of the body it merges into instead,
    which is why it is passed here and not at the call.
    """
    def new_body(shape, body_name=None, inherit=None):
        return ctx.new_body(shape, body_name or name, inherit=inherit)

    _boolean_into_bodies(
        ctx.bodies, solid, f.get("operation", "new"), new_body,
        ctx.hidden_bodies if hidden is None else hidden,
        targets=f.get("targets"),
        diag=ctx.diagnostics, feature_id=f.get("id"),
    )


def _require_positive(op, **dims):
    """Reject a non-positive dimension BY NAME, before OCCT ever sees it.

    OCCT answers a zero-height box with `Standard_DomainError` and a zero-factor
    scale with `Standard_ConstructionError`. Those class names reach the user as
    the WHOLE explanation and say nothing about what to change, measured across
    seven operations in docs/EDGE-CASES.md. Every one of them is a predictable
    degenerate input, so name the field and the value the user actually typed.
    """
    for name, v in dims.items():
        if v is None:
            continue
        if not (v > 0):
            raise ValueError(f"{op}: {name} must be greater than 0 (got {v:g})")


def _require_sketch(ctx, sid, op):
    """Fetch a sketch entry, or explain WHICH upstream sketch failed.

    A missing sketch is almost always an UPSTREAM failure, not a broken
    reference: the sketch feature raised (bad profile, zero-radius circle,
    non-planar wires) and so never registered. Indexing `ctx.sketches` raw turned
    that into `KeyError: 'f1'`, which the generic handler surfaced as
    "<op> failed (KeyError)", burying the real cause behind an internal error
    and pointing the user at the wrong feature.

    Extracted after finding the same fault in FOUR handlers (extrude, revolve,
    loft, sweep); each had its own raw lookup. Route every sketch fetch here.
    """
    entry = ctx.sketches.get(sid)
    if entry is None:
        raise ValueError(
            f"the sketch this {op} depends on ({sid}) did not build, "
            "fix that sketch first"
        )
    return entry


def _make_val(params):
    """A value resolver over one document's parameter table: a parameter name
    resolves to its value; a numeric literal passes through.

    Any other string is a hard error: the frontend evaluates expressions and
    ships plain numbers, so an unresolved string here would otherwise leak
    into OCCT as garbage (crash or silent junk geometry). In rebuild() the
    raise is caught by the per-feature error handler -> red chip, build
    continues; project_geometry surfaces it as a per-source error entry."""

    def val(x):
        if isinstance(x, str):
            if x in params:
                return params[x]
            raise ValueError(
                f'unresolved parameter or expression "{x}", expected a number '
                f"(expressions are evaluated by the app before building)"
            )
        return x

    return val

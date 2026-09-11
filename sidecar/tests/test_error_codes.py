"""A build failure carries a machine `code` when the failure is one the UI can
act on, and carries none when it is an ordinary refusal.

The frontend used to tell "re-pick this reference" apart from "this operation is
impossible" only by matching the human message, which drifts every time a
sentence is reworded. errors.py gives the reference-category refusals a stable
`code` (the same lowerCamel strings a ResolveDiag already carries), the build
loop threads `getattr(ex, "code", None)` onto the error dict, and the server
projects it onto featureErrors[].code. This pins the whole chain: the source
attaches the code, and it survives to the wire shape.

CONTROLS, so this cannot pass by always reporting a code: an impossible-but-
well-formed operation (a fillet radius larger than the face) still comes back
with NO code, and a clean build reports no error at all.

Run: uv run python tests/test_error_codes.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

from geom_select import _nearest_one
from errors import GeomError, AMBIGUOUS_REFERENCE, REFERENCE_NOT_FOUND

# Reuse the proven two-body document and its selector helpers, so the failures
# here travel the exact builder path that feeds featureErrors, not a stub.
from test_body_binding import build, edge_sel, B1_CORNER, B2_CORNER, BASE

PASS = "  ok"


def _wire(e):
    """The wire projection server._err_wire performs, inlined so this test does
    not import the websocket server: keep `code` only when the refusal set one."""
    w = {"message": e["message"], "feature_id": e.get("feature_id")}
    if e.get("code"):
        w["code"] = e["code"]
    return w


def test_an_ambiguous_reference_reaches_the_wire_with_its_code():
    """An unbound cross-body edge selector is a genuine tie (test_body_binding
    pins the refusal itself). The build error it produces must now carry
    code=ambiguousReference, and it must survive the wire projection."""
    _vols, errors = build({"id": "c1", "type": "chamfer", "distance": 1.0,
                           "edges": edge_sel(B1_CORNER)})
    assert errors, "the ambiguous selector should have failed the feature"
    assert errors[0].get("code") == AMBIGUOUS_REFERENCE, errors[0]
    assert _wire(errors[0]).get("code") == "ambiguousReference", _wire(errors[0])
    print(PASS, "an ambiguous reference reaches featureErrors with its code")


def test_an_ordinary_refusal_carries_no_code():
    """CONTROL: a fillet radius larger than body2's 6mm faces is impossible, but
    it is not a reference the user can re-pick, so it must reach the wire with NO
    code. A code on this would send the frontend offering a re-pick that fixes
    nothing."""
    _vols, errors = build({"id": "f1", "type": "fillet", "radius": 7.0,
                           "edges": [edge_sel(B1_CORNER, "body1"),
                                     edge_sel(B2_CORNER, "body2")]})
    assert errors, "precondition: the impossible fillet must fail"
    assert errors[0].get("code") is None, errors[0]
    assert "code" not in _wire(errors[0]), _wire(errors[0])
    print(PASS, "an ordinary impossible operation carries no code")


def test_a_clean_build_reports_no_error_at_all():
    """CONTROL: the base document builds; there is nothing to code."""
    vols, errors = build()
    assert errors == [], errors
    assert vols == BASE, (vols, BASE)
    print(PASS, "a clean build reports no error and no code")


def test_the_code_is_attached_at_the_source_not_the_loop():
    """Lock the source contract: geom_select raises a GeomError carrying the
    code, so reverting it to a plain ValueError fails HERE even if the build
    loop still reads getattr(ex, 'code'). An empty candidate set is the
    referenceNotFound path (unreachable through a normal body, which always has
    edges, so exercised directly)."""
    try:
        _nearest_one([], lambda c: 0.0, lambda c: c, str, "edge",
                     {"point": [0, 0, 0]}, None, None)
    except GeomError as ex:
        assert getattr(ex, "code", None) == REFERENCE_NOT_FOUND, ex.code
        print(PASS, "an empty candidate set raises GeomError(referenceNotFound)")
        return
    raise AssertionError("an empty candidate set did not raise a coded GeomError")


def main():
    test_an_ambiguous_reference_reaches_the_wire_with_its_code()
    test_an_ordinary_refusal_carries_no_code()
    test_a_clean_build_reports_no_error_at_all()
    test_the_code_is_attached_at_the_source_not_the_loop()
    print("ALL PASS")


if __name__ == "__main__":
    main()

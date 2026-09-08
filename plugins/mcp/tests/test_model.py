"""The document an agent edits: ids, the timeline, and the parameter table.

The property worth the most here is that a REFUSED edit changes nothing. An
agent works by trying things, and a tool that half-applies a bad edit leaves it
debugging a document it did not write.

Run: uv run python mcp/tests/test_model.py
"""

import _bootstrap  # noqa: F401
import _run

import model as M


def doc_with(*features):
    d = M.new_document()
    for f in features:
        M.add_feature(d, f)
    return d


# --- the timeline -------------------------------------------------------------


def test_ids_are_assigned_by_type_and_are_unique():
    d = doc_with({"type": "box", "length": 1, "width": 1, "height": 1},
                 {"type": "box", "length": 2, "width": 2, "height": 2},
                 {"type": "fillet", "edges": [], "radius": 1})
    assert M.feature_ids(d) == ["bx1", "bx2", "fil1"], M.feature_ids(d)


def test_an_explicit_id_is_kept_and_a_duplicate_is_refused():
    d = doc_with({"id": "hub", "type": "cylinder", "radius": 1, "height": 1})
    assert M.feature_ids(d) == ["hub"]
    try:
        M.add_feature(d, {"id": "hub", "type": "box", "length": 1, "width": 1, "height": 1})
    except M.DocumentError:
        assert M.feature_ids(d) == ["hub"], "the refused add still changed the document"
        return
    raise AssertionError("a duplicate id was accepted")


def test_insert_and_move_put_a_feature_where_asked():
    d = doc_with({"id": "a", "type": "box", "length": 1, "width": 1, "height": 1},
                 {"id": "c", "type": "box", "length": 1, "width": 1, "height": 1})
    M.add_feature(d, {"id": "b", "type": "box", "length": 1, "width": 1, "height": 1}, at=1)
    assert M.feature_ids(d) == ["a", "b", "c"]
    M.move_feature(d, "b", 2)
    assert M.feature_ids(d) == ["a", "c", "b"]


def test_a_patch_merges_and_a_null_removes():
    d = doc_with({"id": "pp", "type": "press-pull", "face": {}, "distance": 2,
                  "operation": "join", "upTo": {"kind": "face"}})
    M.update_feature(d, "pp", {"distance": 5})
    assert d["features"][0]["distance"] == 5
    assert "upTo" in d["features"][0], "a merge must not drop fields it was not given"
    M.update_feature(d, "pp", {"upTo": None})
    assert "upTo" not in d["features"][0], "a null in a patch has to remove the field"


def test_replace_swaps_the_body_but_keeps_the_id():
    d = doc_with({"id": "pp", "type": "press-pull", "face": {}, "distance": 2,
                  "operation": "join", "upTo": {"kind": "face"}})
    M.update_feature(d, "pp", {"type": "press-pull", "face": {}, "distance": 1,
                               "operation": "cut"}, replace=True)
    f = d["features"][0]
    assert f["id"] == "pp" and "upTo" not in f and f["operation"] == "cut"


# --- parameters ---------------------------------------------------------------


def test_a_parameter_table_evaluates_in_dependency_order():
    d = M.new_document()
    M.set_parameter(d, "hub_d", 54)
    M.set_parameter(d, "wall", 2.4)
    M.set_parameter(d, "hub_r", "hub_d/2 - wall")
    assert d["parameters"] == {"hub_d": 54.0, "hub_r": 24.6, "wall": 2.4}, d["parameters"]


def test_the_derived_cache_is_rewritten_when_a_dependency_changes():
    """The cache is the interface to the sidecar, which has no evaluator. A
    dependent left at its old number is a document that builds at a dimension
    nobody asked for."""
    d = M.new_document()
    M.set_parameter(d, "hub_d", 54)
    M.set_parameter(d, "hub_r", "hub_d/2")
    M.set_parameter(d, "hub_d", 60)
    assert d["parameters"]["hub_r"] == 30.0, d["parameters"]
    assert d["paramDefs"]["hub_r"]["expr"] == "hub_d/2", "the expression must survive the edit"


def test_a_bad_definition_is_refused_and_leaves_the_table_as_it_was():
    d = M.new_document()
    M.set_parameter(d, "a", 3)
    before = dict(d["parameters"])
    try:
        M.set_parameter(d, "b", "a + nope")
    except M.DocumentError:
        assert "b" not in d["paramDefs"], "the refused definition was left behind"
        assert d["parameters"] == before
        return
    raise AssertionError("an expression naming nothing was accepted")


def test_a_cycle_in_a_LOADED_file_is_named_rather_than_looped_on():
    """set_parameter cannot create a cycle (each name must already resolve), but
    a hand-edited file can carry one, and the recompute has to terminate and say
    which parameters are in it."""
    d = M.new_document()
    d["paramDefs"] = {"x": {"expr": "y + 1", "value": 0, "unit": "mm"},
                      "y": {"expr": "x + 1", "value": 0, "unit": "mm"},
                      "ok": {"expr": "7", "value": 0, "unit": "mm"}}
    issues = M.recompute_parameters(d)
    assert set(issues) == {"x", "y"}, issues
    assert "cycle" in issues["x"], issues["x"]
    assert d["parameters"]["ok"] == 7.0, "one bad definition must not take the table down"


def test_a_parameter_still_in_use_cannot_be_removed():
    d = M.new_document()
    M.set_parameter(d, "a", 3)
    M.set_parameter(d, "b", "a * 2")
    try:
        M.remove_parameter(d, "a")
    except M.DocumentError as ex:
        assert "b" in str(ex), str(ex)
        assert "a" in d["paramDefs"]
        return
    raise AssertionError("a parameter with a dependent was removed")


def test_a_reserved_name_is_refused():
    d = M.new_document()
    for name in ("sin", "mm", "PI"):
        try:
            M.set_parameter(d, name, 1)
        except M.DocumentError:
            continue
        raise AssertionError(f"{name} was accepted as a parameter name")


# --- validation ---------------------------------------------------------------


def test_a_reference_to_a_missing_sketch_is_reported():
    d = doc_with({"id": "ex1", "type": "extrude", "sketch": "nope", "distance": 1,
                  "operation": "new"})
    problems = M.validate(d)
    assert any("nope" in p for p in problems), problems


def test_a_reference_POINTING_DOWN_the_timeline_is_reported():
    """A feature can only use what is above it. This one builds to an error deep
    in the sidecar with no explanation, so it is worth catching here."""
    d = M.new_document()
    M.add_feature(d, {"id": "ex1", "type": "extrude", "sketch": "sk1", "distance": 1,
                      "operation": "new"})
    M.add_feature(d, {"id": "sk1", "type": "sketch", "plane": "XY", "entities": []})
    problems = M.validate(d)
    assert any("AFTER" in p for p in problems), problems


def test_a_correct_document_reports_nothing():
    """The control. A validator that flagged something on a healthy document
    would be noise an agent learns to ignore."""
    d = M.new_document()
    M.set_parameter(d, "h", 12)
    M.add_feature(d, {"id": "sk1", "type": "sketch", "plane": "XY", "entities": [
        {"id": "c", "type": "circle", "radius": 5}]})
    M.add_feature(d, {"id": "ex1", "type": "extrude", "sketch": "sk1", "distance": "h",
                      "operation": "new"})
    assert M.validate(d) == [], M.validate(d)


def test_a_string_in_a_numeric_field_must_name_a_parameter():
    d = M.new_document()
    M.add_feature(d, {"id": "bx1", "type": "box", "length": "wide", "width": 1, "height": 1})
    problems = M.validate(d)
    assert any("wide" in p for p in problems), problems
    M.set_parameter(d, "wide", 40)
    assert M.validate(d) == [], M.validate(d)


if __name__ == "__main__":
    _run.run(globals(), "document model")

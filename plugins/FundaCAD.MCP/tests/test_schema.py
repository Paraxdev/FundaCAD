"""The schema, held to the builder.

schema.py is hand-written, because the authority, src/types.ts, is a
TypeScript union whose value is in its comments, and no generator turns that
into prose worth reading. Hand-written documentation rots, and this is the test
that stops it: every type documented here must be one the sidecar can build, and
every type the sidecar can build must be documented here.

Without this, a new feature type ships and the agent that could have used it
never hears about it, the failure mode is silence, which is the kind no
end-to-end test finds.

Run: uv run python mcp/tests/test_schema.py
"""

import _bootstrap  # noqa: F401
import _run

import json
import os
import sys

import schema as S

# plugins/FundaCAD.MCP/tests/this_file -> tests -> FundaCAD.MCP -> plugins -> the checkout.
SIDECAR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))))), "sidecar")


def builder_types():
    """Every feature type the engine can actually build, from both sources.

    The application's own table, AND whatever the installed plugins registered:
    a plugin may own a feature type outright now, geometry included, so reading
    builder._FEATURE_HANDLERS alone would report `texture` as undocumentable the
    day it moved into plugins/FundaCAD.Texture, which is exactly what it did.

    discover() is what the engine calls at worker startup, so this reads the same
    set the engine would have. In a checkout that means every plugin in
    plugins/; on a machine it means every plugin installed. The schema below is
    a fixed list, so a plugin-owned entry in it is a claim that this build ships
    that plugin, which is true of the ones here and worth failing on if it ever
    stops being.
    """
    if SIDECAR not in sys.path:
        sys.path.insert(0, SIDECAR)
    import builder
    import plugin_geometry

    plugin_geometry.discover()
    return set(builder._FEATURE_HANDLERS) | set(plugin_geometry._FEATURES)


def test_every_documented_type_is_one_the_builder_handles():
    unknown = set(S.FEATURES) - builder_types()
    assert not unknown, f"documented but not buildable: {sorted(unknown)}"


def test_every_buildable_type_is_documented():
    missing = builder_types() - set(S.FEATURES)
    assert not missing, (f"the builder handles {sorted(missing)} and the schema does not "
                         "mention them, an agent reading this schema cannot use them")


def test_every_entry_has_a_summary_and_fields():
    for kind, e in S.FEATURES.items():
        assert e.get("summary"), kind
        assert isinstance(e.get("fields"), dict) and e["fields"], kind


def test_every_example_matches_its_own_type():
    for kind, e in S.FEATURES.items():
        ex = e.get("example")
        if ex is None:
            continue
        assert ex.get("type") == kind, f"{kind} example says type {ex.get('type')!r}"
        assert ex.get("id"), f"{kind} example has no id"
        json.dumps(ex)  # it has to survive the wire


def test_the_examples_only_use_documented_fields():
    """An example is the thing an agent copies, so a field in one that is not in
    the field list is a field nobody can look up."""
    for kind, e in S.FEATURES.items():
        ex = e.get("example")
        if ex is None:
            continue
        extra = set(ex) - set(e["fields"]) - {"id", "type"}
        assert not extra, f"{kind} example uses undocumented fields {sorted(extra)}"


def test_the_overview_names_every_type():
    body = S.schema_text()
    for kind in S.FEATURES:
        assert kind in body, f"{kind} is missing from the overview"
    for name in S.SKETCH_ENTITIES:
        assert name in body, f"sketch entity {name} is missing from the overview"


def test_one_type_returns_its_own_detail():
    body = S.schema_text("revolve")
    assert "pitch" in body and "thread" in body.lower()
    assert "sketch" in body


def test_an_unknown_type_is_answered_with_the_list_rather_than_nothing():
    body = S.schema_text("extrood")
    assert "extrude" in body and "No feature type" in body


def test_the_working_order_says_the_things_that_are_easy_to_get_wrong():
    """Three facts that cost a build each if the agent has to discover them:
    Z is up, primitives are centred on the origin, and body ids are not feature
    ids."""
    how = S.HOW_TO
    assert "Z is up" in how
    assert "CENTRED ON THE ORIGIN" in how
    assert "body1" in how


if __name__ == "__main__":
    _run.run(globals(), "schema")

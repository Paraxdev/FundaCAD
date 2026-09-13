"""Body ids stay put when the timeline around them changes.

 1. A document without `bodyIds` is numbered by position, as every saved file
    was, so opening one keeps each reference it holds.
 2. With the map, switching off or inserting a feature leaves every other
    body's id alone.
 3. A join keeps the id of the body it merges into, unless the map already
    recorded the fresh id an older build gave it.
 4. Neither cache tier hands back a prefix numbered under a different map.

Run: uv run python tests/test_body_ids.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import os
import shutil
import sys
import tempfile
import traceback

os.environ.setdefault("FUNDACAD_DISK_CACHE", "0")

import builder


def box(fid, size, **extra):
    f = {"id": fid, "type": "box", "length": size, "width": size, "height": size}
    f.update(extra)
    return f


def build(features, body_ids=None, params=None, cached=False):
    doc = {"parameters": params or {}, "features": features}
    if body_ids is not None:
        doc["bodyIds"] = body_ids
    out = {}
    fn = builder.rebuild_cached if cached else builder.rebuild
    _part, errors, bodies = fn(doc, body_ids_out=out)
    return errors, {b["id"]: b["name"] for b in bodies if b.get("shape") is not None}, out


FEATS = [box("a", 10), box("b", 4, activeWhen="flag"), box("c", 6)]


def test_a_document_without_the_map_is_numbered_by_position():
    errors, ids, recorded = build(FEATS, params={"flag": 0})
    assert not errors and sorted(ids) == ["body1", "body2"], (errors, ids)
    assert recorded == {"a:0": "body1", "c:0": "body2"}, recorded
    print("positional without a map OK")


def test_the_map_keeps_ids_when_a_feature_is_switched_off_or_inserted():
    _e, ids, recorded = build(FEATS, body_ids={}, params={"flag": 1})
    assert recorded == {"a:0": "body1", "b:0": "body2", "c:0": "body3"}, recorded
    errors, ids, again = build(FEATS, body_ids=recorded, params={"flag": 0})
    assert not errors and sorted(ids) == ["body1", "body3"], (errors, ids)
    assert again == recorded, again

    inserted = [box("z", 2)] + FEATS
    _e, ids, grown = build(inserted, body_ids=recorded, params={"flag": 1})
    assert grown == {**recorded, "z:0": "body4"}, grown
    print("stable through switch off and insert OK")


def test_a_join_keeps_the_id_of_the_body_it_merges_into():
    feats = [box("a", 10), box("far", 3), dict(box("j", 4, operation="join", targets=["body1"]), height=30)]
    _e, ids, recorded = build(feats, body_ids={})
    assert sorted(ids) == ["body1", "body2"], ids
    assert recorded["j:0"] == "body1", recorded

    _e, legacy, legacy_map = build(feats)
    assert sorted(legacy) == ["body2", "body3"], "an old file keeps the fresh id its join got"
    _e, kept, _ = build(feats, body_ids=legacy_map)
    assert kept == legacy, (kept, legacy)
    print("join inherits OK")


def test_the_ram_cache_follows_the_map():
    builder.reset_cache()
    feats = [box("a", 10), box("b", 4)]
    _e, ids, _ = build(feats, body_ids={"a:0": "body1", "b:0": "body2"}, cached=True)
    assert sorted(ids) == ["body1", "body2"], ids
    _e, ids, _ = build(feats, body_ids={"a:0": "body7", "b:0": "body2"}, cached=True)
    assert sorted(ids) == ["body2", "body7"], f"the cache served the old numbering: {ids}"
    builder.reset_cache()
    print("RAM cache follows the map OK")


def test_the_disk_cache_follows_the_map():
    import geomstore

    tmp = tempfile.mkdtemp(prefix="funda_body_ids_")
    orig_store = builder._disk_store
    try:
        store = geomstore.Store(root=tmp)
        builder._disk_store = lambda: store
        doc = {"parameters": {}, "features": [box("a", 10), box("b", 4)],
               "bodyIds": {"a:0": "body1", "b:0": "body2"}}
        keys = builder._chain_keys_scoped(doc, builder._feature_sigs(doc["features"]))
        builder.rebuild(doc, persist={"store": store, "keys": keys, "mod": {},
                                      "acc_ms": 0.0, "budget_ms": 0.0})
        assert builder._restore_from_disk(store, keys) is not None, "no checkpoint written"

        builder.reset_cache()
        same, renumbered = dict(doc), dict(doc, bodyIds={"a:0": "body5", "b:0": "body2"})
        _p, _e, bodies = builder.rebuild_cached(same)
        assert sorted(b["id"] for b in bodies) == ["body1", "body2"]
        builder.reset_cache()
        _p, _e, bodies = builder.rebuild_cached(renumbered)
        assert sorted(b["id"] for b in bodies) == ["body2", "body5"], [b["id"] for b in bodies]
    finally:
        builder._disk_store = orig_store
        builder.reset_cache()
        shutil.rmtree(tmp, ignore_errors=True)
    print("disk cache follows the map OK")


def test_a_missing_body_names_the_switched_off_feature_that_made_it():
    feats = [box("a", 10), box("b", 4, activeWhen="flag"),
             box("bo", 3, operation="intersect", targets=["body2"])]
    _e, _ids, recorded = build(feats, body_ids={}, params={"flag": 1})
    errors, _ids, _ = build(feats, body_ids=recorded, params={"flag": 0})
    assert len(errors) == 1 and "b is switched off" in errors[0]["message"], errors
    print("missing body hint OK:", errors[0]["message"])


if __name__ == "__main__":
    try:
        test_a_document_without_the_map_is_numbered_by_position()
        test_the_map_keeps_ids_when_a_feature_is_switched_off_or_inserted()
        test_a_join_keeps_the_id_of_the_body_it_merges_into()
        test_the_ram_cache_follows_the_map()
        test_the_disk_cache_follows_the_map()
        test_a_missing_body_names_the_switched_off_feature_that_made_it()
        print("\nall body id tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)

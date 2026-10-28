import pytest

from fundacad_harness import a11y
from fundacad_harness.errors import HarnessError


def test_the_vendored_axe_matches_its_pinned_hash():
    src = a11y.axe_source()
    assert src.startswith(f"/*! axe v{a11y.AXE_VERSION}")


def test_a_changed_axe_file_is_refused():
    with pytest.raises(HarnessError, match="sha256"):
        a11y.axe_source(b"window.axe = {run() {}}")


def test_the_scan_runs_wcag_2_0_2_1_and_2_2_a_and_aa_and_no_best_practice():
    assert set(a11y.AXE_TAGS) == {"wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"}


def test_counts_are_nodes_per_rule_and_skip_rules_without_nodes():
    found = a11y.counts([{"id": "label", "nodes": [{}, {}]}, {"id": "button-name", "nodes": []}])
    assert found == {"label": 2}


def test_a_rule_above_its_count_fails():
    assert a11y.over_baseline({"label": 3}, {"label": 2}) == ["label: 3 nodes, the baseline allows 2"]


def test_a_rule_missing_from_the_baseline_fails():
    assert a11y.over_baseline({"button-name": 1}, {"label": 2}) == ["button-name: 1 nodes, the baseline allows 0"]


def test_counts_at_or_under_the_baseline_pass():
    assert a11y.over_baseline({"label": 2}, {"label": 2, "color-contrast": 4}) == []


def test_a_fixed_rule_is_noted_so_the_baseline_can_shrink():
    notes = a11y.under_baseline({"label": 1}, {"label": 2, "color-contrast": 4})
    assert notes == [
        "color-contrast: 0 nodes, the baseline allows 4, lower it with FUNDACAD_AXE_LOWER=1",
        "label: 1 nodes, the baseline allows 2, lower it with FUNDACAD_AXE_LOWER=1",
    ]


def test_lowering_only_shrinks_and_drops_zeros():
    assert a11y.lowered({"label": 1, "color-contrast": 9}, {"label": 2, "color-contrast": 4, "list": 1}) == {
        "color-contrast": 4,
        "label": 1,
    }


def test_lowering_never_adds_a_rule():
    assert a11y.lowered({"button-name": 3}, {}) == {}


def test_lowering_the_baseline_keeps_screens_that_did_not_run_and_never_adds_one():
    baseline = {"home": {"label": 2}, "stress": {"button-name": 1}}
    results = {"home": {"label": 1}, "new_screen": {"label": 5}}
    assert a11y.lowered_baseline(results, baseline) == {"home": {"label": 1}, "stress": {"button-name": 1}}


def test_a_screen_with_nothing_left_is_dropped():
    assert a11y.lowered_baseline({"home": {}}, {"home": {"label": 2}}) == {}


def test_baseline_round_trips_sorted(tmp_path):
    path = tmp_path / "b.json"
    a11y.write_baseline(path, {"z": {"b": 1, "a": 2}})
    assert path.read_text(encoding="utf-8").index('"a"') < path.read_text(encoding="utf-8").index('"b"')
    assert a11y.read_baseline(path) == {"z": {"a": 2, "b": 1}}
    assert a11y.read_baseline(tmp_path / "missing.json") == {}

import pytest

from fundacad_harness import targets
from fundacad_harness.browser import chrome_args, find_chrome
from fundacad_harness.errors import LaunchError

STYLE = """
<style>
  body { margin: 0; font: 12px sans-serif; }
  button { all: unset; position: absolute; width: 12px; height: 12px; background: #888; }
  .grow::before { content: ""; position: absolute; inset: -6px; }
  .wide::before { content: ""; position: absolute; inset: -12px; }
  label { position: absolute; left: 20px; top: 200px; display: inline-flex; align-items: center; gap: 4px;
    height: 30px; padding: 0 6px; }
  label input { width: 12px; height: 12px; margin: 0; }
</style>
"""


@pytest.fixture(scope="module")
def page():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        pytest.skip("playwright is not installed")
    try:
        chrome = find_chrome()
    except LaunchError as e:
        pytest.skip(str(e))
    pw = sync_playwright().start()
    browser = pw.chromium.launch(executable_path=chrome, headless=True, args=chrome_args(False))
    try:
        yield browser.new_page(viewport={"width": 400, "height": 300})
    finally:
        browser.close()
        pw.stop()


def by_id(report: dict, key: str, id_: str) -> dict:
    return next(t for t in report[key] if t["sel"].endswith("#" + id_))


def test_a_small_button_is_under_24_and_a_grown_one_is_not(page):
    page.set_content(
        STYLE
        + '<button id="small" aria-label="Small" style="left:20px;top:20px"></button>'
        + '<button id="grown" class="grow" aria-label="Grown" style="left:100px;top:20px"></button>'
    )
    report = targets.probe(page)
    small, grown = by_id(report, "targets", "small"), by_id(report, "targets", "grown")
    assert small["hit"] == [12, 12] and small["box"][2:] == [12, 12]
    assert grown["hit"] == [24, 24] and grown["box"][2:] == [12, 12]
    assert [t["name"] for t in targets.under(report, 24)] == ["Small"]
    assert report["covered"] == []
    assert "button#small \"Small\" hit 12x12 box 12x12" == targets.line(small)


def test_a_grown_area_over_a_neighbours_centre_is_reported_covered(page):
    page.set_content(
        STYLE
        + '<button id="under" aria-label="Under" style="left:214px;top:20px"></button>'
        + '<button id="over" class="wide" aria-label="Over" style="left:200px;top:20px"></button>'
    )
    report = targets.probe(page)
    covered = by_id(report, "covered", "under")
    assert covered["by"] == "button#over" and covered["byName"] == "Over"
    assert [t["name"] for t in report["targets"]] == ["Over"]


def test_a_later_neighbours_grown_area_over_an_earlier_ones_edge_is_reported_stolen(page):
    page.set_content(
        STYLE
        + '<button id="first" class="grow" aria-label="First" style="left:20px;top:20px;width:20px"></button>'
        + '<button id="second" class="grow" aria-label="Second" style="left:40px;top:20px;width:20px"></button>'
        + '<button id="apart" class="grow" aria-label="Apart" style="left:100px;top:20px"></button>'
    )
    report = targets.probe(page)
    assert [(t["sel"], t["side"], t["by"], t["byName"]) for t in report["stolen"]] == [
        ("button#first", "right", "button#second", "Second")
    ]
    assert report["covered"] == []


def test_a_hidden_input_counts_its_label_and_inert_or_tiny_controls_are_skipped(page):
    page.set_content(
        STYLE
        + '<label><input id="box" type="checkbox">Snap</label>'
        + '<div inert><button id="inert" style="left:300px;top:20px"></button></div>'
        + '<button id="tiny" style="left:300px;top:100px;width:1px;height:1px"></button>'
    )
    report = targets.probe(page)
    box = by_id(report, "targets", "box")
    assert box["name"] == "Snap" and box["box"][2:] == [12, 12]
    assert box["hit"][1] == 30 and box["hit"][0] > 24
    assert [t["sel"] for t in report["targets"]] == ["input#box"]
    assert report["covered"] == [] and report["occluded"] == []

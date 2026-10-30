import pytest

pytestmark = pytest.mark.browser

PLATE_WIDTH = "tools/harness/fixtures/plate_width.json"

MODEL_PARAMS = """() => [...document.querySelectorAll('.params-row')]
  .filter((r) => r.querySelector('.params-drives'))
  .map((r) => ({
    expr: r.querySelectorAll('input')[1].value,
    value: r.querySelector('.params-value').textContent.trim(),
    drives: r.querySelector('.params-drives').textContent.trim(),
  }))"""


@pytest.fixture
def s(session):
    session.press("Escape")
    session.new_document()
    session.open_file(PLATE_WIDTH)
    session.view("iso")
    yield session
    session.press("Escape")


DEPTH_ROW = """() => {
  const r = document.querySelector('.param-row[data-field="distance"]');
  return { text: r.querySelector('input').value, title: r.title };
}"""


def depth_row(s, feature: str) -> dict:
    s.click(f"feature:{feature}", double=True)
    row = s.page.evaluate(DEPTH_ROW)
    s.press("Escape")
    return row


def side_edge(s) -> str:
    s.pick_edge("between front right")
    readout = s.selection(raw=True)["readout"]
    s.press("Escape")
    return readout


def test_extrude_takes_width_over_4_and_its_depth_follows_width(s, tmp_path):
    s.pick_face("top")
    s.tool("Extrude")
    typed = s.type("D", "width / 4")
    assert "problem" not in str(typed), typed
    s.press("Enter")
    rows = s.history(raw=True)["rows"]
    # Extrude on a face of a body runs Press/Pull.
    assert [r["type"] for r in rows] == ["box", "press-pull"], rows
    extrude = rows[1]["id"]
    assert rows[1]["state"] == "", rows
    row = depth_row(s, extrude)
    assert row["text"] == "width / 4" and row["title"].endswith("= 5"), row
    assert side_edge(s).endswith("10 mm")
    s.screenshot(tmp_path / "extrude-width-20.png")

    s.tool("Parameters")
    bound = s.page.evaluate(MODEL_PARAMS)
    assert [b["expr"] for b in bound] == ["width / 4"], bound
    s.type("Expression of width", "40", enter=True)
    s.settle()
    bound = s.page.evaluate(MODEL_PARAMS)
    assert bound[0]["value"].startswith("10"), bound
    s.screenshot(tmp_path / "params-width-40.png")
    s.press("Escape")

    assert s.history(raw=True)["rows"][1]["state"] == ""
    assert depth_row(s, extrude)["title"].endswith("= 10")
    assert side_edge(s).endswith("15 mm")
    s.screenshot(tmp_path / "extrude-width-40.png")


def test_an_unknown_name_in_the_extrude_value_box_names_it(s):
    s.pick_face("top")
    s.tool("Extrude")
    typed = s.type("D", "widht / 4").data
    assert 'no parameter named "widht"' in typed["problem"], typed
    s.press("Escape")
    assert s.history(raw=True)["count"] == 1

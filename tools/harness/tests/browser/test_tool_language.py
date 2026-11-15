"""A scripted session names tools in English whatever language the app shows."""

import pytest

pytestmark = pytest.mark.browser

PLATE_WIDTH = "tools/harness/fixtures/plate_width.json"
LANGUAGE = "async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)"


@pytest.fixture
def s(session):
    session.press("Escape")
    session.new_document()
    session.open_file(PLATE_WIDTH)
    session.view("iso")
    session.page.evaluate(LANGUAGE, "de")
    yield session
    session.press("Escape")
    session.page.evaluate(LANGUAGE, "system")


def test_extrude_by_its_english_name_starts_from_a_german_rail_with_a_face_selected(s):
    s.pick_face("top")
    s.tool("Extrude")
    typed = s.type("D", "5")
    assert "problem" not in str(typed), typed
    s.press("Enter")
    assert [r["type"] for r in s.history(raw=True)["rows"]] == ["box", "press-pull"]

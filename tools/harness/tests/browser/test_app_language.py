"""The app's own lines read German once it is picked: the 3D view renames itself, and a picked face prompts with its
count in German, and both read English again after the switch back."""

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


def names(s) -> tuple[str | None, str | None]:
    c = s.page.locator("#canvas")
    return c.get_attribute("aria-label"), c.get_attribute("aria-roledescription")


def test_the_3d_view_renames_itself_on_a_switch(s):
    assert names(s) == ("Modell", "3D-Ansicht")
    s.page.evaluate(LANGUAGE, "ja")
    assert names(s) == ("モデル", "3Dビュー")
    s.page.evaluate(LANGUAGE, "system")
    assert names(s) == ("Model", "3D view")


def test_a_picked_face_prompts_with_its_count_in_german(s):
    s.pick_face("top")
    prompt = s.status(raw=True).get("prompt") or ""
    assert prompt.startswith("1 Fläche ausgewählt, ziehen Sie den Griff"), prompt

"""A lone fillet larger than its face builds by cutting a corner off, and its History chip and properties say so, with
the size that rests on both faces in the chosen language and its decimal mark."""

import json
import re

import pytest
from playwright.sync_api import expect

from fundacad_harness import Session

pytestmark = [pytest.mark.browser]

DOC = {
    "version": 10,
    "parameters": {},
    "features": [
        {"id": "bx", "type": "box", "length": 60, "width": 40, "height": 20},
        {
            "id": "f",
            "type": "fillet",
            "radius": 45,
            "edges": {"kind": "edge", "by": "nearest", "point": [30, 20, 0], "body": "body1"},
        },
    ],
}
CHIP = ".timeline-node[data-id=f]"
STATE = """(id) => {
  const chip = document.querySelector(`.timeline-node[data-id=${id}]`);
  return document.getElementById(chip.getAttribute("aria-describedby")).textContent;
}"""


@pytest.fixture(scope="module")
def s(tmp_path_factory):
    path = tmp_path_factory.mktemp("overrun") / "overrun.json"
    path.write_text(json.dumps(DOC), encoding="utf-8")
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        session.open_file(path, discard=True)
        session.settle()
        yield session
    finally:
        session.close()


def language(s: Session, lang: str) -> None:
    s.page.evaluate("async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)", lang)
    s.page.wait_for_timeout(300)


def test_the_chip_and_the_properties_name_the_size_that_rests_on_both_faces(s):
    chip = s.page.locator(CHIP)
    expect(chip).to_have_class(re.compile(r"\bwarn\b"))
    note = "The fillet runs past a face beside its edge, so it cuts that corner off instead of resting on both faces. "
    note += "One that rests on both fits up to 39.99 mm."
    assert f"Note: {note}" in chip.get_attribute("title")
    assert f"warning: {note}" in s.page.evaluate(STATE, "f")
    chip.click()
    expect(s.page.locator(".timeline-props .param-note")).to_have_text(note)


def test_the_note_follows_the_language_and_its_decimal_comma(s):
    language(s, "de")
    try:
        props = s.page.locator(".timeline-props .param-note")
        expect(props).to_contain_text("Verrundung")
        expect(props).to_contain_text("39,99 mm")
        assert "Verrundung" in s.page.locator(CHIP).get_attribute("title")
    finally:
        language(s, "system")

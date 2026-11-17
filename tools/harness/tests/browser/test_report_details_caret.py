"""The Report dialog's "What will be sent" folds behind the app's caret, not the browser's triangle, and the caret
turns down while it is open."""

import pytest
from playwright.sync_api import expect

from fundacad_harness import Session

pytestmark = [pytest.mark.browser]

SUMMARY = ".bug-preview > summary"
LOOK = """(sel) => {
  const summary = document.querySelector(sel);
  const caret = summary.querySelector(".disclosure-caret");
  // A window on another desktop does not advance transitions, so the turn is read at its end.
  for (const a of caret?.getAnimations() ?? []) a.finish();
  return {
    marker: getComputedStyle(summary).display,
    caret: caret ? getComputedStyle(caret).transform : null,
    first: summary.firstElementChild === caret,
  };
}"""


@pytest.fixture(scope="module")
def s():
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        session.page.get_by_role("button", name="Report a problem").click()
        session.page.locator(SUMMARY).wait_for(timeout=5000)
        yield session
    finally:
        session.close()


def test_the_summary_leads_with_the_caret_in_place_of_the_triangle(s):
    look = s.page.evaluate(LOOK, SUMMARY)
    assert look["marker"] == "flex"
    assert look["first"]
    assert look["caret"] == "none"


def test_the_caret_turns_down_while_open(s):
    s.page.locator(SUMMARY).click()
    expect(s.page.locator(".bug-preview pre")).to_be_visible()
    assert s.page.evaluate(LOOK, SUMMARY)["caret"].startswith("matrix(0, 1, -1, 0")

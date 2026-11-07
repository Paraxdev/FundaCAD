"""The 3D view as text: its name and kept current summary, Describe model with Copy as text, Describe selection."""

import os
import re
import tempfile
from pathlib import Path

import pytest
from playwright.sync_api import expect

from fundacad_harness.screens import close_settings, set_theme

pytestmark = [pytest.mark.browser, pytest.mark.smoke, pytest.mark.a11y]

NEAR = "tools/harness/fixtures/near_boxes.json"
BODY_LINES = [
    re.compile(r"^Box: 20 × 20 × 30 mm, center at 0, 0, 0 mm, volume 12000 mm³$"),
    re.compile(r"^Box 2: 10 × 10 × 10 mm, center at 25, 0, 0 mm, volume 1000 mm³$"),
]

LISTEN = """() => {
  const polite = document.getElementById("a11y-polite");
  window.__spoken = [];
  if (window.__spokenObserver) window.__spokenObserver.disconnect();
  window.__spokenObserver = new MutationObserver(() => {
    if (polite.textContent) window.__spoken.push(polite.textContent);
  });
  window.__spokenObserver.observe(polite, { childList: true, characterData: true, subtree: true });
}"""


def shots_dir() -> Path:
    out = Path(os.environ.get("FUNDACAD_A11Y_OUT") or Path(tempfile.gettempdir()) / "fundacad-a11y")
    out.mkdir(parents=True, exist_ok=True)
    return out


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(NEAR)
    session.view("iso")
    session.settle()
    yield session
    session.page.keyboard.press("Escape")


def canvas(s):
    return s.page.locator("#canvas")


def open_describe(s):
    s.command("Describe Model")
    dialog = s.page.get_by_role("dialog", name="Model description")
    dialog.wait_for()
    return dialog


def test_the_view_is_a_named_3d_view_described_by_a_summary_and_never_an_application(s):
    c = canvas(s)
    expect(c).to_have_attribute("role", "img")
    expect(c).to_have_attribute("aria-roledescription", "3D view")
    expect(c).to_have_accessible_name("Model")
    expect(c).to_have_accessible_description(
        re.compile(r"^2 bodies, 3 features\. Isometric view, (perspective|orthographic)\. Section off\. Nothing selected\.$")
    )
    assert s.page.locator("[role=application]").count() == 0


def test_the_view_cube_has_no_canvas_of_its_own_to_hide(s):
    # It is drawn into the 3D view's canvas, so the Views popover is its text form and there is nothing to aria-hide.
    assert s.page.locator("canvas").count() == 1


def test_the_summary_follows_the_selection_and_the_view(s):
    s.page.evaluate("() => viewport.setSelectedBodies(['body2'])")
    s.view("top")
    s.settle()
    c = canvas(s)
    c.focus()
    expect(c).to_have_accessible_description(re.compile(r"Top view, orthographic\. Section off\. Selected: Box 2\.$"))


def test_describe_model_lists_every_body_with_its_size_and_center_and_copies_the_same_text(s):
    s.page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    dialog = open_describe(s)
    for name in ("Overview", "Bodies", "Features", "View"):
        expect(dialog.get_by_role("heading", name=name, level=3, exact=True)).to_be_visible()
    bodies = dialog.get_by_role("list", name="Bodies").get_by_role("listitem")
    expect(bodies).to_have_count(2)
    for item, line in zip(bodies.all(), BODY_LINES):
        expect(item).to_have_text(line)
    expect(dialog.get_by_role("list", name="Features").get_by_role("listitem")).to_have_count(3)
    expect(s.page.locator(".describe-body")).to_be_focused()
    s.page.evaluate(LISTEN)
    dialog.get_by_role("button", name="Copy as text").click()
    s.page.wait_for_function("() => window.__spoken.some((t) => t.includes('Copied'))", timeout=5000)
    # Windows hands the text back with CRLF line ends.
    copied = s.page.evaluate("() => navigator.clipboard.readText()").replace("\r\n", "\n")

    shown = [li.inner_text() for li in dialog.get_by_role("listitem").all()]
    assert copied.startswith("Model description\n\nOverview\n- File: ")
    for line in shown:
        assert line in copied
    assert "Bodies\n- " + shown[3] + "\n- " + shown[4] + "\n" in copied
    dialog.get_by_role("button", name="Close", exact=True).last.click()
    expect(dialog).to_be_hidden()


def test_describe_selection_says_the_body_with_its_size_and_center(s):
    s.page.evaluate("() => viewport.setSelectedBodies(['body2'])")
    s.settle()
    s.page.evaluate(LISTEN)
    # The View menu, since a body selection raises Move, whose value box takes typed keys.
    s.menu("View/Describe Selection")
    want = "Box 2, 10 by 10 by 10 millimetres, center at 25, 0, 0 millimetres"
    s.page.wait_for_function("w => window.__spoken.some((t) => t.includes(w))", arg=want, timeout=5000)


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_a_shot_of_describe_model(s, theme):
    set_theme(s, theme)
    close_settings(s)
    dialog = open_describe(s)
    s.page.wait_for_timeout(400)
    s.page.screenshot(path=str(shots_dir() / f"describe_model_{theme}.png"))
    dialog.get_by_role("button", name="Close", exact=True).last.click()
    if theme == "light":
        set_theme(s, "dark")
        close_settings(s)

"""A modal makes the page behind it inert, so WebKit screen readers, which ignore aria-modal, cannot
browse it, and closing the modal hands focus back to a live control."""

import pytest

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

# Controls a Tab press or a screen reader browse key could reach outside the given layer.
REACHABLE = """(layer) => {
  const top = document.querySelector(layer);
  const sel = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"]), [contenteditable=true]';
  return [...document.querySelectorAll(sel)]
    .filter((e) => !e.closest("[inert], #a11y-announcer, .toast-stack") && !(top && top.contains(e)))
    .filter((e) => e.getClientRects().length > 0)
    .map((e) => e.id || e.getAttribute("aria-label") || e.textContent.trim().slice(0, 40) || e.tagName);
}"""

APP = """() => {
  const app = document.getElementById("app");
  return { inert: app.inert, hidden: app.getAttribute("aria-hidden") };
}"""

MARKS = """() => [...document.querySelectorAll("[inert], [aria-hidden=true]")].length"""

FOCUS = """() => {
  const a = document.activeElement;
  return {
    body: !a || a === document.body,
    inert: !!a?.closest("[inert]"),
    id: a?.id ?? "",
    label: a?.getAttribute("aria-label") || a?.textContent.trim() || "",
  };
}"""

LIVE_ROLES = ("- status", "- alert", "- log")


def top_level(snapshot: str) -> list[str]:
    return [l for l in snapshot.splitlines() if l.startswith("- ") and not l.startswith(LIVE_ROLES)]


def inside_dialog_after_tabs(s, layer: str, presses: int = 25) -> bool:
    for _ in range(presses):
        s.page.keyboard.press("Tab")
        if not s.page.evaluate("(l) => !!document.querySelector(l)?.contains(document.activeElement)", layer):
            return False
    return True


@pytest.fixture
def s(session):
    session.press("Escape")
    session.page.wait_for_function("() => !document.querySelector('[role=dialog], [role=alertdialog]')")
    yield session


def test_the_page_is_reachable_with_no_modal_open(s):
    assert "undo-btn" in s.page.evaluate(REACHABLE, "[role=dialog]")
    assert s.page.evaluate(APP) == {"inert": False, "hidden": None}
    assert 'button "Undo"' in s.page.locator("body").aria_snapshot()


def test_settings_makes_the_app_root_inert_and_hands_focus_back(s):
    before = s.page.evaluate(MARKS)
    s.panel("settings")
    layer = ".modal-overlay [role=dialog]"
    s.page.wait_for_selector(layer)
    assert s.page.evaluate(APP) == {"inert": True, "hidden": "true"}
    assert s.page.evaluate(REACHABLE, layer) == []
    snap = s.page.locator("body").aria_snapshot()
    assert top_level(snap) == ['- dialog "Preferences":'], snap
    assert 'button "Undo"' not in snap and "menubar" not in snap
    assert inside_dialog_after_tabs(s, layer)

    s.panel("settings", open=False)
    s.page.wait_for_selector(layer, state="detached")
    assert s.page.evaluate(APP) == {"inert": False, "hidden": None}
    assert s.page.evaluate(MARKS) == before
    focus = s.page.evaluate(FOCUS)
    assert not focus["body"] and not focus["inert"], focus
    assert focus["label"] == "Edit", focus


def test_the_command_palette_makes_the_page_inert_until_escape(s):
    before = s.page.evaluate(MARKS)
    s.page.locator("#home-btn").focus()
    s.page.keyboard.press("Control+K")
    layer = ".cmdk-card"
    s.page.wait_for_selector(layer)
    assert s.page.evaluate(APP) == {"inert": True, "hidden": "true"}
    assert s.page.evaluate(REACHABLE, layer) == []
    snap = s.page.locator("body").aria_snapshot()
    assert top_level(snap) == ['- dialog "Command palette":'], snap

    s.page.keyboard.press("Escape")
    s.page.wait_for_selector(layer, state="detached")
    assert s.page.evaluate(APP) == {"inert": False, "hidden": None}
    assert s.page.evaluate(MARKS) == before
    assert s.page.evaluate(FOCUS)["id"] == "home-btn"


def test_home_leaves_only_its_toggle_live_and_returns_focus_to_it(s):
    s.page.locator("#home-btn").click()
    layer = ".home[role=dialog]"
    s.page.wait_for_selector(layer)
    assert s.page.evaluate(REACHABLE, layer) == ["home-btn"]
    snap = s.page.locator("body").aria_snapshot()
    assert 'dialog "Home"' in snap
    assert 'button "Undo"' not in snap and "menubar" not in snap

    s.page.locator("#home-btn").click()
    s.page.wait_for_selector(layer, state="detached")
    assert "undo-btn" in s.page.evaluate(REACHABLE, "[role=dialog]")
    assert s.page.evaluate(FOCUS)["id"] == "home-btn"

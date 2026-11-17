"""Getting a harness page to the main screens through the UI, as a person would: Settings, Home, an example."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from .errors import Occluded
from .session import Session

THEMES = {"dark": "FundaCAD Noir", "light": "Solarized Light"}


def out_dir() -> Path:
    """Where the size and reach checks put their shots and results."""
    out = Path(os.environ.get("FUNDACAD_SIZE_OUT") or Path(tempfile.gettempdir()) / "fundacad-size")
    out.mkdir(parents=True, exist_ok=True)
    return out


def settled(s: Session) -> None:
    s.page.wait_for_timeout(400)


def pick(s: Session, field: str, option: str) -> None:
    s.page.click(field)
    s.page.get_by_role("option", name=option, exact=True).click()


def again(s: Session, step) -> None:
    try:
        step()
    except Occluded:
        # On a loaded machine a menu can stay unstable past the 5 s click wait, once settled it takes the click.
        s.page.keyboard.press("Escape")
        s.settle()
        s.page.wait_for_timeout(1000)
        step()


# The dialog and its tabs are found by class and tab id, so they open in whichever language the app shows.
PREFS_DIALOG = ".prefs-panel[role=dialog]"
SETTINGS_TABS = {
    "Appearance": "appearance",
    "Viewport": "viewport",
    "Navigation": "navigation",
    "Accessibility": "access",
    "Updates": "updates",
    "AI assistants": "mcp",
    "Plugins": "plugins",
    "Experimental": "experimental",
}


def settings_tab(s: Session, category: str):
    return s.page.locator(f'{PREFS_DIALOG} [role=tab][data-tab="{SETTINGS_TABS.get(category, category)}"]')


def open_settings(s: Session, category: str) -> None:
    again(s, lambda: s.panel("settings"))
    s.page.locator(PREFS_DIALOG).wait_for()
    settings_tab(s, category).click()


def set_theme(s: Session, theme: str) -> None:
    """Picks the theme through Settings and leaves it open on the Accessibility pane."""
    open_settings(s, "Appearance")
    pick(s, "#prefs-theme", THEMES[theme])
    settings_tab(s, "Accessibility").click()
    settled(s)


def close_settings(s: Session) -> None:
    # Escape, as the Close button can stay unstable past the click wait while an example rebuilds in SwiftShader.
    s.page.keyboard.press("Escape")
    s.page.locator(PREFS_DIALOG).wait_for(state="hidden")
    s.settle()
    settled(s)


def show_home(s: Session) -> None:
    again(s, lambda: s.menu("File/Home"))
    s.page.locator('.home-example:has-text("Box with a lid")').wait_for()
    settled(s)


def open_example(s: Session) -> None:
    show_home(s)
    s.page.evaluate(
        "() => { window.__sizeOpened = false;"
        " const off = window.store.onOpen(() => { window.__sizeOpened = true; off(); }); }"
    )
    s.page.click('.home-example:has-text("Box with a lid")')
    s.page.wait_for_function(
        "() => window.__sizeOpened && window.store.document.features.length > 0", timeout=60000, polling=100
    )
    s.settle()
    settled(s)

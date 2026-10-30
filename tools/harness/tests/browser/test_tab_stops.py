"""Tab from the menu bar to the viewport passes each toolbar, the menu bar and each radiogroup as one stop."""

import pytest

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

# The composite widget that holds the focused control, else the region it sits in, else the control itself.
STOP = """() => {
  const a = document.activeElement;
  if (!a || a === document.body) return "body";
  const box = a.closest("[role=toolbar], [role=menubar], [role=radiogroup], #browser, #timeline");
  if (!box) return a.id || a.getAttribute("aria-label") || a.tagName.toLowerCase();
  if (box.id === "browser" || box.id === "timeline") return "#" + box.id;
  return `${box.getAttribute("role")} ${box.getAttribute("aria-label")}`;
}"""

# The Items panel rows are counted on their own, the tree there owns its Tab stops.
SHELL_STOPS = [
    "menubar Menu",
    "toolbar Undo and redo",
    "radiogroup Workspace",
    "toolbar Tools",
    "toolbar View controls",
    "radiogroup View mode",
]


def tab_walk(s, presses: int = 60) -> list[str]:
    s.page.keyboard.press("F10")
    s.page.wait_for_function("() => !!document.activeElement?.closest('[role=menubar]')")
    stops = [s.page.evaluate(STOP)]
    for _ in range(presses):
        s.page.keyboard.press("Tab")
        stop = s.page.evaluate(STOP)
        if stop in ("#timeline", "body", "menubar Menu"):
            break
        stops.append(stop)
    return stops


def test_tab_from_the_menu_bar_to_the_viewport_stops_once_per_shell_widget(session):
    session.press("Escape")
    session.settle()
    stops = tab_walk(session)
    assert [st for st in stops if st != "#browser"] == SHELL_STOPS, stops

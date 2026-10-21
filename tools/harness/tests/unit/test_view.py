import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.errors import NotFound

REPO = Path(__file__).resolve().parents[4]

LABELS = ["Default View", "Fit to Model", "opt:Top", "opt:Bottom", "opt:Front", "opt:Back", "opt:Right", "opt:Left"]


class App:
    """The Views popover: its button toggles it, and a running Extrude hears an Escape before the popover does."""

    def __init__(self, closes_itself=False):
        self.open = False
        self.closes_itself = closes_itself
        self.clicked: list[str] = []
        self.tool_escapes = 0
        self.refocused: list = []

    def call(self, method, **args):
        if method == "seq":
            return 0
        if method == "messages":
            return {"seq": 0, "rows": []}
        if method == "status":
            return {"mode": "running"}
        if method == "locate":
            t = args["target"]
            if t != "Views" and (not self.open or t not in LABELS):
                raise NotFound(f'no visible control "{t}"')
            self.clicked.append(t)
            if t == "Views":
                self.open = not self.open
            elif self.closes_itself:
                self.open = False
            if t == "Home":
                self.start = "home"
            return {"marker": "m", "ref": t, "label": t.removeprefix("opt:")}
        if method == "startScreen":
            return getattr(self, "start", "none")
        raise AssertionError(method)

    def press(self, k):
        if k == "Escape":
            self.tool_escapes += 1
            self.open = False


def session(app):
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    s.bridge = app
    s.page = types.SimpleNamespace(
        keyboard=types.SimpleNamespace(press=app.press),
        wait_for_timeout=lambda ms: None,
        evaluate_handle=lambda js: types.SimpleNamespace(dispose=lambda: None),
        evaluate=lambda js, arg=None: app.refocused.append(arg),
        locator=lambda sel: types.SimpleNamespace(click=lambda **k: None, count=lambda: int(app.open)),
    )
    s.settle = lambda *a, **k: "settled"
    return s


@pytest.mark.parametrize("name", ["top", "front", "bottom", "back", "left", "right", "Top", "TOP"])
def test_every_side_is_found_by_its_name(name):
    app = App()
    s = session(app)
    assert str(s.view(name)).startswith(f"view {name.capitalize()},")
    assert app.clicked == ["Views", f"opt:{name.capitalize()}", "Views"]
    assert not app.open
    s.close()


def test_iso_fits_the_model_after_the_default_view():
    app = App()
    s = session(app)
    assert str(s.view("iso")).startswith("view Default View then Fit to Model,")
    s.close()


@pytest.mark.parametrize("closes_itself", [False, True])
def test_a_view_leaves_a_running_tool_alone(closes_itself):
    app = App(closes_itself=closes_itself)
    s = session(app)
    s.view("top")
    s.view("iso")
    assert app.tool_escapes == 0
    assert not app.open
    assert len(app.refocused) == 2, "the field that had the focus gets it back"
    s.close()


def test_an_unknown_view_closes_the_popover_and_names_the_views():
    app = App()
    s = session(app)
    with pytest.raises(NotFound, match='no view "sideways", the views are iso, default, fit, back'):
        s.view("sideways")
    assert not app.open and app.tool_escapes == 0
    s.close()


def test_the_home_view_says_it_opened_the_start_screen():
    LABELS.append("Home")
    try:
        app = App()
        s = session(app)
        assert 'view Home, it opened the home start screen, dismiss_start() or press("Escape") closes it' in str(s.view("Home"))
        s.close()
    finally:
        LABELS.remove("Home")

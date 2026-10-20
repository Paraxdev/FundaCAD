import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.errors import NotFound

REPO = Path(__file__).resolve().parents[4]


class Page:
    def __init__(self, on_key):
        self.keys: list[str] = []
        self.keyboard = types.SimpleNamespace(press=self._press, type=lambda t: None)
        self._on_key = on_key

    def _press(self, k):
        self.keys.append(k)
        self._on_key(k)

    def wait_for_timeout(self, _ms):
        pass

    def locator(self, _sel):
        return types.SimpleNamespace(click=lambda **k: None)


class Screen:
    """A bridge whose screen is a list of rows the test changes."""

    def __init__(self, rows):
        self.rows = rows
        self.clicked: list[str] = []

    def call(self, method, **args):
        if method == "seq":
            return 0
        if method == "messages":
            return {"seq": 0, "rows": []}
        if method == "status":
            return {"mode": "model"}
        if method == "screen":
            return {"lines": [r for r in self.rows if not args.get("region") or r[5] == args["region"]]}
        if method == "locate":
            row = next(r for r in self.rows if r[1] == args["target"])
            self.clicked.append(row[1])
            return {"marker": "m", "ref": row[1], "label": row[3]}
        raise AssertionError(method)


def session(rows, on_key=lambda k: None):
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    s.bridge = Screen(rows)
    s.page = Page(on_key)
    s.settle = lambda *a, **k: "settled"
    return s


PALETTE = [1, "#cmdk", "input", "Search commands…", [], "dialog"]


def test_a_command_nothing_matches_is_refused_and_the_search_closed():
    rows = [PALETTE]
    s = session(rows, on_key=lambda k: rows.clear() if k == "Escape" else None)
    with pytest.raises(NotFound, match='no command runs for "Sphere"'):
        s.command("Sphere")
    assert s.page.keys[-1] == "Escape"
    s.close()


def test_a_command_names_the_match_it_ran():
    rows = [PALETTE, [1, 'text:"Fit to Model"', "button", "Fit to Model", [], "dialog"]]
    s = session(rows, on_key=lambda k: rows.clear() if k == "Enter" else None)
    assert str(s.command("fit")).startswith('ran command "Fit to Model"')
    s.close()


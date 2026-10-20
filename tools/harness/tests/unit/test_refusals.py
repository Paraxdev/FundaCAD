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
        self.tools: dict[str, str] = {}
        self.running: str | None = None
        self.mode = "model"
        self.prompt = ""
        self.on_click = lambda: None

    def call(self, method, **args):
        if method == "seq":
            return 0
        if method == "messages":
            return {"seq": 0, "rows": []}
        if method == "status":
            return {"mode": self.mode, "tool": self.running, "prompt": self.prompt}
        if method == "toolPath":
            if args["label"] not in self.tools:
                raise NotFound(f'no tool "{args["label"]}"')
            return {"steps": [{"ref": self.tools[args["label"]], "button": "left"}]}
        if method == "screen":
            return {"lines": [r for r in self.rows if not args.get("region") or r[5] == args["region"]]}
        if method == "locate":
            row = next(r for r in self.rows if r[1] == args["target"])
            self.clicked.append(row[1])
            self.on_click()
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


def test_a_command_that_is_a_tool_says_to_use_tool():
    rows = [PALETTE]
    s = session(rows, on_key=lambda k: rows.clear() if k == "Escape" else None)
    s.bridge.tools["Sphere"] = "pick:sphere"
    with pytest.raises(NotFound, match=r'nothing matches, it is a tool, start it with tool\("Sphere"\)'):
        s.command("Sphere")
    s.close()


def test_a_tool_that_does_not_start_is_not_called_started():
    rows = [[1, "pick:extrude", "button", "Extrude", [], "toolrail"]]
    s = session(rows)
    s.bridge.tools["Extrude"] = "pick:extrude"
    assert str(s.tool("Extrude")).startswith('clicked pick:extrude "Extrude", no tool, mode or prompt changed after it, mode model')
    s.bridge.running = "Extrude"
    assert str(s.tool("Extrude")).startswith('started pick:extrude "Extrude", mode model, tool Extrude')
    s.close()


def test_a_tool_that_shows_no_running_button_is_started_by_its_mode_or_prompt():
    rows = [[1, "action:sketch", "button", "Sketch", [], "toolrail"], [2, "action:line", "button", "Line", [], "toolrail"]]
    s = session(rows)
    s.bridge.tools.update({"Sketch": "action:sketch", "Line": "action:line"})
    s.bridge.on_click = lambda: setattr(s.bridge, "prompt", "Select a plane or a face to sketch on")
    assert str(s.tool("Sketch")).startswith('started action:sketch "Sketch"')
    s.bridge.on_click = lambda: setattr(s.bridge, "mode", "sketch")
    assert str(s.tool("Line")).startswith('started action:line "Line"')
    s.bridge.on_click = lambda: None
    assert "no tool, mode or prompt changed" in str(s.tool("Line"))
    s.close()


def test_a_command_names_the_match_it_ran():
    rows = [PALETTE, [1, 'text:"Fit to Model"', "button", "Fit to Model", [], "dialog"]]
    s = session(rows, on_key=lambda k: rows.clear() if k == "Enter" else None)
    assert str(s.command("fit")).startswith('ran command "Fit to Model"')
    s.close()


def test_the_items_panel_is_found_by_its_hide_button_and_closed():
    rows = [[1, 'text:"Hide the items (Ctrl Alt S)"', "button", "Hide the items (Ctrl Alt S)", [], "items"]]
    s = session(rows)
    assert str(s.panel("items")).startswith("items already open")
    assert str(s.panel("Items", open=False)).startswith('closed text:"Hide the items')
    s.close()


def test_a_closed_panel_with_no_button_opens_by_its_keys():
    s = session([])
    assert str(s.panel("items")).startswith("opened items with Ctrl+Alt+S")
    assert s.page.keys == ["Control+Alt+s"]
    s.close()


def test_preferences_opens_from_the_menu_item_with_an_ellipsis():
    rows = [[1, "menu:Edit", "button", "Edit", [], "menu"], [1, "menu:Edit/Preferences…", "button", "Preferences…", [], "menu"]]
    s = session(rows)
    s.panel("preferences")
    assert s.bridge.clicked == ["menu:Edit", "menu:Edit/Preferences…"]
    s.close()


def test_a_file_is_not_written_into_a_folder_that_is_not_there(tmp_path):
    from fundacad_harness.actions import out_path
    from fundacad_harness.errors import BadArgs
    with pytest.raises(BadArgs, match="no folder"):
        out_path(tmp_path / "c" / "Users" / "box.funda")
    assert not (tmp_path / "c").exists()
    assert out_path(tmp_path / "box.funda") == (tmp_path / "box.funda").resolve()


def test_a_second_session_in_one_process_is_told_why(monkeypatch):
    import playwright.sync_api as api
    from fundacad_harness.errors import LaunchError

    class Busy:
        def start(self):
            raise api.Error("It looks like you are using Playwright Sync API inside the asyncio loop.")

    monkeypatch.setattr(api, "sync_playwright", lambda: Busy())
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    with pytest.raises(LaunchError, match="process of its own"):
        s._launch_browser()
    s.close()


def test_every_public_call_says_what_it_does():
    missing = [n for n in dir(Session) if not n.startswith("_") and callable(getattr(Session, n)) and not getattr(Session, n).__doc__]
    assert missing == []
    assert "docs/HARNESS.md" in Session.__doc__

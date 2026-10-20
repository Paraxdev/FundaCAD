import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session, actions
from fundacad_harness.errors import HarnessError

REPO = Path(__file__).resolve().parents[4]
BLOCK = str(REPO / "tools/harness/fixtures/block.json")
QUESTION = [[1, "choice:Discard", "button", "Discard", []], [1, "choice:Cancel", "button", "Cancel", []]]


class App:
    """A dirty plate.json: opening another file or Ctrl+N asks first, Discard opens what was picked."""

    def __init__(self, opens=True):
        self.doc, self.dirty, self.rows, self.opens = "plate.json", True, [], opens
        self.clicked: list[str] = []

    def pick(self, name):
        if self.dirty:
            self.rows = list(QUESTION)
            self.next = name
        elif self.opens:
            self.doc = name

    def call(self, method, **args):
        if method == "seq":
            return 0
        if method == "messages":
            return {"seq": 0, "rows": []}
        if method == "status":
            return {"mode": "model", "doc": self.doc, "dirty": self.dirty}
        if method == "screen":
            return {"lines": self.rows if args.get("region") in (None, "dialog") else []}
        if method == "locate":
            t = args["target"]
            self.clicked.append(t)
            if t == "choice:Discard":
                self.rows, self.dirty = [], False
                if self.opens:
                    self.doc = self.next
            elif t == "choice:Cancel":
                self.rows = []
            return {"marker": "m", "ref": t, "label": t}
        raise AssertionError(method)


def session(app):
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    s.bridge = app
    s.page = types.SimpleNamespace(
        keyboard=types.SimpleNamespace(press=lambda k: app.pick("Untitled") if k == "Control+N" else None),
        wait_for_timeout=lambda ms: None,
        locator=lambda sel: types.SimpleNamespace(click=lambda **k: None),
    )
    s.settle = lambda *a, **k: "settled"
    s._choose_file = lambda menu, path: (app.pick(Path(path).name), str(path))[1]
    return s


def test_open_file_over_unsaved_changes_discards_them_and_opens():
    app = App()
    s = session(app)
    assert str(s.open_file(BLOCK)).startswith("opened block.json,")
    assert app.clicked == ["choice:Discard"] and app.doc == "block.json"
    s.close()


def test_open_file_keeping_unsaved_changes_cancels_and_says_so():
    app = App()
    s = session(app)
    with pytest.raises(HarnessError, match="unsaved changes, pass discard=True"):
        s.open_file(BLOCK, discard=False)
    assert app.clicked == ["choice:Cancel"] and app.doc == "plate.json" and not app.rows
    s.close()


def test_open_file_that_leaves_the_old_document_says_it_did_not_open(monkeypatch):
    monkeypatch.setattr(actions, "OPEN_WAIT_S", 0.1)
    app = App(opens=False)
    app.dirty = False
    s = session(app)
    with pytest.raises(HarnessError, match='did not open block.json, the document is still "plate.json"'):
        s.open_file(BLOCK)
    s.close()


def test_new_document_keeping_unsaved_changes_cancels_and_says_so():
    app = App()
    s = session(app)
    with pytest.raises(HarnessError, match="pass discard=True"):
        s.new_document(discard=False)
    assert app.clicked == ["choice:Cancel"] and not app.rows
    assert str(s.new_document()).startswith("new document")
    assert app.clicked[-1] == "choice:Discard"
    s.close()


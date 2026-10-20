import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session, actions
from fundacad_harness.errors import HarnessError, Occluded

REPO = Path(__file__).resolve().parents[4]
BLOCK = str(REPO / "tools/harness/fixtures/block.json")
QUESTION = [[1, "choice:Discard", "button", "Discard", []], [1, "choice:Cancel", "button", "Cancel", []]]


class App:
    """A dirty plate.json: opening another file or Ctrl+N asks first, Discard opens what was picked."""

    def __init__(self, opens=True):
        self.doc, self.dirty, self.rows, self.opens = "plate.json", True, [], opens
        self.clicked: list[str] = []
        self.errors: list[str] = []
        self.features = ["e1"]

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
            return {"seq": 0, "rows": [{"level": "error", "text": t} for t in self.errors]}
        if method == "history":
            return {"count": len(self.features), "rows": list(self.features)}
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
        if method == "facePoint":
            raise Occluded('face body1:index=1 -y area 480 cannot be clicked from this view, try s.view("front")')
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


def test_a_canvas_pick_under_a_dialog_says_the_dialog_is_the_cause():
    app = App()
    app.rows = list(QUESTION)
    s = session(app)
    with pytest.raises(Occluded, match=r"a dialog is open over the canvas \(choice:Discard, choice:Cancel\)"):
        s.pick_face("front")
    app.rows = []
    with pytest.raises(Occluded, match='try s.view\\("front"\\)'):
        s.pick_face("front")
    s.close()


class Counts(App):
    def __init__(self, steps):
        super().__init__()
        self.steps, self.at = steps, 0

    def call(self, method, **args):
        if method == "history":
            return {"count": self.steps[self.at][0]}
        if method == "bodies":
            return [{}] * self.steps[self.at][1]
        if method == "locate":
            self.at += 1
            return {"marker": "m", "ref": args["target"], "label": args["target"]}
        return super().call(method, **args)


def test_undo_says_what_changed_and_when_nothing_counted_did():
    app = Counts([(2, 8), (2, 8), (1, 1)])
    s = session(app)
    assert str(s.undo()).startswith("clicked #undo-btn, still 2 features and 8 bodies,")
    assert str(s.undo()).startswith("clicked #undo-btn, features 2 to 1, bodies 8 to 1,")
    s.close()


def test_open_file_of_a_refused_file_with_the_open_documents_name_says_it_did_not_open():
    app = App(opens=False)
    app.dirty = False
    s = session(app)
    s._choose_file = lambda menu, path: (app.errors.append("This file is not a FundaCAD document"), str(path))[1]
    with pytest.raises(HarnessError, match='did not open plate.json, .*error: This file is not a FundaCAD document'):
        s.open_file(REPO / "tools/harness/fixtures/plate.json")
    s.close()


def test_open_file_whose_model_fails_to_build_still_opened():
    app = App()
    app.dirty = False
    s = session(app)

    def pick(menu, path):
        app.doc, app.features = Path(path).name, ["e1", "f9"]
        app.errors.append("Fillet failed")
        return str(path)

    s._choose_file = pick
    assert str(s.open_file(BLOCK)).startswith("opened block.json,")
    s.close()

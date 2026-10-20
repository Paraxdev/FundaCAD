import atexit
import contextlib
import sys
import types
from pathlib import Path

from fundacad_harness import Session
from fundacad_harness.recorder import Recorder, literal

REPO = Path(__file__).resolve().parents[4]

LABELS = {
    "Extrude": ("pick:extrude", "Extrude"),
    "D": ("field:distance", "Distance"),
    "Extrude 1": ("feature:e1", "Extrude 1"),
    "Delete": ("ctx:Delete", "Delete"),
    "menu:File": ("menu:File", "File"),
    "menu:File/Open…": ("menu:File/Open…", "Open…"),
    "#undo-btn": ("#undo-btn", "Undo"),
}


class StubBridge:
    def call(self, method, **args):
        if method == "locate":
            by_ref = {ref: (ref, label) for ref, label in LABELS.values()}
            ref, label = LABELS.get(args["target"]) or by_ref[args["target"]]
            return {"marker": "m", "ref": ref, "label": label}
        if method == "status":
            return {"mode": "selection"}
        if method == "fieldValue":
            return {"text": "7", "typed": "7", "problem": None}
        if method == "toolPath":
            return {"steps": [{"ref": "pick:extrude", "button": "left"}]}
        if method == "screen":
            return {"lines": [[0, "menu:File", "button", "File", []], [1, "menu:File/Open…", "button", "Open…", []]]}
        if method == "messages":
            return {"seq": 0, "rows": [{"seq": 1, "level": "info", "text": "Saved", "at": 0}]}
        if method in ("facePoint", "sketchPoint"):
            return {"x": 1, "y": 2, "what": "body1 face 5 (+z)", "covered": False}
        if method == "settle":
            return {"ms": 1}
        raise AssertionError(method)


class Anything:
    def __getattr__(self, name):
        return lambda *a, **k: None


class StubPage(Anything):
    keyboard = Anything()
    mouse = Anything()

    def locator(self, _sel):
        return Anything()

    @contextlib.contextmanager
    def expect_file_chooser(self, **_):
        yield types.SimpleNamespace(value=Anything())


def stub_session(path):
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, record=path, open=False)
    s.bridge = StubBridge()
    s.page = StubPage()
    s.settle = lambda *a, **k: "settled"
    return s


def walk(s):
    s.tool("Extrude")
    s.type("D", "7", enter=True)
    s.click("face:body1:top")
    s.context_menu("Extrude 1", "Delete")
    s.open_file(REPO / "tools/harness/fixtures/plate.json")
    s.undo(settle=False)
    s.wait_for("saved")
    s.click_at(sketch=(10, 5))


def test_the_recording_names_refs_and_keeps_labels_as_comments(tmp_path):
    out = tmp_path / "walk.py"
    s = stub_session(out)
    walk(s)
    s.close()
    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines[0].startswith("# Recorded by fundacad-harness 0.1.0, driver api 1, ")
    assert lines[1:4] == ["from fundacad_harness import Session", "", "with Session() as s:"]
    assert lines[4:] == [
        '    s.tool("Extrude")  # pick:extrude',
        '    s.type("field:distance", "7", enter=True)  # "Distance"',
        '    s.click("face:body1:top")',
        '    s.context_menu("feature:e1", "ctx:Delete")  # "Extrude 1", "Delete"',
        '    s.open_file("tools/harness/fixtures/plate.json")',
        "    s.undo(settle=False)",
        '    s.wait_for("saved")',
        "    s.click_at(sketch=(10, 5))",
    ]


def test_the_recording_compiles_and_replays_the_same_calls(tmp_path, monkeypatch):
    out = tmp_path / "walk.py"
    s = stub_session(out)
    walk(s)
    s.close()
    made = []

    class Replaying(Session):
        def __init__(self, **kw):
            made.append(kw)
            stub = stub_session(tmp_path / "again.py")
            atexit.unregister(stub.close)
            self.__dict__.update(stub.__dict__)

    monkeypatch.setattr("fundacad_harness.Session", Replaying)
    exec(compile(out.read_text(encoding="utf-8"), str(out), "exec"), {"__name__": "__main__"})
    assert made == [{}]
    assert (tmp_path / "again.py").read_text(encoding="utf-8").splitlines()[4:] == out.read_text(encoding="utf-8").splitlines()[4:]
    assert len(s.recorder.calls) == 8


def test_nested_actions_record_once_and_failures_not_at_all(tmp_path):
    out = tmp_path / "walk.py"
    s = stub_session(out)
    s.menu("File/Open...")
    try:
        s.click("nothing there")
    except KeyError:
        pass
    s.close()
    body = out.read_text(encoding="utf-8").splitlines()[4:]
    assert body == ['    s.menu("File/Open...")']


def test_session_options_that_matter_are_kept_and_literals_read_back():
    r = Recorder("x.py", REPO, "0.1.0", 1, {"viewport": (800, 600)})
    assert "with Session(viewport=(800, 600)) as s:" in r.source()
    assert "    pass" in r.source()
    for v in ["a \"quoted\" …", (1.5, -2), [1, "Ctrl"], None, True, 3]:
        assert eval(literal(v)) == v

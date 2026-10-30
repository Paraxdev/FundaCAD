"""Ctrl+Z in the open Stress panel takes back a support's faces and leaves the model alone,
Ctrl+Y puts them back, and once Stress closes Ctrl+Z undoes the model again.

Run with `python tools/harness/examples/stress_panel_undo.py`.
"""

import sys

from fundacad_harness import Session

PLATE = "tools/harness/fixtures/plate.json"


def support_faces(s):
    row = s.page.locator(".stress-item").filter(has_text="Support 1")
    return row.locator(".stress-count").inner_text().strip()


def notes(s, since):
    return [r["text"] for r in s.messages(since=since, raw=True)["rows"]]


def model(s):
    return s.history(raw=True)["count"], s.bodies(raw=True)


def run(s, shot=None):
    s.open_file(PLATE)
    s.view("iso")
    s.pick_face("top")
    s.tool("Press/Pull")
    s.type("D", "4", enter=True)
    assert s.history(raw=True)["count"] == 2, s.history()

    s.command("stress")
    s.page.get_by_role("button", name="Close Stress").wait_for()
    s.pick_face("top")
    s.page.locator(".stress-set-support").first.click()
    s.settle()
    assert support_faces(s) == "1 face", support_faces(s)
    before = model(s)

    mark = s.messages(raw=True)["seq"]
    s.press("Ctrl+Z")
    s.settle()
    assert support_faces(s) == "No faces yet", support_faces(s)
    assert "Undid: Support 1 faces" in notes(s, mark), notes(s, mark)
    assert model(s) == before, "Ctrl+Z in Stress leaves the model alone"
    if shot:
        s.screenshot(shot)

    mark = s.messages(raw=True)["seq"]
    s.press("Ctrl+Z")
    s.settle()
    assert "Nothing left to undo in Stress" in notes(s, mark), notes(s, mark)
    assert model(s) == before, "nothing left to undo still leaves the model alone"

    mark = s.messages(raw=True)["seq"]
    s.press("Ctrl+Y")
    s.settle()
    assert support_faces(s) == "1 face", support_faces(s)
    assert "Redid: Support 1 faces" in notes(s, mark), notes(s, mark)
    assert model(s) == before

    s.page.get_by_role("button", name="Close Stress").click()
    s.settle()
    s.press("Ctrl+Z")
    s.settle()
    assert s.history(raw=True)["count"] == 1, "with Stress closed Ctrl+Z undoes the model"
    assert not s.page_errors(), s.page_errors()


if __name__ == "__main__":
    with Session() as s:
        run(s, sys.argv[1] if len(sys.argv) > 1 else None)
    print("stress panel undo: all checks passed")

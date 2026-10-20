"""Reopening an extrude that covers its whole sketch reselects the area, so the edit is live,
while an extrude whose named area is really gone still says so.

Port of e2e/extrude_reedit_e2e.cjs. Run with `python tools/harness/examples/extrude_reedit.py`.
"""

from fundacad_harness import Session

DOC = "tools/harness/fixtures/whole_sketch_extrude.json"


def gone(s):
    return "areas are gone" in s.status(raw=True)["prompt"].lower()


def run(s):
    s.open_file(DOC)
    s.view("fit")
    assert len(s.bodies(raw=True)) == 2, s.bodies()

    s.click("feature:e", double=True)
    assert s.status(raw=True)["tool"], s.status()
    assert not gone(s), s.status()
    assert any(h.startswith("depth at") for h in s.handles(raw=True)), s.handles()
    s.press("Escape")
    assert len(s.bodies(raw=True)) == 2, "Escape ends the edit and the body is back"

    # Note: while e's values are open under its row, the first click of a double click on e2
    # closes them, e2 moves up, and the second click lands below it. A second Escape closes them.
    s.press("Escape")
    s.click("feature:e2", double=True)
    assert gone(s), s.status()
    s.press("Escape")


if __name__ == "__main__":
    with Session() as s:
        run(s)
    print("extrude reedit: all checks passed")

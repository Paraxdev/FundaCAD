"""Enter on a draft the kernel refuses keeps the tool open and says why, an angle that builds
then commits one draft.

Port of e2e/refused_commit_e2e.cjs. Run with `python tools/harness/examples/refused_commit.py`.
"""

from fundacad_harness import Session

BLOCK = "tools/harness/fixtures/block.json"


def drafts(s):
    return sum(r["type"] == "draft" for r in s.history(raw=True)["rows"])


def run(s):
    s.open_file(BLOCK)
    s.view("iso")
    s.pick_face("right")
    s.tool("Draft")
    assert s.status(raw=True)["tool"], s.status()

    s.type("Angle", "45")
    assert "refused" in s.status(raw=True)["prompt"].lower(), s.status()
    s.press("Enter")
    assert drafts(s) == 0, "a refused draft is not committed"
    assert s.status(raw=True)["tool"], "the tool stays open"
    assert "refused" in s.status(raw=True)["prompt"].lower(), s.status()
    assert s.last_error() != "none"

    s.type("Angle", "10", enter=True)
    assert drafts(s) == 1, s.history()
    assert s.last_error() == "none", s.last_error()


if __name__ == "__main__":
    with Session() as s:
        run(s)
    print("refused commit: all checks passed")

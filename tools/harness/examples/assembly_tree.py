"""A STEP assembly dropped on the canvas shows as a collapsed tree in Items, the eye on a
subassembly hides every body under it, and the tree survives a save and reopen.

Port of e2e/assembly_tree_e2e.cjs. Run with `python tools/harness/examples/assembly_tree.py`.
"""

import json
import tempfile
from pathlib import Path

from fundacad_harness import Session

STEP = "tests/fixtures/asm_nested.step"


def tree(s):
    """The Items rows as {label: (ref, flags)}, the last row of a repeated label wins."""
    return {r[3]: (r[1], r[4]) for r in s.screen(region="items", raw=True)["lines"] if r[2] == "row"}


def labels(s):
    return [r[3] for r in s.screen(region="items", raw=True)["lines"] if r[2] == "row"]


def visible(s):
    return sum(b["visible"] for b in s.bodies(raw=True))


def run(s, work: Path):
    s.import_file(STEP)
    assert len(s.bodies(raw=True)) == 7, s.bodies()
    rows = tree(s)
    assert "closed" in rows["Robot"][1], "the assembly starts collapsed"
    assert "MCU" not in rows, "no part rows while the assembly is collapsed"

    for name in ("Robot", "Electronics", "Board#1"):
        s.expand(name)
    names = labels(s)
    assert "Header (x2)" in names, names
    assert names.count("Board") == 2, "both uses of the subassembly are listed"
    assert tree(s)["Chassis"][0] == "item:body7", "a one solid product is a row, not a folder"

    before = visible(s)
    electronics = tree(s)["Electronics"][0].removeprefix("folder:")
    s.click(f"eye:{electronics}")
    assert before - visible(s) == 6, s.bodies()

    saved = work / "assembly.funda"
    s.save_as(saved)
    kept = [(b["name"], b["visible"]) for b in s.bodies(raw=True)]
    s.new_document()
    s.open_file(saved)
    assert [(b["name"], b["visible"]) for b in s.bodies(raw=True)] == kept

    doc = json.loads(saved.read_text(encoding="utf-8"))
    part = next(f for f in doc["features"] if f["type"] == "import")
    part["nodes"][0]["name"] = "<img src=x onerror=alert(1)>"
    marked = work / "markup.funda"
    marked.write_text(json.dumps(doc), encoding="utf-8")
    s.open_file(marked)
    assert "<img src=x onerror=alert(1)>" in labels(s), "markup in a product name is shown as text"
    assert not s.page_errors(), s.page_errors()


if __name__ == "__main__":
    with Session() as s, tempfile.TemporaryDirectory() as work:
        run(s, Path(work))
    print("assembly tree: all checks passed")

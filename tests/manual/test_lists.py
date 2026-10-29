"""The manual and the README number their lists, nested ones as 1.1, instead of using bullet dots.

    python3 tests/manual/test_lists.py
"""

import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANUAL = ROOT / "manual"
BULLET = re.compile(r"^\s*[-*+]\s+\S")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")


def pages():
    yield from sorted((MANUAL / "docs").rglob("*.md"))
    yield from sorted((MANUAL / "includes").glob("*.md"))
    yield ROOT / "README.md"


def bullet_items(path):
    fence = None
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if fence:
            if re.fullmatch(rf"\s*{re.escape(fence[0])}{{{len(fence)},}}\s*", line):
                fence = None
            continue
        opened = FENCE.match(line)
        if opened:
            fence = opened[1]
        elif BULLET.match(line):
            yield number, line.strip()


class Lists(unittest.TestCase):
    def test_no_page_has_a_bullet_list(self):
        found = [f"{page.relative_to(ROOT).as_posix()}:{n}: {item}" for page in pages() for n, item in bullet_items(page)]
        if found:
            self.fail(f"{len(found)} bullet items, number them instead:\n" + "\n".join(found))

    def test_the_manual_stylesheet_numbers_nested_lists_as_1_1(self):
        project = tomllib.loads((MANUAL / "zensical.toml").read_text(encoding="utf-8"))["project"]
        sheets = [MANUAL / project.get("docs_dir", "docs") / name for name in project.get("extra_css", [])]
        self.assertTrue(sheets, "zensical.toml names no extra_css")
        for sheet in sheets:
            self.assertTrue(sheet.is_file(), f"{sheet} is missing")
        self.assertTrue(any("counters(" in sheet.read_text(encoding="utf-8") for sheet in sheets))


if __name__ == "__main__":
    unittest.main()

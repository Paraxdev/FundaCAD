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


def css_rules(css):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    for selector, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
        pairs = (line.split(":", 1) for line in body.split(";") if line.strip())
        yield " ".join(selector.split()), {name.strip(): value.strip() for name, value in pairs}


class Lists(unittest.TestCase):
    def test_no_page_has_a_bullet_list(self):
        found = [f"{page.relative_to(ROOT).as_posix()}:{n}: {item}" for page in pages() for n, item in bullet_items(page)]
        if found:
            self.fail(f"{len(found)} bullet items, number them instead:\n" + "\n".join(found))

    def test_nested_items_read_1_1_in_every_browser(self):
        config = tomllib.loads((MANUAL / "zensical.toml").read_text(encoding="utf-8"))["project"]
        sheets = [MANUAL / config.get("docs_dir", "docs") / name for name in config.get("extra_css", [])]
        self.assertTrue(sheets, "zensical.toml names no extra_css")
        for sheet in sheets:
            self.assertTrue(sheet.is_file(), f"{sheet} is missing")
        declared = [rule for sheet in sheets for rule in css_rules(sheet.read_text(encoding="utf-8"))]
        numbered = [(selector, block["content"]) for selector, block in declared if "content" in block]
        # Safari styles only color and font-size on ::marker, so the numbers must come from ::before.
        self.assertEqual(numbered, [(".md-typeset ol ol:not([type]) > li::before", 'counters(fc-step, ".") ". "')])
        self.assertIn((".md-typeset ol", {"counter-reset": "fc-step"}), declared)
        self.assertIn((".md-typeset ol > li", {"counter-increment": "fc-step"}), declared)
        self.assertIn((".md-typeset ol ol:not([type])", {"list-style-type": "none"}), declared)
        # sane_lists would write start=, and fc-step would then lag the step it sits under.
        self.assertNotIn("sane_lists", config.get("markdown_extensions", {}))


if __name__ == "__main__":
    unittest.main()

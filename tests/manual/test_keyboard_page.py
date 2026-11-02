"""The keys only sketch page is in the manual's navigation, every page that names drawing by keys links to it, and the
links in the pages it touches resolve.

    python3 tests/manual/test_keyboard_page.py
"""

import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "manual" / "docs"
PAGE = DOCS / "sketch" / "keyboard.md"
LINKERS = ["sketch/start.md", "sketch/exact-sizes.md", "sketch/snapping.md", "reference/shortcuts.md"]
LINK = re.compile(r"\]\(([^)#\s]+\.md)(?:#[^)]*)?\)")


def walk(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from walk(value)
    else:
        for value in node:
            yield from walk(value)


def lists_of(node):
    if isinstance(node, dict):
        for value in node.values():
            yield from lists_of(value)
    elif isinstance(node, list):
        yield node
        for value in node:
            yield from lists_of(value)


class KeyboardPage(unittest.TestCase):
    def test_the_page_sits_in_basics_right_after_exact_sizes(self):
        nav = tomllib.loads((ROOT / "manual" / "zensical.toml").read_text(encoding="utf-8"))["project"]["nav"]
        basics = next(group for group in lists_of(nav) if "sketch/exact-sizes.md" in group)
        self.assertEqual(basics[basics.index("sketch/exact-sizes.md") + 1], "sketch/keyboard.md")
        files = list(walk(nav))
        self.assertEqual(len(files), len(set(files)))
        for name in files:
            self.assertTrue((DOCS / name).is_file(), f"{name} is in the nav but missing")

    def test_the_pages_that_touch_drawing_link_to_it(self):
        for name in LINKERS:
            text = (DOCS / name).read_text(encoding="utf-8")
            targets = [(DOCS / name).parent.joinpath(m).resolve() for m in LINK.findall(text)]
            self.assertIn(PAGE.resolve(), targets, f"{name} does not link to keyboard.md")

    def test_the_page_says_its_key_facts(self):
        text = PAGE.read_text(encoding="utf-8")
        for fact in ["@5,3", "Shift+Enter", "Tab", "Esc", "grid step", "Items", "Extrude", "40", "20", "10"]:
            self.assertIn(fact, text)
        self.assertNotRegex(text.lower(), r"\b(best|most|fastest|easiest)\b")

    def test_the_page_quotes_the_words_the_last_tab_stop_says(self):
        page = PAGE.read_text(encoding="utf-8")
        speech = (ROOT / "src" / "sketch" / "sketchSpeech.ts").read_text(encoding="utf-8")
        self.assertIn('"No snap, cursor at 20, minus 20"', page)
        self.assertIn('"End of snaps, cursor at 20, minus 20, snapped to the end of Line 2"', page)
        self.assertIn("`cursor at ${coordWords(p.x, p.y)}`", speech)
        self.assertIn("`No snap, ${at}`", speech)
        self.assertIn("`End of snaps, ${at}, snapped to ", speech)

    def test_every_link_on_these_pages_resolves(self):
        for name in LINKERS + ["sketch/keyboard.md"]:
            path = DOCS / name
            for target in LINK.findall(path.read_text(encoding="utf-8")):
                if "://" not in target:
                    self.assertTrue((path.parent / target).resolve().is_file(), f"{name} links to missing {target}")


if __name__ == "__main__":
    unittest.main()

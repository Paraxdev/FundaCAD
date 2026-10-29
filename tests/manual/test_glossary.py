"""The hover definitions of the manual against its glossary page.

    python3 tests/manual/test_glossary.py
"""

import re
import unittest
from pathlib import Path

MANUAL = Path(__file__).resolve().parents[2] / "manual"
PAGE = MANUAL / "docs" / "reference" / "glossary.md"
HOVER = MANUAL / "includes" / "glossary.md"


def page_terms():
    text = PAGE.read_text(encoding="utf-8")
    return {m[1].lower(): m[2].strip() for m in re.finditer(r"^\*\*(.+?)\.\*\*\s+(.+)$", text, re.M)}


def hover_forms():
    text = HOVER.read_text(encoding="utf-8")
    return [(m[1], m[2].strip()) for m in re.finditer(r"^\*\[(.+?)\]:\s+(.+)$", text, re.M)]


class Glossary(unittest.TestCase):
    def test_hover_text_of_a_page_term_is_its_page_definition(self):
        terms = page_terms()
        stale = [(form, text) for form, text in hover_forms() if form.lower() in terms and text != terms[form.lower()]]
        self.assertEqual(stale, [])


if __name__ == "__main__":
    unittest.main()

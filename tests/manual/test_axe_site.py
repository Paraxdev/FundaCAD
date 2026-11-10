"""The manual's axe walk: the pages it visits, how it reads an animation, and its baseline.

    python3 tests/manual/test_axe_site.py
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "manual" / "tools" / "axe_site.py"
spec = importlib.util.spec_from_file_location("axe_site", TOOL)
axe_site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(axe_site)

GIF = {"src": "../../img/orbit.gif", "button": "Pause animation"}
STILL = {"src": "../../img/orbit-still.png", "button": "Play animation"}


class Pages(unittest.TestCase):
    def test_a_page_is_visited_at_its_directory_url_and_the_theme_files_are_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp)
            for rel in ("index.html", "404.html", "model/extrude/index.html", "assets/javascripts/a.html"):
                (site / rel).parent.mkdir(parents=True, exist_ok=True)
                (site / rel).write_text("<html></html>", encoding="utf-8")
            self.assertEqual(sorted(axe_site.page_urls(site)), ["/", "/404.html", "/model/extrude/"])


class Motion(unittest.TestCase):
    def test_a_playing_animation_shows_its_gif_and_offers_pause(self):
        self.assertEqual(axe_site.motion_problems([GIF], True, "p"), [])
        self.assertEqual(len(axe_site.motion_problems([STILL], True, "p")), 1)

    def test_a_resting_animation_shows_its_still_and_offers_play(self):
        self.assertEqual(axe_site.motion_problems([STILL], False, "p"), [])
        self.assertEqual(len(axe_site.motion_problems([GIF], False, "p")), 1)

    def test_an_animation_without_its_button_is_a_problem(self):
        bare = {"src": STILL["src"], "button": None}
        self.assertEqual(len(axe_site.motion_problems([bare], False, "p")), 1)

    def test_the_walk_expects_the_labels_the_script_writes(self):
        script = (ROOT / "manual" / "docs" / "javascripts" / "motion.js").read_text(encoding="utf-8")
        for label in (GIF["button"], STILL["button"]):
            self.assertIn(f'"{label}"', script)


class Baseline(unittest.TestCase):
    def test_each_entry_names_a_mode_and_allows_at_least_one_node(self):
        allowed = json.loads(axe_site.BASELINE.read_text(encoding="utf-8"))
        schemes = {scheme for scheme, _, _ in axe_site.MODES}
        for key, rules in allowed.items():
            self.assertIn(key.split(": ", 1)[0], schemes, key)
            self.assertTrue(rules and all(n > 0 for n in rules.values()), key)


if __name__ == "__main__":
    unittest.main()

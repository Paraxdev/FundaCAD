"""The fundacad.dev home pages (manual/tools/build_home.py) and how build_versions.py puts them at the root.

    python3 tests/manual/test_home.py
"""

import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "manual" / "tools"))

import build_home as bh  # noqa: E402
import build_versions as bv  # noqa: E402

SITE = "https://fundacad.dev/"


def post(folder: Path, name: str, text: str) -> Path:
    path = folder / name
    path.write_text(text, encoding="utf-8")
    return path


class Posts(unittest.TestCase):
    def setUp(self):
        self.dir = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def test_a_post_reads_its_front_matter_and_renders_markdown(self):
        p = bh.parse_post(post(self.dir, "2026-11-26-hello.md", "---\ntitle: Hello\ndate: 2026-11-26\nsummary: Hi.\n---\nSome *text*.\n"))
        self.assertEqual((p.slug, p.title, p.summary), ("hello", "Hello", "Hi."))
        self.assertIn("<em>text</em>", p.body)

    def test_a_post_without_a_summary_fails(self):
        with self.assertRaises(ValueError):
            bh.parse_post(post(self.dir, "2026-11-26-hello.md", "---\ntitle: Hello\ndate: 2026-11-26\n---\nText\n"))

    def test_a_date_that_differs_from_the_name_fails(self):
        with self.assertRaises(ValueError):
            bh.parse_post(post(self.dir, "2026-11-26-hello.md", "---\ntitle: Hello\ndate: 2026-11-25\nsummary: Hi.\n---\nText\n"))

    def test_posts_are_newest_first(self):
        post(self.dir, "2026-01-02-old.md", "---\ntitle: Old\ndate: 2026-01-02\nsummary: a\n---\nx\n")
        post(self.dir, "2026-03-04-new.md", "---\ntitle: New\ndate: 2026-03-04\nsummary: b\n---\nx\n")
        self.assertEqual([p.slug for p in bh.load_posts(self.dir)], ["new", "old"])


class Build(unittest.TestCase):
    def test_the_real_pages_build_with_a_feed_and_the_shared_header(self):
        out = Path(self.enterContext(tempfile.TemporaryDirectory()))
        paths = bh.build(out, SITE)
        self.assertEqual(paths[:3], ["", "download/", "news/"])
        for path in paths:
            page = (out / path / "index.html").read_text(encoding="utf-8")
            self.assertIn('data-md-component="palette"', page)
            self.assertIn('class="fc-site-nav"', page)
        feed = ET.parse(out / "news" / "feed.xml").getroot()
        entries = feed.findall("{http://www.w3.org/2005/Atom}entry")
        self.assertEqual(len(entries), len(paths) - 3)
        for name in ("site.css", "home.css", "home.js", "hero.jpg"):
            self.assertTrue((out / "static" / name).is_file(), name)

    def test_the_root_holds_the_landing_in_place_of_the_redirect(self):
        out = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (out / "beta").mkdir()
        urls = "".join(f"<url><loc>{SITE}beta/{p}</loc></url>" for p in ("", "start/install/"))
        (out / "beta" / "sitemap.xml").write_text(
            f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>', encoding="utf-8")
        (out / "beta" / "404.html").write_text("<html><head></head><body></body></html>", encoding="utf-8")
        bv.write_root(out, SITE, ["beta"], "beta", home=lambda folder: bh.build(folder, SITE))
        root = (out / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("location.replace", root)
        self.assertIn("fc-hero", root)
        self.assertIn("location.replace", (out / "start" / "install" / "index.html").read_text(encoding="utf-8"))
        self.assertIn(f"{SITE}sitemap-home.xml", (out / "sitemap.xml").read_text(encoding="utf-8"))

    def test_a_manual_page_in_a_home_folder_fails(self):
        out = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (out / "beta").mkdir()
        (out / "beta" / "sitemap.xml").write_text(
            f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>{SITE}beta/news/</loc></url></urlset>',
            encoding="utf-8")
        with self.assertRaises(ValueError):
            bv.write_root(out, SITE, ["beta"], "beta")


if __name__ == "__main__":
    unittest.main()

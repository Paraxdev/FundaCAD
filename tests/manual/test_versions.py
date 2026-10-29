"""The parts of the versioned manual build that need no zensical run.

    python3 tests/manual/test_versions.py
"""

import json
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "manual" / "tools"))

import build_versions as bv  # noqa: E402

SITE = "https://fundacad.dev/"
CONFIG = """[project]
site_name = "FundaCAD"
site_url = "https://fundacad.dev/"
docs_dir = "docs"

[project.theme]
custom_dir = "overrides"
"""


def sitemap(locs):
    urls = "".join(f"<url><loc>{loc}</loc></url>" for loc in locs)
    return f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>'


class PatchConfig(unittest.TestCase):
    def test_sets_the_url_the_folder_and_the_version_switch(self):
        project = tomllib.loads(bv.patch_config(CONFIG, "dev", SITE, "beta"))["project"]
        self.assertEqual(project["site_url"], "https://fundacad.dev/dev/")
        self.assertEqual(project["site_dir"], "site/versioned-dev")
        self.assertEqual(project["extra"]["version"], {"provider": "mike", "default": "beta"})
        self.assertEqual(project["site_name"], "FundaCAD")
        self.assertEqual(project["theme"], {"custom_dir": "overrides"})

    def test_patching_twice_changes_nothing_more(self):
        once = bv.patch_config(CONFIG, "beta", SITE, "beta")
        self.assertEqual(bv.patch_config(once, "beta", SITE, "beta"), once)

    def test_an_existing_site_dir_is_replaced(self):
        text = CONFIG.replace('docs_dir = "docs"', 'site_dir = "public"\ndocs_dir = "docs"')
        self.assertEqual(tomllib.loads(bv.patch_config(text, "beta", SITE, "beta"))["project"]["site_dir"], "site/versioned-beta")

    def test_a_config_without_site_url_fails(self):
        with self.assertRaises(ValueError):
            bv.patch_config(CONFIG.replace('site_url = "https://fundacad.dev/"\n', ""), "beta", SITE, "beta")

    def test_the_real_manual_config_keeps_its_nav(self):
        text = (REPO / "manual" / "zensical.toml").read_text(encoding="utf-8")
        before = tomllib.loads(text)["project"]
        after = tomllib.loads(bv.patch_config(text, "beta", before["site_url"], "beta"))["project"]
        self.assertEqual(after["nav"], before["nav"])
        self.assertEqual(after["site_url"], before["site_url"] + "beta/")


class RootFiles(unittest.TestCase):
    def test_versions_json_is_in_mike_format_in_the_given_order(self):
        self.assertEqual(
            json.loads(bv.versions_json(["beta", "dev"])),
            [{"version": "beta", "title": "Beta", "aliases": []}, {"version": "dev", "title": "Dev", "aliases": []}],
        )

    def test_a_stub_sends_its_old_path_to_the_default_version_and_keeps_the_hash(self):
        html = bv.stub_html("start/install/", SITE, "beta")
        self.assertIn('url=../../beta/start/install/"', html)
        self.assertIn('location.replace("../../beta/start/install/" + location.search + location.hash)', html)
        self.assertIn('<link rel="canonical" href="https://fundacad.dev/beta/start/install/">', html)

    def test_the_root_stub_opens_the_default_home(self):
        self.assertIn('location.replace("beta/" + location.search + location.hash)', bv.stub_html("", SITE, "beta"))

    def test_robots_lists_the_default_sitemap_and_hides_the_others(self):
        text = bv.robots_txt(SITE, ["beta", "dev"], "beta")
        self.assertIn("Disallow: /dev/\n", text)
        self.assertNotIn("Disallow: /beta/", text)
        self.assertIn("Sitemap: https://fundacad.dev/beta/sitemap.xml\n", text)

    def test_the_404_page_sends_paths_outside_the_versions_to_the_default(self):
        html = bv.redirect_404("<html><head><title>x</title></head><body></body></html>", SITE, ["beta", "dev"], "beta")
        head = html.split("</head>")[0]
        self.assertIn('["beta", "dev"]', head)
        self.assertIn('base + "beta/" + rest', head)

    def test_a_404_page_without_a_head_fails(self):
        with self.assertRaises(ValueError):
            bv.redirect_404("<html><body></body></html>", SITE, ["beta", "dev"], "beta")


class WriteRoot(unittest.TestCase):
    def tree(self, pages):
        out = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name in ("beta", "dev"):
            (out / name).mkdir()
            (out / name / "sitemap.xml").write_text(sitemap(f"{SITE}{name}/{p}" for p in pages), encoding="utf-8")
            (out / name / "404.html").write_text("<html><head></head><body>gone</body></html>", encoding="utf-8")
        return out

    def test_every_default_page_gets_a_stub_at_its_old_path(self):
        out = self.tree(["", "start/install/", "model/extrude/"])
        bv.write_root(out, SITE, ["beta", "dev"], "beta")
        for page in ("", "start/install/", "model/extrude/"):
            self.assertIn(f'href="{SITE}beta/{page}"', (out / page / "index.html").read_text(encoding="utf-8"))
        self.assertEqual([v["version"] for v in json.loads((out / "versions.json").read_text(encoding="utf-8"))], ["beta", "dev"])
        self.assertIn("location.replace", (out / "404.html").read_text(encoding="utf-8"))
        self.assertIn(f"{SITE}beta/sitemap.xml", (out / "sitemap.xml").read_text(encoding="utf-8"))
        self.assertTrue((out / "robots.txt").is_file())

    def test_a_page_outside_its_version_url_fails(self):
        out = self.tree(["start/install/"])
        (out / "beta" / "sitemap.xml").write_text(sitemap([f"{SITE}start/install/"]), encoding="utf-8")
        with self.assertRaises(ValueError):
            bv.write_root(out, SITE, ["beta", "dev"], "beta")

    def test_a_page_whose_old_path_is_a_version_folder_fails(self):
        out = self.tree(["dev/notes/"])
        with self.assertRaises(ValueError):
            bv.write_root(out, SITE, ["beta", "dev"], "beta")


if __name__ == "__main__":
    unittest.main()

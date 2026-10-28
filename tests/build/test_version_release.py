"""The release job's step that keeps every beta as a normal release of its own.

    python3 tests/build/test_version_release.py

The step's script from build.yml runs in bash with gh replaced by a function
that logs each call and answers from the case's fixtures.
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.join(HERE, "..", "..", ".github", "workflows", "build.yml")
SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"
NOTES = "> ### Read this first\n\nRolling FundaCAD 1.0 beta (1.0.412), Rust engine, rebuilt from `main`.\n\n## Changes\n"

# $1 is the gh subcommand group, $2 the verb. STABLE, EXISTS and REFUSE come from the case.
GH = r"""gh() {
  printf '%s\n' "$*" >> calls.log
  case "$1 $2" in
    "release list") printf '%s' "$STABLE" ;;
    "release view") [ -n "$EXISTS" ] ;;
    "release create") [ -z "$REFUSE" ] ;;
    *) return 0 ;;
  esac
}
"""


def step_script():
    with open(WORKFLOW, encoding="utf-8", newline="") as f:
        text = f.read().replace("\r\n", "\n")
    start = text.index("- name: Publish this version's own release")
    body = text[text.index("run: |\n", start) + len("run: |\n"):]
    body = body[: body.index("\n\n")]
    script = re.sub(r"^ {10}", "", body, flags=re.M)
    return script.replace("'${{ github.repository }}'", "'o/r'")


BASH = shutil.which("bash")


@unittest.skipUnless(BASH, "needs bash")
class VersionRelease(unittest.TestCase):
    def run_step(self, stable="", exists="", refuse=""):
        cwd = tempfile.mkdtemp(prefix="verrel-")
        self.addCleanup(shutil.rmtree, cwd, True)
        os.makedirs(os.path.join(cwd, "release"))
        for name in ("FundaCAD-windows-x64-setup.exe", "plugin-screws.zip"):
            open(os.path.join(cwd, "release", name), "w").close()
        with open(os.path.join(cwd, "notes.md"), "w", newline="\n") as f:
            f.write(NOTES)
        env = {**os.environ, "VERSION": "1.0.412", "SHA": SHA, "STABLE": stable, "EXISTS": exists, "REFUSE": refuse}
        out = subprocess.run([BASH, "-c", GH + step_script()], cwd=cwd, env=env, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        with open(os.path.join(cwd, "calls.log")) as f:
            calls = [c for c in f.read().splitlines() if not c.startswith(("release list", "release view"))]
        with open(os.path.join(cwd, "version-notes.md")) as f:
            notes = f.read()
        return calls, notes, out.stdout

    def test_a_new_version_is_a_draft_until_its_files_are_up_then_the_latest_release(self):
        calls, notes, _ = self.run_step()
        self.assertEqual(
            calls,
            [
                f"release create v1.0.412 --repo o/r --target {SHA} --draft --latest=false --title FundaCAD 1.0.412 beta --notes-file version-notes.md",
                "release upload v1.0.412 --repo o/r --clobber release/FundaCAD-windows-x64-setup.exe release/plugin-screws.zip",
                "release edit v1.0.412 --repo o/r --draft=false --prerelease=false --latest=true",
            ],
        )
        self.assertIn("\nFundaCAD 1.0 beta (1.0.412), Rust engine", notes)
        self.assertNotIn("Rolling FundaCAD", notes)
        self.assertTrue(notes.endswith("The [rolling beta](https://github.com/o/r/releases/tag/beta) always has the newest build.\n"))

    def test_a_stable_release_keeps_the_latest_badge(self):
        calls, _, _ = self.run_step(stable="v1.2.0\nv1.1.3\n")
        self.assertEqual(calls[-1], "release edit v1.0.412 --repo o/r --draft=false --prerelease=false --latest=false")

    def test_a_tag_that_is_not_stable_does_not_count_as_one(self):
        calls, _, _ = self.run_step(stable="v1.0.300\nbeta\n")
        self.assertEqual(calls[-1], "release edit v1.0.412 --repo o/r --draft=false --prerelease=false --latest=true")

    def test_a_rerun_edits_the_release_it_made(self):
        calls, _, _ = self.run_step(exists="yes")
        self.assertEqual(calls[0], "release edit v1.0.412 --repo o/r --title FundaCAD 1.0.412 beta --notes-file version-notes.md")
        self.assertFalse(any(c.startswith("release create") for c in calls))
        self.assertEqual(calls[-1], "release edit v1.0.412 --repo o/r --draft=false --prerelease=false --latest=true")

    def test_a_refused_tag_warns_and_leaves_the_beta_alone(self):
        calls, _, out = self.run_step(refuse="yes")
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].startswith("release create v1.0.412"))
        self.assertIn("::warning::no v1.0.412 release", out)


if __name__ == "__main__":
    unittest.main()

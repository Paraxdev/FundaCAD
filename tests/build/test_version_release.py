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
REFUSAL = "HTTP 422: Validation Failed (https://api.github.com/repos/o/r/releases/7)\nRelease.tag_name could not be created"
WARNING = (
    "::warning::no v1.0.412 release, GitHub would not publish it on a1b2c3d, so its draft is deleted: "
    "HTTP 422: Validation Failed (https://api.github.com/repos/o/r/releases/7) Release.tag_name could not be created. "
    "This token may not tag a commit that changes a workflow file, the rolling beta has this build"
)
PUBLISH = "release edit v1.0.412 --repo o/r --draft=false --prerelease=false --latest=true"
LOOKUP = "release view v1.0.412 --repo o/r --json isDraft --jq .isDraft"
DELETE = "release delete v1.0.412 --repo o/r --yes"
NOTES = "> ### Read this first\n\nRolling FundaCAD 1.0 beta (1.0.412), Rust engine, rebuilt from `main`.\n\n## Changes\n"

# $1 is the gh subcommand group, $2 the verb. STABLE, EXISTS (draft or published), REFUSE,
# LOOKUP_FAILS and DELETE_FAILS come from the case. REFUSE is the error GitHub prints when it
# fails the publish edit, where it makes a draft's tag.
GH = r"""gh() {
  printf '%s\n' "$*" >> calls.log
  case "$1 $2" in
    "release list") printf '%s' "$STABLE" ;;
    "release view")
      [ -n "$EXISTS" ] || [ -e made ] || return 1
      case "$*" in *isDraft*)
        [ -z "$LOOKUP_FAILS" ] || return 1
        if [ -e made ] || [ "$EXISTS" = draft ]; then echo true; else echo false; fi ;; esac ;;
    "release create") : > made ;;
    "release edit") case "$*" in *--draft=false*) [ -z "$REFUSE" ] || { printf '%s\n' "$REFUSE" >&2; return 1; } ;; esac ;;
    "release delete") [ -z "$DELETE_FAILS" ] ;;
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
    def run_step(self, stable="", exists="", refuse="", lookup_fails="", delete_fails="", code=0):
        cwd = tempfile.mkdtemp(prefix="verrel-")
        self.addCleanup(shutil.rmtree, cwd, True)
        os.makedirs(os.path.join(cwd, "release"))
        for name, body in (("FundaCAD-windows-x64-setup.exe", b"MZ installer"), ("plugin-screws.zip", b"")):
            with open(os.path.join(cwd, "release", name), "wb") as f:
                f.write(body)
        with open(os.path.join(cwd, "notes.md"), "w", newline="\n") as f:
            f.write(NOTES)
        env = {**os.environ, "VERSION": "1.0.412", "SHA": SHA, "STABLE": stable, "EXISTS": exists, "REFUSE": refuse,
               "LOOKUP_FAILS": lookup_fails, "DELETE_FAILS": delete_fails}
        out = subprocess.run([BASH, "-c", GH + step_script()], cwd=cwd, env=env, capture_output=True, text=True)
        self.assertEqual(out.returncode, code, out.stderr)
        with open(os.path.join(cwd, "calls.log")) as f:
            calls = [c for c in f.read().splitlines() if not c.startswith("release list") and c != "release view v1.0.412 --repo o/r"]
        with open(os.path.join(cwd, "version-notes.md")) as f:
            notes = f.read()
        sums = os.path.join(cwd, "SHA256SUMS.txt")
        self.sums = open(sums).read().splitlines() if os.path.exists(sums) else None
        return calls, notes, [line for line in out.stdout.splitlines() if line.startswith("::warning::")]

    def test_a_new_version_is_a_draft_until_its_files_are_up_then_the_latest_release(self):
        calls, notes, _ = self.run_step()
        self.assertEqual(
            calls,
            [
                f"release create v1.0.412 --repo o/r --target {SHA} --draft --latest=false --title FundaCAD 1.0.412 beta --notes-file version-notes.md",
                "release upload v1.0.412 --repo o/r --clobber release/FundaCAD-windows-x64-setup.exe release/plugin-screws.zip SHA256SUMS.txt",
                "release edit v1.0.412 --repo o/r --draft=false --prerelease=false --latest=true",
            ],
        )
        self.assertIn("\nFundaCAD 1.0 beta (1.0.412), Rust engine", notes)
        self.assertNotIn("Rolling FundaCAD", notes)
        self.assertTrue(notes.endswith("The [rolling beta](https://github.com/o/r/releases/tag/beta) always has the newest build.\n"))
        self.assertEqual(
            self.sums,
            [
                "9bddb44627973bc5a5e0b20bf4a44cf2449f8b6ca1e8dfee0525b528ad80e020  FundaCAD-windows-x64-setup.exe",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  plugin-screws.zip",
            ],
        )

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

    def test_a_refused_tag_deletes_the_draft_and_warns_with_githubs_error(self):
        calls, _, warnings = self.run_step(refuse=REFUSAL)
        self.assertEqual(
            calls,
            [
                f"release create v1.0.412 --repo o/r --target {SHA} --draft --latest=false --title FundaCAD 1.0.412 beta --notes-file version-notes.md",
                "release upload v1.0.412 --repo o/r --clobber release/FundaCAD-windows-x64-setup.exe release/plugin-screws.zip SHA256SUMS.txt",
                PUBLISH,
                LOOKUP,
                DELETE,
            ],
        )
        self.assertEqual(warnings, [WARNING])

    def test_a_rerun_deletes_a_draft_an_earlier_refusal_left(self):
        calls, _, warnings = self.run_step(exists="draft", refuse=REFUSAL)
        self.assertEqual(calls[-3:], [PUBLISH, LOOKUP, DELETE])
        self.assertEqual(warnings, [WARNING])

    def test_a_published_release_that_fails_to_update_is_kept_and_fails_the_step(self):
        calls, _, warnings = self.run_step(exists="published", refuse=REFUSAL, code=1)
        self.assertEqual(calls[-2:], [PUBLISH, LOOKUP])
        self.assertFalse(any(c.startswith("release delete") for c in calls))
        self.assertEqual(warnings, [])

    def test_a_draft_whose_state_cannot_be_read_is_kept_and_fails_the_step(self):
        calls, _, warnings = self.run_step(refuse=REFUSAL, lookup_fails="yes", code=1)
        self.assertEqual(calls[-2:], [PUBLISH, LOOKUP])
        self.assertFalse(any(c.startswith("release delete") for c in calls))
        self.assertEqual(warnings, [])

    def test_a_draft_that_cannot_be_deleted_fails_the_step_without_a_warning(self):
        calls, _, warnings = self.run_step(refuse=REFUSAL, delete_fails="yes", code=1)
        self.assertEqual(calls[-3:], [PUBLISH, LOOKUP, DELETE])
        self.assertEqual(warnings, [])

    def test_a_published_tag_deletes_nothing_and_warns_nothing(self):
        calls, _, warnings = self.run_step()
        self.assertFalse(any(c.startswith(("release view", "release delete")) for c in calls))
        self.assertEqual(warnings, [])


if __name__ == "__main__":
    unittest.main()

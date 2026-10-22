"""The notes the release job builds, with hand written notes from the repo.

    python3 tests/build/test_release_notes.py

The notes part of the Publish step in build.yml runs in bash with gh replaced
by a function that answers from fixtures (docs/ENGINE.md section 7.1).
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.join(HERE, "..", "..", ".github", "workflows", "build.yml")

PREV = "b" * 40
SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"
HAND = "> ### Install this one by hand\n>\n> The signing key changed at 1.0.386.\n\n## What's new\n\n- Thing 7\n"

GH = r"""gh() {
  case "$2" in
    */git/ref/tags/*) printf '%s\n' "$PREV" ;;
    */compare/*) jq -c "$4" "$FIX/compare.json" ;;
    *) jq -c "$4" "$FIX/commits.json" ;;
  esac
}
"""


def commit(n):
    return {
        "sha": (format(n, "x") * 40)[:40],
        "commit": {"message": "fix: change number %d\n\nbecause %d things broke" % (n, n * 3)},
        "parents": [{"sha": PREV}],
    }


COMMITS = [commit(n) for n in (3, 5, 8)]


def notes_part():
    with open(WORKFLOW, encoding="utf-8", newline="") as f:
        text = f.read().replace("\r\n", "\n")
    start = text.index("R='${{ github.repository }}'")
    end = text.index('          if [ "$RELEASE" != stable ]; then\n            # Move the rolling tag')
    part = text[start:end].replace("'${{ github.repository }}'", "'o/r'")
    return re.sub(r"^ {10}", "", part, flags=re.M)


BASH = shutil.which("bash")


@unittest.skipUnless(BASH and shutil.which("jq"), "needs bash and jq")
class ReleaseNotes(unittest.TestCase):
    def setUp(self):
        self.dirs = []

    def tearDown(self):
        for d in self.dirs:
            shutil.rmtree(d, ignore_errors=True)

    def folder(self):
        d = tempfile.mkdtemp(prefix="relnotes-")
        self.dirs.append(d)
        return d

    def build(self, cwd, release="beta", notes=None, self_updates="yes", partial=""):
        os.makedirs(os.path.join(cwd, "fix"), exist_ok=True)
        os.makedirs(os.path.join(cwd, "docs", "release-notes"), exist_ok=True)
        with open(os.path.join(cwd, "fix", "compare.json"), "w") as f:
            json.dump({"commits": COMMITS}, f)
        with open(os.path.join(cwd, "fix", "commits.json"), "w") as f:
            json.dump(COMMITS, f)
        for name, body in (notes or {}).items():
            with open(os.path.join(cwd, "docs", "release-notes", name), "w", newline="\n") as f:
                f.write(body)
        script = "%s\nSELF_UPDATES=%s\npartial='%s'\n%s" % (GH, self_updates, partial, notes_part())
        with open(os.path.join(cwd, "build-notes.sh"), "w", newline="\n") as f:
            f.write(script)
        env = dict(os.environ, RELEASE=release, TAG=release, VERSION="1.0.386", SHA=SHA, SINCE="", PREV=PREV,
                   FIX=os.path.join(cwd, "fix"))
        r = subprocess.run([BASH, "-e", "build-notes.sh"], cwd=cwd, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(os.path.join(cwd, "notes.md"), encoding="utf-8", newline="") as f:
            return f.read()

    def test_hand_written_notes_come_first_and_replace_the_commit_list(self):
        out = self.build(self.folder(), notes={"beta.md": HAND})
        self.assertTrue(out.startswith(HAND + "\n\n---\n\n> ### Read this first"))
        self.assertIn("Rolling FundaCAD 1.0 beta (1.0.386)", out)
        self.assertNotIn("change number", out)
        self.assertNotIn("## Changes", out)
        self.assertIn("Install notes", out)
        self.assertIn("sourceforge.net/projects/fundacad/files/beta/", out)

    def test_no_update_claim_is_made_when_hand_written_notes_exist(self):
        out = self.build(self.folder(), notes={"beta.md": HAND})
        self.assertNotIn("update themselves", out)

    def test_the_generated_notes_alone_when_the_file_is_missing(self):
        out = self.build(self.folder())
        self.assertTrue(out.startswith("> ### Read this first"))
        self.assertRegex(out, r"## Changes, since \[`bbbbbbb`\]")
        for n in (3, 5, 8):
            self.assertIn("fix(`%s`)" % commit(n)["sha"][:7], out)
        self.assertIn("because 15 things broke", out)

    def test_copies_from_before_the_key_change_are_told_to_install_once_without_a_file(self):
        out = self.build(self.folder())
        self.assertRegex(out, r"before the signing key changed need one manual install")
        self.assertRegex(out, r"update themselves from the newest beta release")

    def test_an_empty_file_counts_as_missing(self):
        out = self.build(self.folder(), notes={"beta.md": ""})
        self.assertTrue(out.startswith("> ### Read this first"))
        self.assertIn("## Changes", out)

    def test_a_channel_reads_its_own_file_only(self):
        out = self.build(self.folder(), release="development", notes={"beta.md": HAND})
        self.assertTrue(out.startswith("> ### Read this first"))
        self.assertNotIn("Install this one by hand", out)
        self.assertIn("FundaCAD development build (1.0.386)", out)
        self.assertIn("## Changes", out)

    def test_a_build_without_a_feed_still_says_it_does_not_update_itself(self):
        out = self.build(self.folder(), self_updates="no", notes={"beta.md": HAND})
        self.assertIn("This build does not update itself", out)

    def test_the_partial_rebuild_line_follows_the_hand_written_notes(self):
        out = self.build(self.folder(), partial="the AppImage", notes={"beta.md": HAND})
        self.assertIn("Not rebuilt this time, so any copy here is from an earlier build: the AppImage.", out)

    def test_the_next_run_in_the_same_folder_starts_from_nothing(self):
        d = self.folder()
        self.build(d, notes={"beta.md": HAND})
        second = "> ### Second\n\nOnly this.\n"
        out = self.build(d, notes={"beta.md": second})
        self.assertTrue(out.startswith(second + "\n\n---\n\n"))
        self.assertNotIn("Thing 7", out)
        self.assertEqual(out.count("Read this first"), 1)


if __name__ == "__main__":
    unittest.main()

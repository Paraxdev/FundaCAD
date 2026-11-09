"""The Wayland smoke script against a fake cage, no compositor or app needed. Linux only, it needs setsid.

    python3 tests/build/test_wayland_smoke.py
"""

import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SMOKE = os.path.join(HERE, "..", "..", "scripts", "wayland-smoke.sh")

# Stands in for cage and the app it starts: FAKE_OUT goes to the command's output, FAKE_APPLOG to the
# app's own log the way FundaCAD moves its output there, after a rotation when FAKE_ROTATE is 1.
FAKE_CAGE = """#!/bin/sh
[ -z "${FAKE_OUT:-}" ] || printf '%s\\n' "$FAKE_OUT"
if [ -n "${FAKE_APPLOG:-}" ]; then
  [ "${FAKE_ROTATE:-0}" != 1 ] || mv "$SMOKE_APP_LOG" "$SMOKE_APP_LOG.1"
  printf '%s\\n' "$FAKE_APPLOG" >> "$SMOKE_APP_LOG"
fi
exec sleep 30
"""

TOPLEVEL = "[ 13315.355]  -> xdg_surface@10.get_toplevel(new id xdg_toplevel@19)"
ATTACH = "[ 13888.695]  -> wl_surface@13.attach(wl_buffer@29, 0, 0)"
WINDOW = TOPLEVEL + "\n" + ATTACH


@unittest.skipUnless(shutil.which("sh") and shutil.which("setsid"), "needs sh and setsid")
class WaylandSmoke(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        bin_dir = os.path.join(self.tmp.name, "bin")
        os.mkdir(bin_dir)
        cage = os.path.join(bin_dir, "cage")
        with open(cage, "w", newline="\n") as f:
            f.write(FAKE_CAGE)
        os.chmod(cage, 0o755)
        self.path = bin_dir + os.pathsep + os.environ["PATH"]
        self.out = os.path.join(self.tmp.name, "out")
        self.applog = os.path.join(self.tmp.name, "data", "fundacad.log")
        os.makedirs(os.path.dirname(self.applog))

    def run_smoke(self, out="", applog="", rotate=False, use_applog=True):
        env = dict(os.environ, PATH=self.path, SMOKE_SECONDS="1", FAKE_OUT=out, FAKE_APPLOG=applog)
        env["FAKE_ROTATE"] = "1" if rotate else "0"
        env.pop("SMOKE_APP_LOG", None)
        if use_applog:
            env["SMOKE_APP_LOG"] = self.applog
        return subprocess.run(["sh", SMOKE, self.out, "true"], env=env, capture_output=True, text=True, timeout=30)

    def test_a_window_in_the_command_output_passes(self):
        r = self.run_smoke(out=WINDOW, use_applog=False)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("Wayland smoke passed", r.stdout)

    def test_a_window_logged_only_in_the_apps_own_log_passes(self):
        r = self.run_smoke(out=TOPLEVEL, applog=ATTACH)
        self.assertEqual(r.returncode, 0, r.stdout)
        with open(os.path.join(self.out, "fundacad.log")) as f:
            self.assertIn("wl_surface@13.attach", f.read())

    def test_without_the_apps_log_its_buffer_goes_unseen(self):
        r = self.run_smoke(out=TOPLEVEL, applog=ATTACH, use_applog=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("::error::the app attached no buffer to a surface", r.stdout)

    def test_an_earlier_runs_lines_in_the_apps_log_do_not_count(self):
        with open(self.applog, "w") as f:
            f.write(WINDOW + "\n")
        r = self.run_smoke(out=TOPLEVEL, applog="[log] FundaCAD started")
        self.assertEqual(r.returncode, 1)
        self.assertIn("::error::the app attached no buffer to a surface", r.stdout)

    def test_a_log_rotated_at_start_is_read_whole(self):
        with open(self.applog, "w") as f:
            f.write("an earlier run's line\n" * 50)
        r = self.run_smoke(out=TOPLEVEL, applog=ATTACH, rotate=True)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_a_gdk_warning_in_the_apps_log_fails(self):
        warning = "(fundacad:2): Gdk-WARNING **: 17:59:21.956: Failed to read portal settings"
        r = self.run_smoke(out=WINDOW, applog=warning)
        self.assertEqual(r.returncode, 1)
        self.assertIn("::error::GDK, WebKit or Wayland errors in the output:", r.stdout)
        self.assertIn("Failed to read portal settings", r.stdout)

    def test_a_missing_app_log_checks_the_command_output_alone(self):
        r = self.run_smoke(out=WINDOW)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("no app log at " + self.applog, r.stdout)


if __name__ == "__main__":
    unittest.main()

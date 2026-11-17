"""The accessibility bus note of the AppImage's deps check, against fake data dirs.

    python3 tests/build/test_appimage_deps_check.py
"""

import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.join(HERE, "..", "..", "packaging", "appimage-deps-check.sh").replace("\\", "/")
SERVICE = os.path.join("dbus-1", "services", "org.a11y.Bus.service")


def run(script, env):
    full = {k: v for k, v in os.environ.items() if k not in ("AT_SPI_BUS_ADDRESS", "XDG_DATA_DIRS", "this_dir")}
    full.update(env)
    return subprocess.run(["bash", "-c", script], env=full, capture_output=True, text=True, timeout=30)


class A11yBusNote(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = self.tmp.name.replace("\\", "/")
        self.home, self.xdg, self.usr, self.local = (f"{root}/{d}" for d in ("home", "xdg", "usr", "local"))
        for d in (self.home, self.xdg, self.usr, self.local):
            os.makedirs(d)
        self.env = {"XDG_DATA_HOME": self.home, "XDG_DATA_DIRS": self.xdg}

    def service_in(self, d):
        path = os.path.join(d, SERVICE)
        os.makedirs(os.path.dirname(path))
        open(path, "w").close()

    def check(self, env=None):
        script = f'set -e; source "{CHECK}"; fundacad_a11y_check "{self.local}" "{self.usr}"; echo went-on'
        return run(script, {**self.env, **(env or {})})

    def test_says_nothing_when_a_bus_address_is_given(self):
        r = self.check({"AT_SPI_BUS_ADDRESS": "unix:path=/run/flatpak/at-spi-bus"})
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "went-on\n", ""))

    def test_says_nothing_when_a_data_dir_has_the_bus_service(self):
        for d in ("home", "xdg"):
            with self.subTest(d):
                self.setUp()
                self.service_in(getattr(self, d))
                r = self.check()
                self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "went-on\n", ""))

    def test_looks_in_the_system_dirs_whatever_xdg_data_dirs_says(self):
        self.service_in(self.usr)
        r = self.check({"XDG_DATA_DIRS": f"{self.tmp.name}/elsewhere:/nonexistent"})
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "went-on\n", ""))

    def test_names_at_spi2_core_on_stderr_and_goes_on_when_no_bus_can_start(self):
        r = self.check()
        self.assertEqual((r.returncode, r.stdout), (0, "went-on\n"))
        lines = r.stderr.splitlines()
        self.assertEqual(len(lines), 1, r.stderr)
        self.assertIn("no accessibility bus found", lines[0])
        self.assertIn("at-spi2-core", lines[0])

    def test_leaves_the_callers_ifs_alone(self):
        script = f'IFS=","; source "{CHECK}"; fundacad_a11y_check "{self.usr}"; printf "%s" "$IFS"'
        r = run(script, self.env)
        self.assertEqual(r.stdout, ",")

    def test_sourcing_without_apprun_runs_no_check(self):
        r = run(f'source "{CHECK}"; echo sourced', self.env)
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "sourced\n", ""))


if __name__ == "__main__":
    unittest.main()

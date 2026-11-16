"""scripts/warm-target.sh, which keeps the self hosted runner's warm target dirs off a full disk.

    python3 tests/build/test_warm_target.py

Runs against a fake checkout with rustc, cargo and df stubbed on PATH.
"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "..", "scripts", "warm-target.sh")
SH = shutil.which("sh")
GB = 1048576

STUBS = {
    "rustc": '#!/bin/sh\nprintf "rustc %s\\n" "$FAKE_RUST"\n',
    "cargo": '#!/bin/sh\nprintf "cargo %s\\n" "$FAKE_RUST"\n',
    # Free space grows once the release build is gone, so a floor can be met part way.
    "df": "#!/bin/sh\n"
    'if [ -d target/release ]; then free=$((10 * 1048576)); else free=$((40 * 1048576)); fi\n'
    'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake 157286400 1 %s 1%% /\\n" "$free"\n',
}


@unittest.skipUnless(SH, "needs sh")
class WarmTarget(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="warm-target-")
        self.bin = os.path.join(self.repo, "stub-bin")
        os.makedirs(self.bin)
        for name, body in STUBS.items():
            path = os.path.join(self.bin, name)
            with open(path, "w", newline="\n") as f:
                f.write(body)
            os.chmod(path, 0o755)

    def tearDown(self):
        shutil.rmtree(self.repo, ignore_errors=True)

    def run_script(self, *args, rust="1.100.0"):
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"], FAKE_RUST=rust)
        r = subprocess.run([SH, SCRIPT, *args], cwd=self.repo, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r.stdout

    def put(self, rel, age_days=0, read_days=None):
        path = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("x")
        now = time.time()
        read = age_days if read_days is None else read_days
        os.utime(path, (now - read * 86400, now - age_days * 86400))

    def files(self):
        out = []
        for root, _, names in os.walk(self.repo):
            for n in names:
                rel = os.path.relpath(os.path.join(root, n), self.repo).replace(os.sep, "/")
                if not rel.startswith("stub-bin/"):
                    out.append(rel)
        return sorted(out)

    def full_target(self):
        for rel in (
            "target/OCCT/lib/libTKernel.a",
            "target/debug/fundacad-engine",
            "target/debug/build/geom/a1/fingerprint/f",
            "target/debug/incremental/geom/s",
            "target/release/fundacad-engine",
            "src-tauri/target/debug/deps/app",
            "rust-geom-green/fundacad-engine",
        ):
            self.put(rel)

    def test_a_new_toolchain_starts_both_target_dirs_over_but_keeps_the_kernel(self):
        self.full_target()
        said = self.run_script("toolchain")
        self.assertIn("target was built by another toolchain", said)
        self.assertEqual(
            self.files(),
            [
                "rust-geom-green/fundacad-engine",
                "src-tauri/target/.toolchain",
                "target/.toolchain",
                "target/OCCT/lib/libTKernel.a",
            ],
        )

        self.put("target/debug/fundacad-engine")
        self.assertEqual(self.run_script("toolchain"), "")
        self.assertIn("target/debug/fundacad-engine", self.files())

        self.run_script("toolchain", rust="1.101.0")
        self.assertNotIn("target/debug/fundacad-engine", self.files())
        self.assertIn("target/OCCT/lib/libTKernel.a", self.files())

    def test_prune_drops_what_was_neither_written_nor_read_in_its_window(self):
        self.put("target/debug/build/old/a1/fingerprint/f", age_days=10)
        self.put("target/debug/build/old/a1/out/lib.rs", age_days=10)
        self.put("target/debug/build/linked/b2/fingerprint/f", age_days=10)
        self.put("target/debug/build/linked/b2/out/libshim.a", age_days=10, read_days=1)
        self.put("target/debug/deps/old_test-1", age_days=10)
        self.put("target/debug/deps/new_test-2", age_days=1)
        self.put("target/debug/incremental/old/s", age_days=10)
        self.put("target/OCCT/lib/libTKernel.a", age_days=30)
        self.put("target/OCCT/build/deps/occt-1", age_days=30)
        self.put("target/OCCT/build/a/b/fingerprint/f", age_days=30)
        self.put("target/OCCT/incremental/s", age_days=30)
        self.run_script("prune", "7")
        self.assertEqual(
            self.files(),
            [
                "target/OCCT/build/a/b/fingerprint/f",
                "target/OCCT/build/deps/occt-1",
                "target/OCCT/incremental/s",
                "target/OCCT/lib/libTKernel.a",
                "target/debug/build/linked/b2/fingerprint/f",
                "target/debug/build/linked/b2/out/libshim.a",
                "target/debug/deps/new_test-2",
            ],
        )

    def test_the_floor_frees_tier_by_tier_and_stops_once_there_is_room(self):
        self.full_target()
        self.run_script("toolchain")
        self.full_target()
        said = self.run_script("floor", "30")
        self.assertIn("dropping release builds", said)
        self.assertNotIn("everything but the kernel", said)
        self.assertNotIn("::warning::", said)
        kept = self.files()
        self.assertIn("target/debug/fundacad-engine", kept)
        self.assertNotIn("target/release/fundacad-engine", kept)
        self.assertNotIn("target/debug/incremental/geom/s", kept)

    def test_a_capped_floor_keeps_the_debug_build_and_warns(self):
        self.full_target()
        said = self.run_script("floor", "30", "2")
        self.assertIn("::warning::Only 10G free", said)
        self.assertIn("target/debug/fundacad-engine", self.files())
        self.assertIn("target/release/fundacad-engine", self.files())

    def test_the_last_tier_keeps_only_the_kernel_and_the_stamp(self):
        self.full_target()
        self.run_script("toolchain")
        self.full_target()
        said = self.run_script("floor", "50")
        self.assertIn("everything but the kernel", said)
        self.assertIn("::warning::Only 40G free", said)
        self.assertEqual(
            self.files(),
            [
                "rust-geom-green/fundacad-engine",
                "src-tauri/target/.toolchain",
                "target/.toolchain",
                "target/OCCT/lib/libTKernel.a",
            ],
        )

    def test_a_met_floor_frees_nothing(self):
        self.full_target()
        shutil.rmtree(os.path.join(self.repo, "target", "release"))
        before = self.files()
        self.run_script("floor", "30")
        self.assertEqual(self.files(), before)


if __name__ == "__main__":
    unittest.main()

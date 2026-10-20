"""The smoke driver against a fake MCP server, no engine needed.

    python3 tests/build/test_bundle_smoke.py
"""

import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SMOKE = os.path.join(HERE, "..", "..", "scripts", "bundle-smoke.py")

# A stdio server that answers like fundacad --mcp, bent by FAKE_MODE.
FAKE = r'''
import json, os, sys, time
mode = os.environ.get("FAKE_MODE", "ok")
if mode == "banner":
    print("Gtk-Message: hello from an AppRun hook", flush=True)
if mode == "exit":
    sys.exit(3)
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    m = msg["method"]
    if m == "initialize":
        result = {"serverInfo": {"name": "fake", "version": "0"}, "capabilities": {}}
    else:
        name = msg["params"]["name"]
        text = {"build": 'body1 "Box": 30.0 x 20.0 x 10.0 mm, vol %s mm3, 6 faces' % os.environ.get("FAKE_VOL", "6000")}.get(name, "ok")
        if mode == "hang" and name == "build":
            time.sleep(60)
        if mode == "tool-error" and name == "build":
            result = {"isError": True, "content": [{"type": "text", "text": "the geometry engine could not be reached"}]}
        else:
            result = {"content": [{"type": "text", "text": text}]}
    print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
'''


class BundleSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.fake = os.path.join(cls.tmp.name, "fake_server.py")
        with open(cls.fake, "w") as f:
            f.write(FAKE)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_smoke(self, mode="ok", vol="6000", extra=()):
        env = dict(os.environ, FAKE_MODE=mode, FAKE_VOL=vol)
        return subprocess.run(
            [sys.executable, SMOKE, *extra, "--", sys.executable, self.fake],
            env=env, capture_output=True, text=True, timeout=60,
        )

    def test_the_right_volume_passes(self):
        r = self.run_smoke()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("volume 6000.0 == 6000.0", r.stdout)

    def test_a_wrong_volume_fails(self):
        r = self.run_smoke(vol="5999")
        self.assertEqual(r.returncode, 1)
        self.assertIn("volume 5999.0, expected 6000.0", r.stdout)

    def test_a_tool_error_fails_with_its_text(self):
        r = self.run_smoke(mode="tool-error")
        self.assertEqual(r.returncode, 1)
        self.assertIn("could not be reached", r.stdout)

    def test_stray_stdout_fails(self):
        r = self.run_smoke(mode="banner")
        self.assertEqual(r.returncode, 1)
        self.assertIn("not JSON-RPC", r.stdout)

    def test_a_server_that_exits_fails(self):
        r = self.run_smoke(mode="exit")
        self.assertEqual(r.returncode, 1)
        self.assertIn("exited", r.stdout)

    def test_a_server_that_hangs_fails_in_time(self):
        started = time.monotonic()
        r = self.run_smoke(mode="hang", extra=("--timeout", "3"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("no reply in 3 s", r.stdout)
        self.assertLess(time.monotonic() - started, 15, "the hung server was waited on after its timeout")


if __name__ == "__main__":
    unittest.main()

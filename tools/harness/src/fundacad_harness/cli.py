"""fundacad-harness doctor | smoke"""

from __future__ import annotations

import argparse
from importlib import metadata
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .errors import HarnessError


def doctor() -> int:
    from .browser import find_chrome
    from .launch import find_engine, find_repo, python_info, stale_warning

    ok = True
    print(python_info())
    try:
        print(f"playwright {metadata.version('playwright')}")
    except metadata.PackageNotFoundError:
        print("playwright: missing, pip install -e tools/harness")
        ok = False
    try:
        repo = find_repo()
        print(f"repo {repo}")
    except HarnessError as e:
        print(e)
        return 1
    try:
        cmd = find_engine(repo)
        age = (time.time() - Path(cmd[0]).stat().st_mtime) / 3600
        print(f"engine {' '.join(cmd)} (built {age:.1f} h ago)")
        warn = stale_warning(cmd, repo)
        if warn:
            print(f"warning: {warn}")
    except HarnessError as e:
        print(e)
        ok = False
    try:
        print(f"chrome {find_chrome()}")
    except HarnessError as e:
        print(e)
        ok = False
    node = shutil.which("node")
    print(f"node {node}" if node else "node: missing")
    vite = repo / "node_modules" / "vite" / "bin" / "vite.js"
    print(f"vite {vite}" if vite.is_file() else f"vite: missing, run npm ci in {repo}")
    ok = ok and bool(node) and vite.is_file()
    print("ready" if ok else "not ready")
    return 0 if ok else 1


def smoke(extra: list[str]) -> int:
    tests = Path(__file__).resolve().parents[2] / "tests"
    return subprocess.call([sys.executable, "-m", "pytest", str(tests), "-m", "smoke", *extra])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="fundacad-harness")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("doctor", help="say what a session would launch")
    sub.add_parser("serve", help="answer JSON lines on stdin, for the MCP server")
    sm = sub.add_parser("smoke", help="run the smoke tests")
    sm.add_argument("pytest_args", nargs="*")
    args = ap.parse_args(argv)
    if args.cmd == "doctor":
        return doctor()
    if args.cmd == "serve":
        from .serve import main as serve
        return serve()
    if args.cmd == "smoke":
        return smoke(args.pytest_args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

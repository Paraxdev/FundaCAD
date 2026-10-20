"""Finding a Chrome to drive. The harness never downloads a browser."""

from __future__ import annotations

import glob
import os
from pathlib import Path

from .errors import LaunchError

SOFTWARE_GL = ["--use-angle=swiftshader", "--no-sandbox"]
REAL_GPU = ["--enable-gpu", "--ignore-gpu-blocklist", "--no-sandbox"]


def known_paths(env: dict | None = None) -> list[str]:
    env = os.environ if env is None else env
    out = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    local = env.get("LOCALAPPDATA")
    if local:
        found = glob.glob(os.path.join(local, "ms-playwright", "chromium-*", "chrome-win*", "chrome.exe"))
        out += sorted(found, key=os.path.getmtime, reverse=True)
    home = Path.home()
    found = glob.glob(str(home / ".cache" / "ms-playwright" / "chromium-*" / "chrome-linux*" / "chrome"))
    out += sorted(found, key=os.path.getmtime, reverse=True)
    out += ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    return out


def find_chrome(chrome: str | os.PathLike | None = None, env: dict | None = None) -> str:
    env = os.environ if env is None else env
    if chrome:
        if not Path(chrome).is_file():
            raise LaunchError(f"chrome {chrome} is not a file")
        return str(chrome)
    for key in ("FUNDACAD_CHROME", "SC_CHROME"):
        if env.get(key) and Path(env[key]).is_file():
            return env[key]
    for p in known_paths(env):
        if Path(p).is_file():
            return p
    raise LaunchError("no Chrome found, set FUNDACAD_CHROME to a chrome or chromium binary")


def chrome_args(gpu: bool) -> list[str]:
    return list(REAL_GPU if gpu else SOFTWARE_GL)

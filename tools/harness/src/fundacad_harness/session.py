"""A private copy of the app, driven through its real controls."""

from __future__ import annotations

import atexit
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from . import text
from .bridge import Bridge, check_api
from .browser import chrome_args, find_chrome
from .errors import HarnessError, LaunchError
from .launch import Proc, find_engine, find_repo, stale_warning, start_engine, start_vite


def _flag(name: str) -> bool:
    return os.environ.get(name, "") not in ("", "0", "false", "no")


class Session:
    def __init__(
        self,
        engine: str | os.PathLike | None = None,
        chrome: str | os.PathLike | None = None,
        vite_url: str | None = None,
        headed: bool | None = None,
        gpu: bool = False,
        viewport: tuple[int, int] = (1400, 900),
        record: str | os.PathLike | None = None,
        keep: bool | None = None,
        repo: str | os.PathLike | None = None,
        settle_timeout: float = 60,
        open: bool = True,
    ):
        self.repo = find_repo(repo)
        self.engine_cmd = find_engine(self.repo, engine)
        self.chrome = find_chrome(chrome)
        self.vite_url = vite_url.rstrip("/") if vite_url else None
        self.headed = _flag("FUNDACAD_HARNESS_HEADED") if headed is None else headed
        self.gpu = gpu
        self.viewport = viewport
        self.record_path = record
        self.keep = _flag("FUNDACAD_HARNESS_KEEP") if keep is None else keep
        self.settle_timeout = settle_timeout
        self.work = Path(tempfile.mkdtemp(prefix="fundacad-harness-"))
        self.procs: list[Proc] = []
        self.failed = False
        self.closed = False
        self.engine_port = 0
        self.token = ""
        self.url = ""
        self._pw = None
        self._browser = None
        self.page = None
        self.bridge: Bridge | None = None
        self._navs = 0
        self._seen_navs = 0
        self._reloads = 0
        self._page_errors: list[str] = []
        self._page_log = None
        self.warnings: list[str] = []
        self.start_screen = "none"
        atexit.register(self.close)
        if open:
            self.open()

    # --- lifecycle ---------------------------------------------------------

    def open(self) -> str:
        try:
            warn = stale_warning(self.engine_cmd, self.repo)
            if warn:
                self.warnings.append(warn)
                print(f"fundacad-harness: {warn}", file=sys.stderr)
            if self.vite_url:
                vite_port = int(self.vite_url.rsplit(":", 1)[1].split("/")[0])
                base = self.vite_url
            else:
                vite, vite_port = start_vite(self.repo, self.work)
                self.procs.append(vite)
                base = f"http://127.0.0.1:{vite_port}"
            engine, self.engine_port, self.token = start_engine(self.engine_cmd, self.repo, self.work, vite_port)
            self.procs.append(engine)
            self.url = f"{base}/?token={self.token}&engine={self.engine_port}&harness=1"
            self._launch_browser()
            self.page.goto(self.url, wait_until="domcontentloaded", timeout=60_000)
            self._wait_driver()
            self._seen_navs = self._navs
            kind = self.start_screen = self.dismiss_start()
            return f"opened {base} with engine port {self.engine_port}, start screen {kind}"
        except BaseException:
            self.failed = True
            self.close()
            raise

    def _launch_browser(self) -> None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise LaunchError("playwright is not installed, pip install -e tools/harness") from e
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            executable_path=self.chrome, headless=not self.headed, args=chrome_args(self.gpu)
        )
        ctx = self._browser.new_context(
            viewport={"width": self.viewport[0], "height": self.viewport[1]}, device_scale_factor=1
        )
        self.page = ctx.new_page()
        self._page_log = open(self.work / "page.log", "w", encoding="utf-8", errors="replace")
        self.page.on("console", lambda m: self._log(f"{m.type}: {m.text}"))
        self.page.on("pageerror", self._on_page_error)
        self.page.on("framenavigated", self._on_nav)
        self.bridge = Bridge(self.page)

    def _log(self, line: str) -> None:
        if self._page_log and not self._page_log.closed:
            self._page_log.write(line + "\n")
            self._page_log.flush()

    def _on_page_error(self, err: Any) -> None:
        msg = str(err).splitlines()[0] if str(err) else repr(err)
        self._page_errors.append(msg)
        self._log(f"pageerror: {err}")

    def _on_nav(self, frame: Any) -> None:
        if self.page is not None and frame == self.page.main_frame:
            self._navs += 1

    def _wait_driver(self, timeout: float = 60) -> None:
        end = time.monotonic() + timeout
        api = None
        while time.monotonic() < end:
            try:
                api = self.bridge.api()
            except Exception:
                api = None
            if api is not None:
                break
            time.sleep(0.2)
        check_api(api)
        why = "unknown"
        while time.monotonic() < end:
            try:
                r = self.bridge.call("ready")
            except HarnessError:
                raise
            except Exception:
                time.sleep(0.2)
                continue
            if r.get("ready"):
                return
            why = r.get("why", why)
            time.sleep(0.2)
        raise LaunchError(f"the app did not get ready in {int(timeout)} s: {why}")

    def _ensure_page(self) -> None:
        """Vite may reload the page once while it optimises dependencies on a cold start."""
        if self.closed:
            raise HarnessError("this session is closed")
        if self._navs == self._seen_navs:
            return
        self._reloads += 1
        if self._reloads > 1:
            raise HarnessError("the page reloaded twice, see page.log in " + str(self.work))
        self._wait_driver()
        self._seen_navs = self._navs
        self.dismiss_start()

    def close(self) -> str:
        if self.closed:
            return "already closed"
        self.closed = True
        stopped = []
        for step in (lambda: self._browser and self._browser.close(), lambda: self._pw and self._pw.stop()):
            try:
                step()
            except Exception:
                pass
        if self._browser:
            stopped.append("browser")
        for p in reversed(self.procs):
            p.stop()
            stopped.append(p.name)
        if self._page_log:
            self._page_log.close()
        kept = self.keep or self.failed
        if kept:
            print(f"fundacad-harness: logs kept in {self.work}", file=sys.stderr)
        else:
            shutil.rmtree(self.work, ignore_errors=True)
        try:
            atexit.unregister(self.close)
        except Exception:
            pass
        return "stopped " + (", ".join(stopped) or "nothing") + (f", logs in {self.work}" if kept else "")

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is not None:
            self.failed = True
        self.close()

    # --- driver calls ------------------------------------------------------

    def call(self, method: str, **args: Any) -> Any:
        """One raw driver call, for what the readouts do not cover."""
        self._ensure_page()
        try:
            return self.bridge.call(method, **args)
        except HarnessError:
            self.failed = True
            raise

    def settle(self, trace: int | None = None, timeout: float | None = None) -> str:
        args: dict[str, Any] = {"timeoutMs": int((timeout or self.settle_timeout) * 1000)}
        if trace is not None:
            args["trace"] = trace
        r = self.call("settle", **args)
        return f"settled in {r['ms']} ms"

    def dismiss_start(self) -> str:
        kind = self.bridge.call("startScreen")
        if kind != "none":
            close = self.page.locator(".home .modal-close, .modal-overlay .modal-close").first
            if close.count():
                close.click(timeout=5000)
            if not self._wait_for(lambda: self.bridge.call("startScreen") == "none", 5):
                self.page.keyboard.press("Escape")
                if not self._wait_for(lambda: self.bridge.call("startScreen") == "none", 5):
                    self.failed = True
                    raise HarnessError(f"the {kind} screen did not close")
        if not self._wait_for(lambda: not self.bridge.call("stageInert"), 5):
            self.failed = True
            raise HarnessError("the document area stayed inert after the start screen closed")
        return kind

    @staticmethod
    def _wait_for(cond, timeout: float) -> bool:
        end = time.monotonic() + timeout
        while True:
            if cond():
                return True
            if time.monotonic() > end:
                return False
            time.sleep(0.1)

    # --- readouts ----------------------------------------------------------

    def screen(self, region: str | None = None, max: int | None = None, raw: bool = False):
        args: dict[str, Any] = {}
        if region:
            args["region"] = region
        if max:
            args["max"] = max
        v = self.call("screen", **args)
        return v if raw else text.screen(v)

    def history(self, raw: bool = False):
        v = self.call("history")
        return v if raw else text.history(v)

    def bodies(self, raw: bool = False):
        v = self.call("bodies")
        return v if raw else text.bodies(v)

    def status(self, raw: bool = False):
        v = self.call("status")
        return v if raw else text.status(v)

    def selection(self, raw: bool = False):
        v = self.call("selection")
        return v if raw else text.selection(v)

    def last_error(self) -> str:
        return text.one_line(self.call("lastError"))

    def messages(self, since: int | None = None, raw: bool = False):
        v = self.call("messages", since=since or 0)
        return v if raw else text.messages(v)

    def pids(self) -> list[int]:
        return [p.pid for p in self.procs]

    def page_errors(self) -> list[str]:
        return list(self._page_errors)

    def screenshot(self, path: str | os.PathLike | None = None, target: str | None = None) -> str:
        self._ensure_page()
        if path is None:
            shots = self.work / "shots"
            shots.mkdir(exist_ok=True)
            path = shots / f"shot-{len(list(shots.iterdir())) + 1}.png"
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        if target:
            hit = self.call("locate", target=target)
            self.page.locator(f'[data-harness-target="{hit["marker"]}"]').screenshot(path=str(path))
        else:
            self.page.screenshot(path=str(path))
        return str(path)

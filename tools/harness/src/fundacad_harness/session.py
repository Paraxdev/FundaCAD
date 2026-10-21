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
from .actions import Actions, out_path
from .bridge import Bridge, check_api
from .browser import chrome_args, find_chrome
from .errors import HarnessError, LaunchError, SettleTimeout
from .recorder import Recorder
from .launch import Proc, find_engine, find_repo, stale_warning, start_engine, start_vite


RELOAD_WINDOW = 30
RELOADED = "the page reloaded before this step, a browser tab keeps no document over a reload, so this one is new"


def remove_dir(path: Path, tries: int = 3, wait: float = 0.5, sleep=time.sleep) -> bool:
    # Note: a just stopped engine or log pump can hold a file in the folder for a moment on Windows.
    for n in range(tries):
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return True
        if n < tries - 1:
            sleep(wait)
    return False


def _flag(name: str) -> bool:
    return os.environ.get(name, "") not in ("", "0", "false", "no")


class Session(Actions):
    """A private app: its own engine, vite and headless Chrome, driven through the real controls.

    Actions (click, tool, type, press, menu, pick_face, drag_handle, undo, ...) return a one line
    Step. Readouts (screen, history, bodies, status, selection, last_error) return short text, or
    the JSON with `raw=True`. docs/HARNESS.md has the whole guide."""
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
        # serve.py caps every wait here so one MCP call ends before its relay gives up.
        self.settle_limit: float | None = None
        self.work = Path(tempfile.mkdtemp(prefix="fundacad-harness-"))
        self.procs: list[Proc] = []
        self.failed = False
        self._mark = 0
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
        self._reload_at: float | None = None
        self._clock = time.monotonic
        self._page_errors: list[str] = []
        self._page_log = None
        self.warnings: list[str] = []
        self.start_screen = "none"
        self.recorder = None
        if record:
            from . import __version__
            from .bridge import DRIVER_API
            opts: dict[str, Any] = {}
            if tuple(viewport) != (1400, 900):
                opts["viewport"] = tuple(viewport)
            if gpu:
                opts["gpu"] = True
            if settle_timeout != 60:
                opts["settle_timeout"] = settle_timeout
            self.recorder = Recorder(record, self.repo, __version__, DRIVER_API, opts)
        atexit.register(self.close)
        if open:
            self.open()

    # --- lifecycle ---------------------------------------------------------

    def open(self) -> str:
        """Starts vite, the engine and Chrome, waits for the app and closes the start screen."""
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
            self._mark = self.bridge.call("seq")
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
        try:
            self._pw = sync_playwright().start()
        except Exception as e:
            if "asyncio loop" not in str(e):
                raise
            raise LaunchError(
                "a Session needs a process of its own with no asyncio loop running: close the other"
                " Session first, or run this one in its own process (not in a notebook or an async host)"
            ) from None
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

    _reload_note: str | None = None

    def _ensure_page(self) -> None:
        """Vite reloads the page while it optimises dependencies, or after an edit it cannot hot swap."""
        if self.closed:
            raise HarnessError("this session is closed")
        if self._navs == self._seen_navs:
            return
        now = self._clock()
        if self._reload_at is not None and now - self._reload_at < RELOAD_WINDOW:
            raise HarnessError(f"the page reloaded twice in {RELOAD_WINDOW} s, see page.log in {self.work}")
        self._reload_at = now
        self._wait_driver()
        self._seen_navs = self._navs
        self.dismiss_start()
        self._mark = self.bridge.call("seq")
        self._reload_note = RELOADED
        self.warnings.append(RELOADED)

    def close(self) -> str:
        """Stops everything this session started; its logs stay after a launch failure or an exception out of a `with` block, everything with `keep`."""
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
        recorded = f", recorded {self.recorder.write()}" if self.recorder else ""
        kept = self.keep or self.failed
        if kept:
            if not self.keep:
                for heavy in ("blobs", "cache"):
                    shutil.rmtree(self.work / heavy, ignore_errors=True)
            print(f"fundacad-harness: logs kept in {self.work}", file=sys.stderr)
        elif not remove_dir(self.work):
            kept = True
            print(f"fundacad-harness: could not remove {self.work}, delete it by hand", file=sys.stderr)
        try:
            atexit.unregister(self.close)
        except Exception:
            pass
        return ("stopped " + (", ".join(stopped) or "nothing") + recorded
                + (f", logs in {self.work}" if kept else ""))

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
        return self.bridge.call(method, **args)

    def settle(self, trace: int | None = None, timeout: float | None = None) -> str:
        """Waits until rebuilds, previews, the camera and the picture are quiet; every action already does."""
        wait = timeout or self.settle_timeout
        capped = self.settle_limit is not None and self.settle_limit < wait
        if capped:
            wait = self.settle_limit
        args: dict[str, Any] = {"timeoutMs": int(wait * 1000)}
        if trace is not None:
            args["trace"] = trace
        try:
            r = self.call("settle", **args)
        except SettleTimeout as e:
            if capped:
                raise SettleTimeout(
                    f"{e}. The app may still be working on it, this call had {wait:g} s left to wait:"
                    " settle() again in a new call"
                ) from None
            raise SettleTimeout(
                f"{e}. The app may still be working on it: wait_for a label or settle() again,"
                f" or open the session with a longer settle_timeout (now {self.settle_timeout:g} s)"
            ) from None
        if not getattr(self, "_in_action", False) and self.recorder is not None:
            owed, self._owed_since = getattr(self, "_owed_since", None), None
            if owed is not None:
                timeout = max(timeout or self.settle_timeout, int(time.monotonic() - owed) + 30)
            self.recorder.add("settle", (), {} if timeout is None else {"timeout": timeout}, None)
        return f"settled in {r['ms']} ms"

    def dismiss_start(self) -> str:
        """Closes the start screen (Home or the Welcome dialog); `open()` already does."""
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
        """The visible controls as a short tree, one ref per control, or one region of it."""
        args: dict[str, Any] = {}
        if region:
            args["region"] = region
        if max:
            args["max"] = max
        v = self.call("screen", **args)
        return v if raw else text.screen(v)

    def history(self, raw: bool = False):
        """The features in order with their type and state."""
        v = self.call("history")
        return v if raw else text.history(v)

    def bodies(self, raw: bool = False):
        """The bodies with their face count and visibility."""
        v = self.call("bodies")
        return v if raw else text.bodies(v)

    def status(self, raw: bool = False):
        """Mode, tool, document, prompt, and the newest message and error since the last action began."""
        v = self.call("status", since=self._mark)
        return v if raw else text.status(v)

    def selection(self, raw: bool = False):
        """The selected bodies, faces and edges."""
        v = self.call("selection")
        return v if raw else text.selection(v)

    def handles(self, raw: bool = False):
        """The named handles a tool has up, `push at 700,412` or `taper covered`."""
        v = self.call("handles")
        return v if raw else "\n  ".join([f"handles {len(v)}", *v])

    def last_error(self) -> str:
        """A failed build or refused preview, else an error logged since the last action began."""
        return text.one_line(self.call("lastError", since=self._mark))

    def messages(self, since: int | None = None, raw: bool = False):
        """The log and toast lines after a sequence number."""
        v = self.call("messages", since=since or 0)
        return v if raw else text.messages(v)

    def pids(self) -> list[int]:
        """The process ids of the engine and vite this session started."""
        return [p.pid for p in self.procs]

    def page_errors(self) -> list[str]:
        """Uncaught page errors seen so far."""
        return list(self._page_errors)

    def screenshot(self, path: str | os.PathLike | None = None, target: str | None = None) -> str:
        """Saves a PNG of the page, or of one control, and returns its full path."""
        self._ensure_page()
        if path is None:
            shots = self.work / "shots"
            shots.mkdir(exist_ok=True)
            path = shots / f"shot-{len(list(shots.iterdir())) + 1}.png"
        path = out_path(path)
        if target:
            hit = self.call("locate", target=target, disabled=True)
            self.page.locator(f'[data-harness-target="{hit["marker"]}"]').screenshot(path=str(path))
        else:
            self.page.screenshot(path=str(path))
        return str(path)

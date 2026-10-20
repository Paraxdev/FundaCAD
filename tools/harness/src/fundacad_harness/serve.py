"""One JSON object per line each way: the MCP server's private session. Logs go to stderr."""

from __future__ import annotations

import base64
import json
import sys
from typing import Any, Callable, TextIO

from . import steps
from .errors import BadArgs, HarnessError

READS = ("screen", "history", "bodies", "status", "errors", "selection", "handles")
SHRINK = """async ([b64, max]) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png").split(",")[1];
}"""
MAX_PX = 1600


def _viewport(v: Any) -> tuple[int, int]:
    if v is None:
        return (1400, 900)
    try:
        w, h = (int(x) for x in str(v).lower().split("x"))
        return (w, h)
    except ValueError:
        raise BadArgs(f'viewport is "WIDTHxHEIGHT", like "1400x900", not "{v}"') from None


class Server:
    def __init__(self, make_session: Callable[..., Any] | None = None):
        if make_session is None:
            from .session import Session
            make_session = Session
        self.make_session = make_session
        self.s: Any = None

    def _status(self) -> str:
        try:
            return self.s.status() if self.s else "no session open"
        except Exception as e:
            return f"status unavailable: {e}"

    def open(self, headed: bool = False, record: str | None = None, viewport: Any = None, gpu: bool = False) -> str:
        if self.s is not None and not self.s.closed:
            return "already open, a private copy of the app, not your window\n" + self._status()
        self.s = self.make_session(headed=headed, record=record, viewport=_viewport(viewport), gpu=gpu)
        return f"opened a private copy of the app, not your window, start screen {self.s.start_screen}\n" + self._status()

    def _need(self) -> Any:
        if self.s is None or self.s.closed:
            raise HarnessError("no session open, call ui_open first")
        return self.s

    def do(self, steps_: Any = None) -> tuple[bool, str]:
        s = self._need()
        if not isinstance(steps_, list) or not steps_:
            raise BadArgs("do takes a non empty list of steps")
        done = []
        for i, step in enumerate(steps_, 1):
            try:
                done.append(f"{i}. {steps.run(s, step)}")
            except Exception as e:
                done.append(f"{i}. failed: {e}")
                return False, "\n".join(done + ["", self._status()])
        return True, "\n".join(done + ["", self._status()])

    def read(self, what: Any = None, region: str | None = None) -> str:
        s = self._need()
        names = what if isinstance(what, list) else [what or "status"]
        out = []
        for name in names:
            if name not in READS:
                raise BadArgs(f'cannot read "{name}", the readouts are {", ".join(READS)}')
            if name == "screen":
                out.append(s.screen(region=region))
            elif name == "errors":
                errs = s.page_errors()
                out.append(f"last error: {s.last_error()}\npage errors: {'; '.join(errs) if errs else 'none'}")
            else:
                out.append(getattr(s, name)())
        return "\n\n".join(out)

    def shot(self, target: str | None = None, max_px: int = 1000) -> tuple[str, str]:
        s = self._need()
        path = s.screenshot(target=target)
        with open(path, "rb") as f:
            raw = base64.b64encode(f.read()).decode("ascii")
        px = max(64, min(int(max_px), MAX_PX))
        png = s.page.evaluate(SHRINK, [raw, px])
        return f"screenshot{' of ' + target if target else ''}, at most {px} px, also at {path}", png

    def close(self) -> str:
        if self.s is None:
            return "nothing open"
        msg = self.s.close()
        self.s = None
        return msg

    def handle(self, line: str) -> dict:
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            return {"id": None, "ok": False, "text": f"not a JSON line: {e}"}
        if not isinstance(req, dict):
            return {"id": None, "ok": False, "text": "a request is a JSON object"}
        rid, call, args = req.get("id"), req.get("call"), req.get("args") or {}
        try:
            if not isinstance(args, dict):
                raise BadArgs("args is an object")
            if call == "open":
                return {"id": rid, "ok": True, "text": self.open(**args)}
            if call == "do":
                ok, text = self.do(args.get("steps"))
                return {"id": rid, "ok": ok, "text": text}
            if call == "read":
                return {"id": rid, "ok": True, "text": self.read(**args)}
            if call == "shot":
                text, png = self.shot(**args)
                return {"id": rid, "ok": True, "text": text, "png": png}
            if call == "close":
                return {"id": rid, "ok": True, "text": self.close()}
            raise BadArgs(f'unknown call "{call}", the calls are open, do, read, shot, close')
        except TypeError as e:
            return {"id": rid, "ok": False, "text": f"bad arguments for {call}: {e}"}
        except Exception as e:
            return {"id": rid, "ok": False, "text": f"{e}\n{self._status()}"}

    def loop(self, inp: TextIO, out: TextIO) -> None:
        try:
            for line in inp:
                if not line.strip():
                    continue
                out.write(json.dumps(self.handle(line), ensure_ascii=False) + "\n")
                out.flush()
        finally:
            self.close()


def main() -> int:
    out = sys.stdout
    sys.stdout = sys.stderr
    Server().loop(sys.stdin, out)
    return 0

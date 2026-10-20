"""Turns the actions of a session into a Python script that replays them."""

from __future__ import annotations

import datetime
import json
import os
from pathlib import Path
from typing import Any

from . import selectors

REF_ARGS = {"click": 0, "type": 0, "expand": 0}
PATH_ARGS = {"open_file", "import_file", "save_as"}


def literal(v: Any) -> str:
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, os.PathLike):
        return literal(os.fspath(v))
    if isinstance(v, tuple):
        inner = ", ".join(literal(x) for x in v)
        return f"({inner},)" if len(v) == 1 else f"({inner})"
    if isinstance(v, list):
        return "[" + ", ".join(literal(x) for x in v) + "]"
    return repr(v)


class Recorder:
    def __init__(self, path: str | os.PathLike, repo: str | os.PathLike, version: str, api: int,
                 session_args: dict | None = None):
        self.path = Path(path)
        self.repo = Path(repo).resolve()
        self.header = (f"# Recorded by fundacad-harness {version}, driver api {api}, "
                       f"{datetime.date.today().isoformat()}.")
        self.session_args = session_args or {}
        self.calls: list[tuple[str, tuple, dict]] = []
        self.lines: list[str] = []

    def _repo_relative(self, p: Any) -> Any:
        try:
            full = Path(p).resolve()
            return full.relative_to(self.repo).as_posix()
        except (ValueError, OSError, TypeError):
            return os.fspath(p) if isinstance(p, os.PathLike) else p

    def add(self, verb: str, args: tuple, kwargs: dict, done: Any) -> None:
        data = done[1] if isinstance(done, tuple) and len(done) > 1 else None
        hit = data if isinstance(data, dict) else {}
        args = list(args)
        notes: list[str] = []
        if verb in REF_ARGS and len(args) > REF_ARGS[verb]:
            i = REF_ARGS[verb]
            if isinstance(args[i], str) and not selectors.canvas_target(args[i]) and hit.get("ref"):
                args[i] = hit["ref"]
                notes.append(hit.get("label", ""))
        elif verb == "context_menu" and len(args) >= 2:
            if hit.get("on_ref"):
                args[0] = hit["on_ref"]
                notes.append(hit.get("on_label", ""))
            if hit.get("ref"):
                args[1] = hit["ref"]
                notes.append(hit.get("label", ""))
        elif verb == "tool" and hit.get("ref"):
            notes.append(hit["ref"])
        elif verb in PATH_ARGS and args:
            args[0] = self._repo_relative(hit.get("path", args[0]))
        call = verb + "(" + ", ".join([literal(a) for a in args] + [f"{k}={literal(v)}" for k, v in kwargs.items()]) + ")"
        note = ", ".join(literal(n) if verb != "tool" else n for n in notes if n)
        self.calls.append((verb, tuple(args), dict(kwargs)))
        self.lines.append(f"    s.{call}" + (f"  # {note}" if note else ""))
        self.write()

    def source(self) -> str:
        opts = ", ".join(f"{k}={literal(v)}" for k, v in self.session_args.items())
        body = self.lines or ["    pass"]
        return "\n".join([self.header, "from fundacad_harness import Session", "",
                          f"with Session({opts}) as s:", *body, ""])

    def write(self) -> Path:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".part")
        tmp.write_text(self.source(), encoding="utf-8")
        os.replace(tmp, self.path)
        return self.path

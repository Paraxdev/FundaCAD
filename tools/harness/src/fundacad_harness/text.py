"""Short text readouts made from the driver's JSON, sized for an agent to read."""

from __future__ import annotations

import time
from typing import Any


def _q(s: str) -> str:
    return '"' + s.replace('"', "'") + '"'


def screen(value: dict) -> str:
    out: list[str] = []
    for depth, ref, role, label, flags in value.get("lines", []):
        if depth == 0:
            out.append(f"{ref} {label}".rstrip())
            continue
        if role == "more":
            out.append(f"  ... {label}")
            continue
        tail = " ".join(flags)
        text = f"  {ref:<24} {role} {_q(label)}"
        out.append(f"{text} {tail}".rstrip())
    if value.get("truncated"):
        out.append(f"... {value['truncated']} more lines, ask for one region with region=")
    return "\n".join(out) if out else "nothing on screen"


def history(value: dict) -> str:
    rows = value.get("rows", [])
    head = f"history {value.get('count', len(rows))} feature{'' if len(rows) == 1 else 's'}, {value.get('at', '')}".rstrip(", ")
    if not rows:
        return head
    w_id = max(len(r["id"]) for r in rows)
    w_name = max(len(r["name"]) for r in rows)
    w_type = max(len(r["type"]) for r in rows)
    lines = [head]
    for r in rows:
        line = f"  {r['id']:<{w_id}}  {r['name']:<{w_name}}  {r['type']:<{w_type}}  {r.get('state', '')}"
        lines.append(line.rstrip())
    return "\n".join(lines)


BODY_ROWS = 40


def bodies(rows: list[dict], max_rows: int = BODY_ROWS) -> str:
    hidden = sum(not r.get("visible") for r in rows)
    faults = sum(bool(r.get("fault")) for r in rows)
    head = f"bodies {len(rows)}"
    if len(rows) > max_rows:
        head += f", {hidden} hidden, {faults} with a fault, the first {max_rows} below, raw=True has them all"
    lines = [head]
    shown = rows[:max_rows]
    if shown:
        w_id = max(len(r["id"]) for r in shown)
        w_name = max(len(r["name"]) for r in shown)
        for r in shown:
            state = "visible" if r.get("visible") else "hidden"
            fault = f"  fault: {r['fault']}" if r.get("fault") else ""
            lines.append(f"  {r['id']:<{w_id}}  {r['name']:<{w_name}}  {r['faces']} faces  {state}{fault}")
    return "\n".join(lines)


def ago(at_ms: float, now: float | None = None) -> str:
    s = max(0, int((now if now is not None else time.time()) - at_ms / 1000))
    return f"{s} s ago" if s < 120 else f"{s // 60} min ago"


def status(v: dict, now: float | None = None) -> str:
    doc = _q(v.get("doc") or "Untitled") + (" dirty" if v.get("dirty") else "")
    yn = lambda b: "yes" if b else "no"  # noqa: E731
    lines = [
        f"mode {v.get('mode')} | tool {v.get('tool') or 'none'} | workspace {v.get('workspace')} | doc {doc}"
        f" | undo {yn(v.get('undo'))} redo {yn(v.get('redo'))}",
    ]
    if v.get("prompt"):
        lines.append(f"prompt: {v['prompt']}")
    if v.get("selection"):
        lines.append(f"selection: {v['selection']}")
    r = v.get("recent")
    if r:
        lines.append(f"recent: {r['level']} {_q(r['text'])} {ago(r['at'], now)}")
    lines.append(f"error: {v.get('error') or 'none'}")
    if v.get("warnings"):
        lines.append("warning: " + ", ".join(v["warnings"]) + " (the view's own warning button)")
    return "\n".join(lines)


def selection(v: dict) -> str:
    parts = []
    if v.get("bodies"):
        parts.append("bodies " + ", ".join(v["bodies"]))
    if v.get("faces"):
        parts.append("faces " + ", ".join(f"{b}:index={i}" for b, i in v["faces"]))
    if v.get("edges"):
        parts.append("edges " + ", ".join(v["edges"]))
    head = "; ".join(parts) if parts else "nothing selected"
    return head + (f" ({v['readout']})" if v.get("readout") else "")


def messages(v: dict, now: float | None = None) -> str:
    rows = v.get("rows", [])
    if not rows:
        return "no messages"
    return "\n".join(f"{r['seq']} {r['level']} {_q(r['text'])} {ago(r['at'], now)}" for r in rows)


def one_line(value: Any) -> str:
    return "none" if value in (None, "") else str(value).replace("\n", " ")

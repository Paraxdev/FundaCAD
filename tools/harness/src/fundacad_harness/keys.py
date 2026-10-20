"""Key names as people write them, mapped to what Playwright presses."""

from __future__ import annotations

MODS = {"ctrl": "Control", "control": "Control", "shift": "Shift", "alt": "Alt", "option": "Alt",
        "cmd": "Meta", "meta": "Meta", "win": "Meta"}
NAMES = {"esc": "Escape", "escape": "Escape", "enter": "Enter", "return": "Enter", "tab": "Tab",
         "space": "Space", "del": "Delete", "delete": "Delete", "backspace": "Backspace",
         "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight",
         "home": "Home", "end": "End", "pageup": "PageUp", "pagedown": "PageDown", "insert": "Insert"}


def key(text: str) -> str:
    """`ctrl+z` -> `Control+z`, `Shift+H` -> `Shift+H`, `esc` -> `Escape`, `F2` -> `F2`."""
    parts = [p.strip() for p in text.split("+")]
    if text.endswith("++"):
        parts = parts[:-2] + ["+"]
    if not parts or any(p == "" for p in parts):
        raise ValueError(f'cannot read key "{text}"')
    *mods, last = parts
    out = []
    for m in mods:
        if m.lower() not in MODS:
            raise ValueError(f'"{m}" in "{text}" is not a modifier, use Ctrl, Shift, Alt or Cmd')
        out.append(MODS[m.lower()])
    low = last.lower()
    if low in NAMES:
        out.append(NAMES[low])
    elif len(last) > 1 and low[0] == "f" and low[1:].isdigit():
        out.append(last.upper())
    elif len(last) == 1:
        out.append(last)
    else:
        out.append(last[0].upper() + last[1:])
    return "+".join(out)


def modifiers(mods) -> list[str]:
    return [MODS[m.lower()] for m in mods]

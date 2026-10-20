"""The verbs a `do` step may name, and the keys each one takes, for the MCP relay."""

from __future__ import annotations

from typing import Any

from .errors import BadArgs

# verb: (required keys, optional keys); every verb also takes `settle`.
VERBS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "click": (("target",), ("button", "double", "mods")),
    "tool": (("label",), ()),
    "type": (("target", "text"), ("enter",)),
    "press": (("keys",), ()),
    "menu": (("path",), ()),
    "context_menu": (("on", "item"), ()),
    "panel": (("name",), ("open",)),
    "command": (("name",), ()),
    "expand": (("target",), ("open",)),
    "pick_face": (("sel",), ("add", "exact")),
    "pick_edge": (("sel",), ("add", "exact", "via")),
    "pick_plane": (("name",), ()),
    "click_at": ((), ("sketch", "world", "screen", "button", "double")),
    "drag": (("from", "to"), ("space", "button", "steps")),
    "drag_handle": (("name",), ("by", "mm")),
    "view": (("name",), ()),
    "undo": ((), ()),
    "redo": ((), ()),
    "open_file": (("path",), ()),
    "import_file": (("path",), ()),
    "save_as": (("path",), ()),
    "new_document": ((), ("discard",)),
    "wait_for": (("text",), ("timeout",)),
}
NO_SETTLE = {"wait_for"}


def check(step: Any) -> tuple[str, dict]:
    if not isinstance(step, dict) or not isinstance(step.get("do"), str):
        raise BadArgs('a step is an object with a "do" verb, for example {"do": "press", "keys": "Enter"}')
    verb = step["do"]
    if verb not in VERBS:
        raise BadArgs(f'unknown verb "{verb}", the verbs are {", ".join(VERBS)}')
    need, may = VERBS[verb]
    args = {k: v for k, v in step.items() if k != "do"}
    allowed = set(need) | set(may) | ({"settle"} if verb not in NO_SETTLE else set())
    extra = sorted(set(args) - allowed)
    if extra:
        raise BadArgs(f'{verb} does not take {", ".join(extra)}, it takes {", ".join(sorted(allowed)) or "nothing"}')
    missing = [k for k in need if k not in args]
    if missing:
        raise BadArgs(f'{verb} needs {", ".join(missing)}')
    return verb, args


def run(session: Any, step: Any) -> Any:
    verb, args = check(step)
    fn = getattr(session, verb)
    if verb == "press":
        keys = args.pop("keys")
        return fn(*([keys] if isinstance(keys, str) else keys), **args)
    if verb == "drag":
        args["from_"] = args.pop("from")
    for k in ("sketch", "world", "screen", "from_", "to"):
        if isinstance(args.get(k), list):
            args[k] = tuple(args[k])
    return fn(**args)

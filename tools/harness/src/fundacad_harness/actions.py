"""What a person does: every action is real pointer or keyboard input, then a settle."""

from __future__ import annotations

import base64
import functools
import os
import time
from pathlib import Path
from typing import Any, Callable

from . import selectors
from .errors import BadArgs, HarnessError, NotFound, Occluded
from .keys import key, modifiers


VIEW_LABELS = {"iso": "Default View", "default": "Default View", "fit": "Fit to Model"}
SIDES = {"top", "bottom", "front", "back", "right", "left"}


class Step:
    """What one action did, as one line (`str()`), with the JSON behind it in `data`."""

    def __init__(self, text: str, data: Any = None):
        self.text = text
        self.data = data

    def __str__(self) -> str:
        return self.text

    __repr__ = __str__


def action(fn: Callable) -> Callable:
    @functools.wraps(fn)
    def run(self, *args, settle: bool = True, **kwargs):
        self._ensure_page()
        outer = not getattr(self, "_in_action", False)
        if outer:
            self._mark = self.bridge.call("seq")
        self._in_action = True
        try:
            done = fn(self, *args, **kwargs)
            if settle:
                self.settle()
        finally:
            if outer:
                self._in_action = False
        if outer:
            self._recorded(fn.__name__, args, kwargs if settle else {**kwargs, "settle": False}, done)
        return self._step(done)

    run.is_action = True
    return run


class Actions:
    """Mixed into Session."""

    def _recorded(self, verb: str, args: tuple, kwargs: dict, done: Any) -> None:
        rec = getattr(self, "recorder", None)
        if rec is not None:
            rec.add(verb, args, kwargs, done)

    def _step(self, done: Any) -> Step:
        what, data = (done if isinstance(done, tuple) else (done, None))
        st = self.bridge.call("status", since=self._mark)
        tail = f"mode {st['mode']}"
        if st.get("tool"):
            tail += f", tool {st['tool']}"
        if st.get("prompt"):
            tail += f', prompt "{st["prompt"]}"'
        said = [r for r in self.bridge.call("messages", since=self._mark)["rows"] if r["level"] != "error"]
        for r in said[-2:]:
            tail += f', said {r["level"]} "{r["text"]}"'
        if st.get("error"):
            tail += f", error: {st['error']}"
        return Step(f"{what}, {tail}", data)

    # --- DOM controls --------------------------------------------------------

    def _locator(self, target: str):
        hit = self.bridge.call("locate", target=target)
        return hit, self.page.locator(f'[data-harness-target="{hit["marker"]}"]')

    def _click_control(self, target: str, button: str = "left", double: bool = False, mods=()) -> dict:
        hit, loc = self._locator(target)
        try:
            if double:
                loc.dblclick(button=button, modifiers=modifiers(mods), timeout=5000)
            else:
                loc.click(button=button, modifiers=modifiers(mods), timeout=5000)
        except Exception as e:
            if type(e).__name__ != "TimeoutError":
                raise
            raise Occluded(f'{hit["ref"]} "{hit["label"]}" did not take the click, something is over it') from None
        return hit

    @action
    def click(self, target: str, button: str = "left", double: bool = False, mods=()):
        on = selectors.canvas_target(target)
        if on:
            p = self._canvas_point(*on)
            self._mouse_click(p["x"], p["y"], button=button, double=double, mods=mods)
            return f"clicked {p['what']}", p
        hit = self._click_control(target, button, double, mods)
        verb = "double clicked" if double else "right clicked" if button == "right" else "clicked"
        return f'{verb} {hit["ref"]} "{hit["label"]}"', hit

    @action
    def expand(self, target: str, open: bool = True):
        """Opens or closes a tree folder by its caret, a click on the row itself selects."""
        hit, loc = self._locator(target)
        state = loc.get_attribute("aria-expanded")
        if state is None:
            raise BadArgs(f'{hit["ref"]} "{hit["label"]}" is not a folder')
        if (state == "true") == open:
            return f'{hit["ref"]} "{hit["label"]}" already {"open" if open else "closed"}', hit
        loc.locator(".tree-caret").click(timeout=5000)
        return f'{"opened" if open else "closed"} {hit["ref"]} "{hit["label"]}"', hit

    @action
    def tool(self, label: str):
        steps = self.bridge.call("toolPath", label=label)["steps"]
        hit = None
        for i, s in enumerate(steps):
            hit = self._click_control(s["ref"], s["button"])
            if i < len(steps) - 1:
                self.page.wait_for_timeout(50)
        return f'started {hit["ref"]} "{hit["label"]}"', hit

    @action
    def type(self, target: str, text: str, enter: bool = False):
        hit, loc = self._locator(target)
        loc.click(timeout=5000)
        self.page.keyboard.press("Control+A")
        self.page.keyboard.type(str(text))
        value = self.bridge.call("fieldValue", target=hit["ref"])
        if enter:
            self.page.keyboard.press("Enter")
        problem = f', problem "{value["problem"]}"' if value.get("problem") else ""
        return f'typed "{text}" into {hit["ref"]} "{hit["label"]}"{problem}', {**value, "ref": hit["ref"], "label": hit["label"]}

    @action
    def press(self, *keys: str):
        if not keys:
            raise BadArgs("press needs a key, for example press(\"Enter\")")
        for k in keys:
            try:
                self.page.keyboard.press(key(k))
            except ValueError as e:
                raise BadArgs(str(e)) from None
        return "pressed " + " ".join(keys)

    @action
    def menu(self, path: str):
        top, _, item = path.partition("/")
        if not item:
            raise BadArgs('menu takes a path like "File/Save As..."')
        self._click_control(f"menu:{top}")
        hit = self._click_control(self._menu_ref(top, item))
        return f'chose {hit["ref"]}', hit

    def _menu_ref(self, top: str, item: str) -> str:
        """The app writes an ellipsis as one character, people type three dots."""
        refs = {r[1] for r in self._control_rows() if r[1].startswith(f"menu:{top}/")}
        for name in (item, item.replace("...", "…"), item.replace("…", "...")):
            if f"menu:{top}/{name}" in refs:
                return f"menu:{top}/{name}"
        return f"menu:{top}/{item}"

    @action
    def context_menu(self, on: str, item: str):
        target = selectors.canvas_target(on)
        if target:
            p = self._canvas_point(*target)
            self._mouse_click(p["x"], p["y"], button="right")
            where, on_hit = p["what"], {}
        else:
            on_hit = self._click_control(on, "right")
            where = on_hit["ref"]
        self.page.wait_for_timeout(50)
        ref = item if selectors.is_ref(item) else f"ctx:{item}"
        try:
            hit = self._click_control(ref)
        except NotFound:
            hit = self._click_control(item)
        if on_hit:
            hit = {**hit, "on_ref": on_hit["ref"], "on_label": on_hit["label"]}
        return f'chose {hit["ref"]} on {where}', hit

    @action
    def undo(self):
        self._click_control("#undo-btn")
        return "clicked #undo-btn"

    @action
    def redo(self):
        self._click_control("#redo-btn")
        return "clicked #redo-btn"

    @action
    def command(self, name: str):
        self.page.keyboard.press("Control+F")
        self.page.wait_for_timeout(50)
        self.page.keyboard.type(name)
        self.page.wait_for_timeout(50)
        listed = [r[3] for r in self._palette()[1:]]
        self.page.keyboard.press("Enter")
        self.page.wait_for_timeout(100)
        if self._palette():
            self.page.keyboard.press("Escape")
            shown = f', the list shows {", ".join(listed[:5])}' if listed else ", nothing matches"
            raise NotFound(f'no command runs for "{name}"{shown}')
        return f'ran command "{listed[0] if listed else name}"'

    def _palette(self) -> list[list]:
        """The search box row first, then its matches, or nothing when the search is closed."""
        rows = [r for r in self.bridge.call("screen", region="dialog", max=200)["lines"] if r[0] == 1]
        box = [r for r in rows if r[3].startswith("Search commands")]
        return box + [r for r in rows if r not in box] if box else []

    def _control_rows(self) -> list[list]:
        return self.bridge.call("screen", max=1000)["lines"]

    @action
    def panel(self, name: str, open: bool = True):
        want = name.strip().lower()
        if want in ("preferences", "settings"):
            close = [r for r in self.bridge.call("screen", region="dialog", max=200)["lines"] if r[0] == 1 and r[3] == "Close"]
            if not open:
                if not close:
                    return "preferences already closed"
                self._click_control(close[0][1])
                return "closed preferences"
            if close:
                return "preferences already open"
            self._click_control("menu:Edit")
            hit = self._click_control("menu:Edit/Preferences...")
            return f'opened {hit["ref"]}', hit
        rows = [r for r in self._control_rows() if r[0] == 1 and r[1] and r[3].lower().startswith(want)]
        rows.sort(key=lambda r: r[3].lower() != want)
        if not rows:
            raise NotFound(f'no panel button "{name}" on screen')
        ref, label, flags = rows[0][1], rows[0][3], rows[0][4]
        is_on = "on" in flags
        if is_on == open:
            return f'{label} already {"open" if open else "closed"}'
        self._click_control(ref)
        return f'{"opened" if open else "closed"} {ref} "{label}"'

    @action
    def view(self, name: str):
        want = name.strip().lower()
        label = VIEW_LABELS.get(want, name)
        self._click_control("Views")
        self.page.wait_for_timeout(50)
        hit = self._click_control(label if selectors.is_ref(label) else f"opt:{label}" if want in SIDES else label)
        self.page.keyboard.press("Escape")
        return f'view {hit["label"]}', hit

    # --- files ----------------------------------------------------------------

    def _repo_path(self, path: str | os.PathLike) -> str:
        p = Path(path)
        if not p.is_absolute() and not p.exists():
            p = self.repo / p
        if not p.is_file():
            raise BadArgs(f"no file {path}")
        return str(p.resolve())

    def _choose_file(self, menu_path: str, path: str | os.PathLike) -> str:
        full = self._repo_path(path)
        top, _, item = menu_path.partition("/")
        with self.page.expect_file_chooser(timeout=10_000) as fc:
            self._click_control(f"menu:{top}")
            self._click_control(self._menu_ref(top, item))
        fc.value.set_files(full)
        return full

    @action
    def open_file(self, path: str | os.PathLike):
        full = self._choose_file("File/Open...", path)
        return f"opened {Path(full).name}", {"path": full}

    @action
    def import_file(self, path: str | os.PathLike):
        """A browser tab imports a model by a file dropped on the canvas, as from the desktop."""
        full = self._repo_path(path)
        self._drop_on_canvas(full)
        return f"dropped {Path(full).name}", {"path": full}

    def _drop_on_canvas(self, full: str) -> None:
        data = base64.b64encode(Path(full).read_bytes()).decode("ascii")
        dt = self.page.evaluate_handle(
            """([name, b64]) => {
                const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                const dt = new DataTransfer();
                dt.items.add(new File([bytes], name));
                return dt;
            }""",
            [Path(full).name, data],
        )
        canvas = self.page.locator("#canvas")
        box = canvas.bounding_box()
        at = {"clientX": box["x"] + box["width"] / 2, "clientY": box["y"] + box["height"] / 2} if box else {}
        for kind in ("dragenter", "dragover", "drop"):
            canvas.dispatch_event(kind, {"dataTransfer": dt, **at})
        dt.dispose()

    @action
    def save_as(self, path: str | os.PathLike):
        """A browser tab saves by downloading the document, which lands at `path`."""
        out = Path(path)
        with self.page.expect_download(timeout=20_000) as dl:
            self._click_control("menu:File")
            self._click_control(self._menu_ref("File", "Save As..."))
        out.parent.mkdir(parents=True, exist_ok=True)
        dl.value.save_as(str(out))
        return f"saved {out.name}", {"path": str(out.resolve())}

    @action
    def new_document(self, discard: bool = True):
        self.page.keyboard.press("Control+N")
        self.page.wait_for_timeout(100)
        rows = [r for r in self._control_rows() if r[0] == 1 and r[1]]
        labels = [r for r in rows if r[3].lower().startswith(("discard", "don't save", "do not save"))]
        if labels:
            if not discard:
                raise HarnessError("the document has unsaved changes, pass discard=True to drop them")
            self._click_control(labels[0][1])
        return "new document"

    # --- the canvas -----------------------------------------------------------

    def _canvas_point(self, kind: str, sel: str, via: str = "select") -> dict:
        if kind == "face":
            return self.bridge.call("facePoint", select=sel)
        if kind == "edge":
            return self.bridge.call("edgePoint", select=sel, via=via)
        if kind == "plane":
            return self.bridge.call("planePoint", name=sel)
        raise BadArgs(f"unknown canvas target {kind}")

    def _mouse_click(self, x: float, y: float, button: str = "left", double: bool = False, mods=()) -> None:
        held = modifiers(mods)
        m = self.page.mouse
        m.move(x, y, steps=4)
        self.page.wait_for_timeout(40)
        for k in held:
            self.page.keyboard.down(k)
        try:
            if double:
                m.dblclick(x, y, button=button)
            else:
                m.click(x, y, button=button)
        finally:
            for k in reversed(held):
                self.page.keyboard.up(k)

    def _selection_after_click(self) -> dict:
        self.bridge.call("settle", timeoutMs=int(self.settle_timeout * 1000))
        return self.bridge.call("selection")

    def _pick(self, kind: str, sel: str, add: bool, exact: bool, via: str = "select") -> tuple[str, dict]:
        mods = (["Ctrl"] if add else []) + (["Shift"] if exact else [])
        p = self._canvas_point(kind, sel, via)
        self._mouse_click(p["x"], p["y"], mods=mods)
        got = self._selection_after_click()
        if kind == "face" and [p["body"], p["index"]] not in got["faces"] and p["body"] in got["bodies"]:
            self.page.wait_for_timeout(400)
            p = self._canvas_point(kind, sel, via)
            self._mouse_click(p["x"], p["y"], mods=mods)
            got = self._selection_after_click()
        if kind == "face" and [p["body"], p["index"]] not in got["faces"]:
            raise HarnessError(f"clicked {p['what']} but the selection is {got['faces'] or got['bodies'] or 'empty'}")
        if kind == "edge" and via == "select" and p["edgeId"] not in got["edges"]:
            raise HarnessError(f"clicked {p['what']} but the selection is {got['edges'] or 'empty'}")
        return f"picked {p['what']}", {**p, "selection": got}

    @action
    def pick_face(self, sel: str, add: bool = False, exact: bool = False):
        return self._pick("face", selectors.face(sel), add, exact)

    @action
    def pick_edge(self, sel: str, add: bool = False, exact: bool = False, via: str = "select"):
        return self._pick("edge", selectors.edge(sel), add, exact, via)

    @action
    def pick_plane(self, name: str):
        p = self._canvas_point("plane", name)
        self._mouse_click(p["x"], p["y"])
        return f"picked {p['what']}", p

    def _space_point(self, sketch=None, world=None, screen=None) -> dict:
        if sum(v is not None for v in (sketch, world, screen)) != 1:
            raise BadArgs("give one of sketch=(x, y), world=(x, y, z) or screen=(x, y)")
        if screen is not None:
            return {"x": screen[0], "y": screen[1], "covered": False}
        if sketch is not None:
            p = self.bridge.call("sketchPoint", x=sketch[0], y=sketch[1])
        else:
            p = self.bridge.call("worldPoint", x=world[0], y=world[1], z=world[2])
        if p["covered"]:
            raise Occluded(f"{sketch or world} is off the canvas or under a panel")
        return p

    @action
    def click_at(self, sketch=None, world=None, screen=None, button: str = "left", double: bool = False):
        p = self._space_point(sketch, world, screen)
        self._mouse_click(p["x"], p["y"], button=button, double=double)
        return f"clicked at {sketch or world or screen}", p

    @action
    def drag(self, from_, to, space: str = "sketch", button: str = "left", steps: int = 12):
        a = self._space_point(**{space: from_})
        b = self._space_point(**{space: to})
        m = self.page.mouse
        m.move(a["x"], a["y"], steps=4)
        m.down(button=button)
        m.move(b["x"], b["y"], steps=steps)
        m.up(button=button)
        return f"dragged from {from_} to {to}"

    @action
    def drag_handle(self, name: str, by: float | None = None, mm: float | None = None):
        if (by is None) == (mm is None):
            raise BadArgs("drag_handle takes by=<pixels> or mm=<distance>")
        h = self.bridge.call("handlePoint", name=name)
        dx, dy = h["dir"]
        if dx == 0 and dy == 0:
            raise Occluded(f"handle {name} points at the camera, turn the view first")
        px = by if by is not None else mm * h["pxPerMm"]
        m = self.page.mouse
        m.move(h["x"], h["y"], steps=4)
        self.page.wait_for_timeout(40)
        m.down()
        for i in range(1, 13):
            m.move(h["x"] + dx * px * i / 12, h["y"] + dy * px * i / 12)
        m.up()
        return f"dragged handle {h['name']} by {round(px)} px", h

    # --- waiting --------------------------------------------------------------

    def _seen_text(self, want: str) -> str | None:
        st = self.bridge.call("status")
        if want in (st.get("prompt") or "").lower():
            return f'prompt "{st["prompt"]}"'
        for r in self.bridge.call("messages", since=self._mark)["rows"]:
            if want in r["text"].lower():
                return f'message "{r["text"]}"'
        for r in self._control_rows():
            if want in r[3].lower():
                return f'on screen "{r[3]}"'
        return None

    def wait_for(self, text: str, timeout: float = 10) -> str:
        """Until the text shows in the prompt, the screen, or a message logged since the last action began."""
        self._ensure_page()
        end = time.monotonic() + timeout
        want = text.lower()
        while True:
            seen = self._seen_text(want)
            if seen:
                self._recorded("wait_for", (text,), {} if timeout == 10 else {"timeout": timeout}, seen)
                return seen
            if time.monotonic() > end:
                raise HarnessError(f'"{text}" did not show in {timeout:g} s')
            time.sleep(0.15)

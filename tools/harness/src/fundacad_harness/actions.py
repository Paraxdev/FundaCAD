"""What a person does: every action is real pointer or keyboard input, then a settle."""

from __future__ import annotations

import functools
import os
import re
import time
from pathlib import Path
from typing import Any, Callable

from . import selectors
from .errors import BadArgs, Disabled, HarnessError, NotFound, Occluded
from .keys import key, modifiers


# The app's Default View can crop a model that fills the canvas, iso fits it after.
VIEW_CLICKS = {"iso": ["Default View", "Fit to Model"], "default": ["Default View"], "fit": ["Fit to Model"]}
VIEWS_POPOVER = ".float-popover.vc-pop"
FOCUSED_FIELD = "() => { const a = document.activeElement; return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ? a : null; }"
SIDES = {"top", "bottom", "front", "back", "right", "left"}
# A wide stage has no button that opens a closed Items or History, a person uses the keys.
PANEL_KEYS = {"items": "Ctrl+Alt+s", "history": "Ctrl+Alt+h"}
OPEN_WAIT_S = 10
ON_TOP = """(el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && (top === el || el.contains(top));
}"""
# A big STEP assembly takes minutes to read and build, far past an ordinary step.
IMPORT_SETTLE_S = 300
PANELS = ("history", "items", "views", "display", "versions", "snapping", "preferences")


def out_path(path: str | os.PathLike) -> Path:
    """Where a file the harness writes goes, refused when its folder is missing so a typo makes nothing."""
    out = Path(path).resolve()
    if not out.parent.is_dir():
        raise BadArgs(f"no folder {out.parent}")
    return out


class Step:
    """What one action did, as one line (`str()`), with the JSON behind it in `data`."""

    def __init__(self, text: str, data: Any = None):
        self.text = text
        self.data = data

    def __str__(self) -> str:
        return self.text

    __repr__ = __str__


def _name(label: str) -> str:
    return " ".join(re.sub(r"\s*\([^()]*\)\s*$", "", label).split()).lower()


def found_by(target: str, hit: dict) -> str:
    """Where a label landed, so a click on a namesake elsewhere (a History row called Sketch) shows."""
    base = re.sub(r"#\d+$", "", target)
    if selectors.is_ref(base):
        return ""
    where = f' in {hit["region"]}' if hit.get("region") else ""
    if _name(hit["label"]) != _name(base):
        where += f', no control is named "{base}", this is the one label that starts so'
    return where


def action(fn: Callable) -> Callable:
    @functools.wraps(fn)
    def run(self, *args, settle: bool = True, **kwargs):
        self._ensure_page()
        outer = not getattr(self, "_in_action", False)
        if outer:
            self._mark = self.bridge.call("seq")
            self._settling = settle
        self._in_action = True
        navs = self._navs
        try:
            done = fn(self, *args, **kwargs)
            if settle:
                self.settle()
        except Exception as e:
            if self._navs == navs or isinstance(e, HarnessError):
                raise
            raise HarnessError(f"{fn.__name__} stopped, the page reloaded while it ran and the document is new") from e
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
        if self._reload_note:
            tail = f"{self._reload_note}, {tail}"
            self._reload_note = None
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
            if loc.evaluate(ON_TOP):
                raise Occluded(f'{hit["ref"]} "{hit["label"]}" did not take the click in 5 s, nothing is over it,'
                               " the page was busy, settle() and try again") from None
            raise Occluded(f'{hit["ref"]} "{hit["label"]}" did not take the click, something is over it') from None
        return hit

    @action
    def click(self, target: str, button: str = "left", double: bool = False, mods=()):
        """Clicks a control by ref or label, or the model at `face:<sel>` or `edge:<sel>`."""
        on = selectors.canvas_target(target)
        if on:
            p = self._canvas_point(*on)
            self._mouse_click(p["x"], p["y"], button=button, double=double, mods=mods)
            return f"clicked {p['what']}", p
        hit = self._click_control(target, button, double, mods)
        verb = "double clicked" if double else "right clicked" if button == "right" else "clicked"
        return f'{verb} {hit["ref"]} "{hit["label"]}"{found_by(target, hit)}', hit

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
        """Starts a rail tool by its label, opening its family first when it is folded inside one."""
        steps = self.bridge.call("toolPath", label=label)["steps"]
        before = self.bridge.call("status", since=self._mark)
        dialog = len(self.bridge.call("screen", region="dialog")["lines"])
        hit = None
        for i, s in enumerate(steps):
            hit = self._click_control(s["ref"], s["button"])
            if i < len(steps) - 1:
                self.page.wait_for_timeout(50)
        if not getattr(self, "_settling", True):
            return f'clicked {hit["ref"]} "{hit["label"]}"', hit
        self.settle()
        after = self.bridge.call("status", since=self._mark)
        asks = after.get("prompt") and after["prompt"] != before.get("prompt")
        if after.get("tool") or after["mode"] != before["mode"] or asks:
            return f'started {hit["ref"]} "{hit["label"]}"', hit
        shown = self.bridge.call("screen", region="dialog")["lines"]
        if len(shown) > dialog:
            names = ", ".join(r[3] for r in shown if r[1].startswith("choice:")) or ", ".join(r[3] for r in shown[:8])
            return f'clicked {hit["ref"]} "{hit["label"]}", it asks for a choice: {names}', hit
        return f'clicked {hit["ref"]} "{hit["label"]}", no tool, mode or prompt changed after it', hit

    @action
    def type(self, target: str, text: str, enter: bool = False):
        """Types into a value box field or a properties row, `enter=True` presses Enter after."""
        hit, loc = self._locator(target)
        self.bridge.call("fieldValue", target=hit["ref"])
        loc.click(timeout=5000)
        self.page.keyboard.press("Control+A")
        self.page.keyboard.type(str(text))
        value = self.bridge.call("fieldValue", target=hit["ref"])
        if enter:
            # A tool reads its value box once a frame, an Enter before that commits the old value.
            self.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
            self.page.keyboard.press("Enter")
        problem = f', problem "{value["problem"]}"' if value.get("problem") else ""
        return f'typed "{text}" into {hit["ref"]} "{hit["label"]}"{problem}', {**value, "ref": hit["ref"], "label": hit["label"]}

    @action
    def press(self, *keys: str):
        """Presses keys in turn, `press("Ctrl+Z")`, `press("Escape")`."""
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
        """Chooses a menu item, `menu("File/Save As...")`."""
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
        """Right clicks a control or `face:<sel>` and chooses an item of the menu that opens."""
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
        """The title bar Undo button, the step says what it changed."""
        return self._undo_redo("#undo-btn")

    @action
    def redo(self):
        """The title bar Redo button, the step says what it changed."""
        return self._undo_redo("#redo-btn")

    def _model_look(self) -> tuple[int, list[dict]]:
        return self.bridge.call("history")["count"], self.bridge.call("bodies")

    def _undo_redo(self, ref: str) -> str:
        rows = self.bridge.call("history").get("rows") or []
        big = getattr(self, "_imported", False) or any(r.get("type") == "import" for r in rows)
        before = self._model_look()
        try:
            self._click_control(ref)
        except Disabled:
            busy = self.bridge.call("status").get("busy") or ""
            if busy.startswith("Importing"):
                raise Disabled(f'{ref} is off while "{busy}" runs, it comes back once the import lands,'
                               " settle() first") from None
            raise
        if not getattr(self, "_settling", True):
            return f"clicked {ref}"
        self.settle(timeout=max(self.settle_timeout, IMPORT_SETTLE_S) if big else None)
        after = self._model_look()
        counts = (("features", before[0], after[0]), ("bodies", len(before[1]), len(after[1])))
        moved = [f"{what} {a} to {b}" for what, a, b in counts if a != b]
        if moved:
            return f"clicked {ref}, {', '.join(moved)}"
        was = {r.get("id"): r for r in before[1]}
        changed = []
        for key, words in (("material", "changed material"), ("slot", "changed colour"), ("visible", "shown or hidden")):
            n = sum(1 for r in after[1] if r.get("id") in was and was[r.get("id")].get(key) != r.get(key))
            if n:
                changed.append(f"{n} bod{'y' if n == 1 else 'ies'} {words}")
        if changed:
            return f"clicked {ref}, {', '.join(changed)}"
        return f"clicked {ref}, still {after[0]} features and {len(after[1])} bodies"

    @action
    def command(self, name: str):
        """Runs the best match of the command search (Ctrl+F), refused when nothing matches."""
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
            raise NotFound(f'no command runs for "{name}"{shown}{self._tool_hint(name)}')
        return f'ran command "{listed[0] if listed else name}"'

    def _tool_hint(self, name: str) -> str:
        try:
            self.bridge.call("toolPath", label=name)
        except HarnessError:
            return ""
        return f', it is a tool, start it with tool("{name}")'

    def _palette(self) -> list[list]:
        """The search box row first, then its matches, or nothing when the search is closed."""
        rows = [r for r in self.bridge.call("screen", region="dialog", max=200)["lines"] if r[0] == 1]
        box = [r for r in rows if r[3].startswith("Search commands")]
        return box + [r for r in rows if r not in box] if box else []

    def _control_rows(self) -> list[list]:
        return self.bridge.call("screen", max=1000)["lines"]

    @action
    def panel(self, name: str, open: bool = True):
        """Opens or closes a panel: history, items, views, display, versions, snapping, preferences."""
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
            hit = self._click_control(self._menu_ref("Edit", "Preferences..."))
            return f'opened {hit["ref"]}', hit
        rows = []
        for r in self._control_rows():
            if r[0] != 1 or not r[1]:
                continue
            label = r[3].lower()
            hides = label.startswith("hide the ")
            bare = label.removeprefix("hide the ").removeprefix("show the ")
            if bare.startswith(want):
                rows.append((bare.split(" (")[0] != want, r, hides or "on" in r[4]))
        rows.sort(key=lambda x: x[0])
        if not rows:
            keys = PANEL_KEYS.get(want)
            if keys is None:
                raise NotFound(f'no panel button "{name}" on screen, the panels are {", ".join(PANELS)}')
            if not open:
                return f"{want} already closed"
            self.page.keyboard.press(key(keys))
            return f"opened {want} with {keys[:-1] + keys[-1].upper()}"
        _, r, is_on = rows[0]
        ref, label = r[1], r[3]
        if is_on == open:
            return f'{want} already {"open" if open else "closed"}'
        self._click_control(ref)
        return f'{"opened" if open else "closed"} {ref} "{label}"'

    @action
    def view(self, name: str):
        """Turns the camera through the Views popover: iso, fit, top, front, right and the rest."""
        want = name.strip().lower()
        labels = VIEW_CLICKS.get(want) or ([f"opt:{want.capitalize()}"] if want in SIDES else [name])
        field = self.page.evaluate_handle(FOCUSED_FIELD)
        button = self._click_control("Views")["ref"]
        self.page.wait_for_timeout(50)
        hits = []
        try:
            for i, label in enumerate(labels):
                if i:
                    self.settle()
                    if not self._views_open():
                        self._click_control(button)
                hits.append(self._click_control(label))
        except NotFound:
            self._close_views(button, field)
            raise NotFound(f'no view "{name}", the views are {", ".join([*VIEW_CLICKS, *sorted(SIDES)])} or a label in the Views popover') from None
        self._close_views(button, field)
        said = f'view {" then ".join(h["label"] for h in hits)}'
        start = self.bridge.call("startScreen")
        if start != "none":
            said += f', it opened the {start} start screen, dismiss_start() or press("Escape") closes it'
        return said, hits[-1]

    def _views_open(self) -> bool:
        return bool(self.page.locator(VIEWS_POPOVER).count())

    def _close_views(self, button: str, field) -> None:
        """By its button, not Escape: a running Extrude hears an Escape before the popover does and cancels.
        The value box field gets its focus back, or the next Enter presses the Views button."""
        if self._views_open():
            self._click_control(button)
        self.page.evaluate("(el) => el?.isConnected && el.focus()", field)
        field.dispose()

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
    def open_file(self, path: str | os.PathLike, discard: bool = True):
        """File > Open, answering the file chooser with `path`, dropping unsaved changes unless `discard=False`."""
        was = self.bridge.call("history")
        full = self._choose_file("File/Open...", path)
        name = Path(full).name
        end = time.monotonic() + OPEN_WAIT_S
        while True:
            if self._answer_discard(discard):
                break
            st = self.bridge.call("status")
            if st.get("doc") == name and not st.get("dirty"):
                break
            if time.monotonic() > end:
                break
            self.page.wait_for_timeout(50)
        settling = getattr(self, "_settling", True)
        if settling:
            self.settle()
        st = self.bridge.call("status")
        # A refused file of the open document's own name leaves the name as it was, and the history too.
        refused = [r["text"] for r in self.bridge.call("messages", since=self._mark)["rows"] if r["level"] == "error"]
        if refused and self.bridge.call("history") != was:
            refused = []
        if st.get("doc") != name or refused:
            why = f", error: {refused[-1] if refused else st['error']}" if refused or st.get("error") else ""
            raise HarnessError(f'File > Open did not open {name}, the document is still "{st.get("doc")}"{why}')
        builds = "" if settling else ", the model builds on, settle() to see it"
        return f"opened {name}{builds}", {"path": full}

    @action
    def import_file(self, path: str | os.PathLike):
        """A browser tab imports a model by a file dropped on the canvas, as from the desktop."""
        full = self._repo_path(path)
        self._drop_on_canvas(full)
        self._imported = True
        if not getattr(self, "_settling", True):
            return f"dropped {Path(full).name}, the import runs on, wait_for or settle() to see it land", {"path": full}
        self.settle(timeout=max(self.settle_timeout, IMPORT_SETTLE_S))
        n = len(self.bridge.call("bodies"))
        return f"dropped {Path(full).name}, {n} bod{'y' if n == 1 else 'ies'} now", {"path": full, "bodies": n}

    def _drop_on_canvas(self, full: str) -> None:
        """The file goes in through a file input, which Chrome reads from disk, so a big one never crosses the bridge."""
        self.page.evaluate(
            """() => {
                const i = document.createElement("input");
                i.type = "file";
                i.hidden = true;
                i.dataset.harnessDrop = "";
                document.body.append(i);
            }"""
        )
        self.page.locator("input[data-harness-drop]").set_input_files(full)
        dt = self.page.evaluate_handle(
            """() => {
                const i = document.querySelector("input[data-harness-drop]");
                const dt = new DataTransfer();
                dt.items.add(i.files[0]);
                i.remove();
                return dt;
            }"""
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
        out = out_path(path)
        with self.page.expect_download(timeout=20_000) as dl:
            self._click_control("menu:File")
            self._click_control(self._menu_ref("File", "Save As..."))
        dl.value.save_as(str(out))
        named = dl.value.suggested_filename
        also = f", the app named it {named}" if named and named != out.name else ""
        return f"saved {out}{also}", {"path": str(out), "app_name": named}

    @action
    def new_document(self, discard: bool = True):
        """Ctrl+N, dropping unsaved changes unless `discard=False`."""
        self.page.keyboard.press("Control+N")
        self.page.wait_for_timeout(100)
        self._answer_discard(discard)
        return "new document"

    def _answer_discard(self, discard: bool) -> bool:
        """Answers the app's unsaved changes question when it is up, Cancel and a refusal for `discard=False`."""
        rows = [r for r in self.bridge.call("screen", region="dialog", max=200)["lines"] if r[0] == 1 and r[1]]
        labels = [r for r in rows if r[3].lower().startswith(("discard", "don't save", "do not save"))]
        if not labels:
            return False
        if not discard:
            cancel = [r for r in rows if r[3].lower() == "cancel"]
            if cancel:
                self._click_control(cancel[0][1])
            raise HarnessError("the document has unsaved changes, pass discard=True to drop them")
        self._click_control(labels[0][1])
        return True

    # --- the canvas -----------------------------------------------------------

    def _canvas_point(self, kind: str, sel: str, via: str = "select") -> dict:
        try:
            return self._canvas_point_of(kind, sel, via)
        except Occluded as e:
            raise Occluded(self._dialog_first(str(e))) from None

    def _dialog_first(self, why: str) -> str:
        """Every canvas point is under an open dialog's backdrop, which no view change fixes."""
        lines = self.bridge.call("screen", region="dialog", max=50)["lines"]
        rows = [r for r in lines if r[0] == 1 and r[1]]
        if not rows or not any(r[0] == 0 and r[3] == "modal" for r in lines):
            return why
        return f'a dialog is open over the canvas ({", ".join(r[1] for r in rows[:6])}), answer or close it first'

    def _canvas_point_of(self, kind: str, sel: str, via: str) -> dict:
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
        self.settle()
        return self.bridge.call("selection")

    @staticmethod
    def _selected(kind: str, p: dict, got: dict, via: str) -> bool:
        if kind == "face":
            return [p["body"], p["index"]] in got["faces"]
        return via == "select" and p["edgeId"] in got["edges"]

    def _pick(self, kind: str, sel: str, add: bool, exact: bool, via: str = "select") -> tuple[str, dict]:
        mods = (["Ctrl"] if add else []) + (["Shift"] if exact else [])
        p = self._canvas_point(kind, sel, via)
        if add and self._selected(kind, p, self.bridge.call("selection"), via):
            return f"kept {p['what']}, it was already selected and Ctrl would take it off", p
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
        """Selects a face by selector (`top`, `body1:largest`), `add` holds Ctrl, `exact` holds Shift."""
        return self._pick("face", selectors.face(sel), add, exact)

    @action
    def pick_edge(self, sel: str, add: bool = False, exact: bool = False, via: str = "select"):
        """Selects an edge by selector (`between top front`, `near=x,y,z`, `longest`)."""
        return self._pick("edge", selectors.edge(sel), add, exact, via)

    @action
    def pick_plane(self, name: str):
        """Clicks a base plane (XY, XZ, YZ) or a datum plane by id."""
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
            raise Occluded(self._dialog_first(f"{sketch or world} is off the canvas or under a panel"))
        return p

    @action
    def click_at(self, sketch=None, world=None, screen=None, button: str = "left", double: bool = False):
        """Clicks at one of `sketch=(x, y)`, `world=(x, y, z)` or `screen=(x, y)`."""
        p = self._space_point(sketch, world, screen)
        self._mouse_click(p["x"], p["y"], button=button, double=double)
        return f"clicked at {sketch or world or screen}", p

    @action
    def drag(self, from_, to, space: str = "sketch", button: str = "left", steps: int = 12):
        """Drags between two points of `space`: sketch, world or screen."""
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
        """Drags a named handle along its axis by `by` pixels or about `mm` millimetres."""
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
        self.page.wait_for_timeout(50)
        values = self._value_box()
        reached = f", value box {values}" if values else ""
        return f"dragged handle {h['name']} by {round(px)} px{reached}", {**h, "values": values}

    def _value_box(self) -> str:
        """The value box fields as `field:distance 4.75`, a drag by mm lands near the value, not on it."""
        out = []
        for r in self.bridge.call("screen", region="valuebox", max=50)["lines"]:
            if r[0] == 1 and r[1].startswith("field:"):
                out.append(f'{r[1]} {self.bridge.call("fieldValue", target=r[1])["text"]}')
        return ", ".join(out)

    # --- waiting --------------------------------------------------------------

    def _seen_text(self, want: str) -> str | None:
        st = self.bridge.call("status")
        if want in (st.get("prompt") or "").lower():
            return f'prompt "{st["prompt"]}"'
        for r in self.bridge.call("messages", since=self._mark)["rows"]:
            if want in r["text"].lower():
                return f'message "{r["text"]}"'
        for r in self.bridge.call("screen", max=1000, fresh=True)["lines"]:
            if want in r[3].lower():
                return f'on screen "{r[3]}"'
        return None

    def _seen_before(self, want: str) -> str:
        if any(want in r["text"].lower() for r in self.bridge.call("messages", since=0)["rows"]):
            where = "said"
        elif any(want in r[3].lower() for r in self.bridge.call("screen", max=1000)["lines"]):
            where = "on screen"
        else:
            return ""
        return f', "{want}" was {where} before the last step began and wait_for takes only what is new, read it with s.screen() or s.messages()'

    def wait_for(self, text: str, timeout: float = 10) -> str:
        """Until the text shows in the prompt, a message logged or a label shown since the last action began."""
        self._ensure_page()
        end = time.monotonic() + timeout
        want = text.lower()
        while True:
            seen = self._seen_text(want)
            if seen:
                self._recorded("wait_for", (text,), {} if timeout == 10 else {"timeout": timeout}, seen)
                return seen
            if time.monotonic() > end:
                raise HarnessError(f'"{text}" did not show in {timeout:g} s{self._seen_before(want)}')
            time.sleep(0.15)

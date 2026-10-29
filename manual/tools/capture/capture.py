"""Retakes the manual's pictures from the manifests, through the agent harness.

python manual/tools/capture/capture.py --area model --only fillet-edge
python manual/tools/capture/capture.py --area all --list
"""
import argparse
import base64
import os
import shutil
import struct
import sys
import tempfile
import time
import tomllib
from pathlib import Path
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
MANIFESTS = HERE / "manifests"
FIXTURES = (HERE / "fixtures", REPO / "tools" / "harness" / "fixtures")
AREAS = ("start-files", "model", "sketch", "inspect", "render", "ai-plugins-reference", "readme-design")
DEFAULT_VIEWPORT = (1440, 900)
DEFAULT_PAUSE = 400
THEME_ALIASES = {"dark": "fundacad", "noir": "fundacad", "light": "solarized-light"}
# Playwright does not report where the mouse is, so relative moves ("by") start from here.
MOUSE = [0.0, 0.0]
# Screenshots taken again after a hang, reported with the shot.
RETRIES = [0]
# Session methods a step may not call, they would end or restart the session.
NOT_STEPS = {"open", "close", "call", "screenshot", "pids"}

WATCH_OPEN = """() => {
  window.__captureOpened = false;
  const off = window.store.onOpen(() => { window.__captureOpened = true; off(); });
}"""
OPENED = "() => window.__captureOpened && window.store.document.features.length > 0"
SET_THEME = "(id) => import('/src/ui/theme.ts').then((m) => m.setTheme(id))"
SET_PARAM = "([n, e]) => window.store.setParamExpr(n, e)"
# The frame and rebuild timings differ on every run, so a retake would change for no reason. readouts = true keeps them.
HIDE_READOUTS = """(hide) => {
  let el = document.getElementById('capture-hide-readouts');
  if (!el) {
    el = document.createElement('style');
    el.id = 'capture-hide-readouts';
    el.textContent = '#fps, .roundtrip { visibility: hidden !important; } .perf-warn-group { display: none !important; }';
    document.head.append(el);
  }
  el.disabled = !hide;
}"""
# The browser decodes a screenshot to raw RGBA much faster than Python can unfilter a PNG.
DECODE = """async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }),
    { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
  return [bmp.width, bmp.height, btoa(s)];
}"""


class ShotError(Exception):
    pass


def serve_fonts(page):
    """In a worktree whose node_modules is a junction, vite sees the fonts at their real path, outside the folders it
    may serve, and answers 403, so the app falls back to a system font. The page reads them from disk instead."""
    modules = (REPO / "node_modules").resolve()
    if modules == REPO / "node_modules":
        return

    def fulfill(route):
        rel = unquote(route.request.url.split("/@fs/", 1)[1].split("?", 1)[0])
        f = Path(rel).resolve()
        if f.is_relative_to(modules) and f.is_file():
            route.fulfill(body=f.read_bytes(), content_type=f"font/{f.suffix[1:]}")
        else:
            route.fallback()

    page.route("**/@fs/**/*.woff2*", fulfill)
    page.route("**/@fs/**/*.woff", fulfill)


def start_vite(log: Path):
    from fundacad_harness.launch import LaunchError, free_port, http_ok, spawn

    node = shutil.which("node")
    if not node:
        raise LaunchError("node is not on PATH")
    port = free_port()
    cmd = [node, str(REPO / "node_modules" / "vite" / "bin" / "vite.js"), "--config", str(HERE / "vite.config.mjs"),
           "--host", "127.0.0.1", "--port", str(port), "--strictPort"]
    proc = spawn("vite", cmd, REPO, dict(os.environ), log)
    end = time.monotonic() + 90
    while time.monotonic() < end:
        if http_ok(f"http://127.0.0.1:{port}/"):
            return proc, f"http://127.0.0.1:{port}"
        if not proc.alive():
            break
        time.sleep(0.25)
    proc.stop()
    raise LaunchError(f"vite did not answer on port {port}", proc.tail())


def load(area: str) -> list[dict]:
    path = MANIFESTS / f"{area}.toml"
    if not path.exists():
        raise SystemExit(f"no manifest {path.relative_to(REPO)}")
    with open(path, "rb") as f:
        shots = tomllib.load(f).get("shot", [])
    for shot in shots:
        shot["area"] = area
        if "file" not in shot:
            raise SystemExit(f"{path.name}: an entry has no file")
    return shots


def name_of(shot: dict) -> str:
    return Path(shot["file"]).stem


def png_size(path: Path) -> tuple[int, int]:
    with open(path, "rb") as f:
        head = f.read(24)
    return struct.unpack(">II", head[16:24])


def theme_id(shot: dict) -> str:
    t = shot.get("theme", "fundacad")
    return THEME_ALIASES.get(t, t)


def viewport_of(shot: dict) -> tuple[int, int]:
    if "viewport" in shot:
        return tuple(shot["viewport"])
    if shot.get("crop", "window") == "window" and "size" in shot:
        return tuple(shot["size"])
    return DEFAULT_VIEWPORT


# --- steps ------------------------------------------------------------------


def open_example(s, name: str):
    unsaved = s.status(raw=True)["dirty"]
    if s.bridge.call("startScreen") != "home":
        s.menu("File/Home")
    s.page.evaluate(WATCH_OPEN)
    s.page.click(f'.home-example:has-text("{name}")')
    if unsaved:
        s.click("Discard")
    # The card fetches its file before anything is busy, so settle alone can return during that fetch.
    s.page.wait_for_function(OPENED, timeout=60_000, polling=100)
    s.settle()


def do_open(s, what: str, name: str | None = None):
    kind, _, arg = what.partition(":")
    if kind == "example":
        open_example(s, arg)
    elif kind == "fixture":
        found = [d / arg for d in FIXTURES if (d / arg).exists()]
        if not found:
            raise ShotError(f"no fixture {arg} in {' or '.join(str(d.relative_to(REPO)) for d in FIXTURES)}")
        src = found[0]
        if name:
            # The title bar shows the file name, and .funda files may not be committed outside a few folders.
            named = Path(tempfile.gettempdir()) / "fundacad-capture" / "open" / name
            named.parent.mkdir(parents=True, exist_ok=True)
            src = shutil.copyfile(src, named)
        s.open_file(src)
    elif kind == "file":
        s.open_file(REPO / arg)
    elif kind == "new":
        s.new_document()
        s.settle()
    elif kind == "home":
        if s.bridge.call("startScreen") != "home":
            s.menu("File/Home")
        s.settle()
    else:
        raise ShotError(f'open takes example:<name>, fixture:<file>, file:<path>, new or home, not "{what}"')


def point(s, at, space: str):
    if space == "screen":
        return at[0], at[1]
    p = s.bridge.call("worldPoint" if space == "world" else "sketchPoint", **dict(zip("xyz", at)))
    return p["x"], p["y"]


def run_step(s, step):
    """One step: a table whose first key names the action and whose other keys are its options."""
    if isinstance(step, str):
        step = {step: True}
    action, value = next(iter(step.items()))
    opts = dict(list(step.items())[1:])
    page = s.page
    if action == "open":
        do_open(s, value, opts.get("name"))
    elif action == "theme":
        page.evaluate(SET_THEME, THEME_ALIASES.get(value, value))
    elif action == "evaluate":
        page.evaluate(value)
    elif action == "wait":
        page.wait_for_timeout(value)
    elif action == "param":
        err = page.evaluate(SET_PARAM, [value, str(opts["value"])])
        if err:
            raise ShotError(f"parameter {value}: {err}")
        s.settle()
    elif action == "click_css":
        page.click(value)
    elif action == "hover":
        if isinstance(value, str):
            page.hover(value)
        else:
            MOUSE[:] = point(s, value, opts.get("space", "screen"))
            page.mouse.move(*MOUSE)
    elif action == "mouse":
        m = page.mouse
        if "at" in opts:
            MOUSE[:] = point(s, opts["at"], opts.get("space", "screen"))
        elif "by" in opts:
            MOUSE[:] = [MOUSE[0] + opts["by"][0], MOUSE[1] + opts["by"][1]]
        if "at" in opts or "by" in opts:
            m.move(*MOUSE, steps=opts.get("steps", 1))
        if value == "down":
            m.down(button=opts.get("button", "left"))
        elif value == "up":
            m.up(button=opts.get("button", "left"))
    else:
        fn = getattr(s, action, None)
        if action.startswith("_") or action in NOT_STEPS or not callable(fn):
            raise ShotError(f'unknown step "{action}"')
        args = [] if value is True else value if isinstance(value, list) else [value]
        fn(*args, **opts)


def run_steps(s, steps):
    for step in steps or []:
        try:
            run_step(s, step)
        except ShotError:
            raise
        except Exception as e:
            raise ShotError(f"step {step}: {type(e).__name__}: {e}") from None


# --- crops ------------------------------------------------------------------


def element_box(s, css: str) -> dict:
    loc = s.page.locator(css).first
    loc.wait_for(state="visible", timeout=10_000)
    box = loc.bounding_box()
    if not box:
        raise ShotError(f'nothing on screen matches "{css}"')
    return box


def crop_rect(s, shot: dict) -> dict | None:
    kind = shot.get("crop", "window")
    vw, vh = s.page.viewport_size["width"], s.page.viewport_size["height"]
    w, h = shot.get("size", (vw, vh))
    if kind == "window":
        return None
    if kind == "panel":
        box = element_box(s, shot["target"])
    elif kind == "control":
        hit = s.call("locate", target=shot["target"], disabled=True)
        box = element_box(s, f'[data-harness-target="{hit["marker"]}"]')
    elif kind == "region":
        if "at" in shot:
            x, y = shot["at"]
        else:
            around = shot.get("around")
            if around is None:
                cx, cy = vw / 2, vh / 2
            elif around.startswith(("world:", "sketch:")):
                space, _, nums = around.partition(":")
                cx, cy = point(s, [float(n) for n in nums.split(",")], space)
            else:
                b = element_box(s, around)
                cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
            dx, dy = shot.get("offset", (0, 0))
            x, y = cx - w / 2 + dx, cy - h / 2 + dy
        box = {"x": x, "y": y, "width": w, "height": h}
    else:
        raise ShotError(f'crop "{kind}" is not window, panel, control, region, copy or keep')
    pad = shot.get("pad", 0)
    x0, y0 = box["x"] - pad, box["y"] - pad
    x1, y1 = box["x"] + box["width"] + pad, box["y"] + box["height"] + pad
    if kind != "region" and shot.get("fit") == "size":
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        x0, y0, x1, y1 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
    x0, y0 = max(0, round(x0)), max(0, round(y0))
    x1, y1 = min(vw, round(x1)), min(vh, round(y1))
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}


# --- taking -----------------------------------------------------------------


def prepare(s, shot: dict):
    s.page.evaluate("document.fonts.ready.then(() => true)")
    for _ in range(2):
        s.page.keyboard.press("Escape")
    s.panel("preferences", open=False)
    w, h = viewport_of(shot)
    if s.page.viewport_size != {"width": w, "height": h}:
        s.page.set_viewport_size({"width": w, "height": h})
    s.page.evaluate(SET_THEME, theme_id(shot))
    s.page.evaluate(HIDE_READOUTS, not shot.get("readouts", False))
    steps = shot.get("steps", [])
    first = steps[0] if steps else None
    if not (isinstance(first, dict) and next(iter(first)) == "open"):
        do_open(s, "new")
    run_steps(s, steps)
    s.settle()


def still(s, shot: dict, rect, path: Path):
    if "park" in shot:
        s.page.mouse.move(*shot["park"])
    s.page.wait_for_timeout(shot.get("pause", DEFAULT_PAUSE))
    path.write_bytes(grab(s, rect))


def grab(s, rect) -> bytes:
    """A screenshot, tried again when it hangs: under SwiftShader one now and then waits on a frame that never comes,
    and the next one is taken at once."""
    for attempt in range(3):
        try:
            return s.page.screenshot(clip=rect, timeout=15_000) if rect else s.page.screenshot(timeout=15_000)
        except Exception as e:
            if "Timeout" not in str(e) or attempt == 2:
                raise
            RETRIES[0] += 1
            s.page.wait_for_timeout(500)


def take_gif(s, shot: dict, rect, path: Path, frames_dir: Path) -> str:
    from gif import write_gif

    gif = shot.get("gif", {})
    delay = gif.get("delay", 100)
    frames_dir.mkdir(parents=True, exist_ok=True)
    for old in frames_dir.glob("*.png"):
        old.unlink()
    frames = []
    for frame in shot.get("frames", []):
        for _ in range(frame.get("repeat", 1)):
            run_steps(s, frame.get("steps", []))
            if frame.get("settle", True):
                s.settle()
            s.page.wait_for_timeout(frame.get("pause", 150))
            png = grab(s, rect)
            (frames_dir / f"{len(frames) + 1:03}.png").write_bytes(png)
            w, h, data = s.page.evaluate(DECODE, base64.b64encode(png).decode())
            frames.append((w, h, base64.b64decode(data), frame.get("hold", delay)))
    if not frames:
        raise ShotError("a GIF entry needs frames")
    info = write_gif(path, frames, loop=gif.get("loop", 0))
    return f'{info["frames"]} frames, {info["colours"]} colours, {info["bytes"] // 1024} KB, frames in {frames_dir}'


def take(s, shot: dict, out: Path, frames_root: Path) -> str:
    RETRIES[0] = 0
    prepare(s, shot)
    rect = crop_rect(s, shot)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.suffix.lower() == ".gif":
        note = take_gif(s, shot, rect, out, frames_root / name_of(shot))
        w, h = (rect["width"], rect["height"]) if rect else viewport_of(shot)
    else:
        still(s, shot, rect, out)
        w, h = png_size(out)
        note = ""
    want = tuple(shot.get("size", (w, h)))
    size = f"{w}x{h}" if (w, h) == want else f"{w}x{h}, the manifest says {want[0]}x{want[1]}"
    if RETRIES[0]:
        note += f" {RETRIES[0]} screenshots taken again after a hang"
    errors = s.page_errors()
    if errors:
        note += f" page errors: {errors[-3:]}"
    return f"{size} {note}".strip()


def target_path(shot: dict, out_dir: Path | None) -> Path:
    return (out_dir / Path(shot["file"]).name) if out_dir else REPO / shot["file"]


def list_shots(shots):
    for shot in shots:
        size = "x".join(map(str, shot.get("size", ("?", "?"))))
        flag = "stub" if shot.get("stub") else shot.get("crop", "window")
        print(f'{shot["area"]:<22}{name_of(shot):<28}{flag:<9}{size:<11}{shot.get("show", "")[:90]}')


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Retakes the manual's pictures from the manifests.")
    ap.add_argument("--area", required=True, choices=AREAS + ("all",))
    ap.add_argument("--only", action="append", default=[], help="picture names, without folder or extension")
    ap.add_argument("--list", action="store_true", help="list the entries and stop")
    ap.add_argument("--out", type=Path, help="write the pictures here instead of over the files in the repo")
    ap.add_argument("--frames", type=Path, help="folder for the GIF frames, a temp folder by default")
    ap.add_argument("--engine", help="engine binary, FUNDACAD_ENGINE_CMD by default")
    ap.add_argument("--settle-timeout", type=float, default=120)
    args = ap.parse_args(argv)

    areas = AREAS if args.area == "all" else (args.area,)
    shots = [shot for a in areas if args.area != "all" or (MANIFESTS / f"{a}.toml").exists() for shot in load(a)]
    wanted = {n for item in args.only for n in item.split(",") if n}
    if wanted:
        shots = [x for x in shots if name_of(x) in wanted or Path(x["file"]).name in wanted]
        missing = wanted - {name_of(x) for x in shots} - {Path(x["file"]).name for x in shots}
        if missing:
            print(f'not in the manifest: {", ".join(sorted(missing))}', file=sys.stderr)
    if args.list:
        list_shots(shots)
        return 0

    frames_root = args.frames or Path(tempfile.gettempdir()) / "fundacad-capture"
    live = []
    for shot in shots:
        kind = shot.get("crop", "window")
        out = target_path(shot, args.out)
        if shot.get("stub"):
            print(f"skip {shot['file']}: stub, {shot.get('show', '')[:100]}")
        elif kind == "keep":
            print(f"keep {shot['file']}")
        elif kind == "copy":
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / shot["from"], out)
            print(f"copied {shot['from']} to {out}")
        else:
            live.append(shot)
    if not live:
        return 0

    sys.path.insert(0, str(REPO / "tools" / "harness" / "src"))
    sys.path.insert(0, str(HERE))
    from fundacad_harness import Session

    class CaptureSession(Session):
        def _launch_browser(self):
            super()._launch_browser()
            serve_fonts(self.page)

    frames_root.mkdir(parents=True, exist_ok=True)
    vite, vite_url = start_vite(frames_root / "vite.log")
    try:
        failed = shoot(live, args, frames_root, CaptureSession, vite_url)
    finally:
        vite.stop()
    return 1 if failed else 0


def shoot(live, args, frames_root: Path, CaptureSession, vite_url: str) -> int:
    failed = 0
    for gpu in (False, True):
        batch = [x for x in live if bool(x.get("gpu")) == gpu]
        if not batch:
            continue
        with CaptureSession(engine=args.engine, viewport=viewport_of(batch[0]), gpu=gpu, vite_url=vite_url,
                            settle_timeout=args.settle_timeout, repo=REPO) as s:
            for shot in batch:
                out = target_path(shot, args.out)
                t = time.monotonic()
                try:
                    note = take(s, shot, out, frames_root)
                    print(f"took {out} {note} in {time.monotonic() - t:.0f} s")
                except Exception as e:
                    failed += 1
                    frames_root.mkdir(parents=True, exist_ok=True)
                    seen = frames_root / f"{name_of(shot)}-failed.png"
                    try:
                        s.page.screenshot(path=str(seen))
                    except Exception:
                        seen = None
                    print(f"FAILED {shot['file']}: {e}" + (f", the screen is in {seen}" if seen else ""))
    return failed


if __name__ == "__main__":
    sys.exit(main())

# Capture

Retakes the manual's pictures, and the README and design pictures, from a manifest per area. It drives the app headless through the agent harness (`tools/harness`, see `docs/HARNESS.md`), so each picture can be taken again after the UI changes.

```sh
export FUNDACAD_ENGINE_CMD=<path to a fresh fundacad-engine>
python manual/tools/capture/capture.py --area model --list
python manual/tools/capture/capture.py --area model --only fillet-edge,fillet-drag
python manual/tools/capture/capture.py --area sketch --out /tmp/shots
```

Pictures are written over the files in the repo unless `--out` names a folder. GIF frames go to a temp folder (`--frames` to choose one) so you can look at them. Look at every picture before you commit it.

The areas are `start-files`, `model`, `sketch`, `inspect`, `render`, `ai-plugins-reference` and `readme-design`, one file each in `manifests/`.

## An entry

```toml
[[shot]]
file = "manual/docs/img/history-card.png"
size = [300, 389]
theme = "fundacad"
crop = "panel"
target = "#timeline"
show = "The History card of the Wall bracket with its features in order."
alt = "The History card"
steps = [
  { open = "example:Wall bracket" },
  { panel = "history" },
]
```

| key | meaning |
|---|---|
| `file` | the picture, from the repo root |
| `size` | its size in pixels; a window shot sets the page to it |
| `theme` | a theme id: `fundacad` (dark, the default), `dracula`, `solarized-light`, `colorblind-safe` |
| `viewport` | the page size when it is not the picture size, 1440x900 by default |
| `crop` | `window`, `panel`, `control`, `region`, `copy` or `keep` |
| `steps` | what to do before the picture, in order |
| `pause` | ms to wait before the picture, 400 by default |
| `park` | `[x, y]` to move the mouse to first, so no tooltip shows |
| `gpu` | `true` for a real GPU, in a session of its own; keep renders short and capped |
| `stub` | `true` until the entry has its steps, the tool skips it |
| `readouts` | `true` keeps the frame and rebuild timings, which are hidden so a retake does not change for no reason |
| `show`, `alt` | what the picture must show and the page's alt text |

Each entry starts from a new document in its theme unless its first step opens something.

In a worktree whose node_modules is a junction, vite refuses the app's fonts, so the tool serves them from disk. A picture in a system font was taken without the tool.

The tool runs its own vite (`vite.config.mjs` here) with a dependency cache in the temp folder, one per checkout. A junctioned node_modules shares vite's usual cache with every other checkout, and when another vite rebuilds it, this page reloads in the middle of a shot. The low performance warning SwiftShader brings up is hidden too, and a screenshot that hangs is taken again (the result line counts them).

## Crops

- `window`: the whole page.
- `panel`: the element matched by the CSS selector in `target`.
- `control`: the control the harness finds by the label in `target`.
- `region`: a box of `size`, at `at = [x, y]` or centred on `around`, which is a CSS selector, `world:x,y,z` or `sketch:x,y`, moved by `offset = [dx, dy]`.
- `copy`: a copy of the picture in `from`.
- `keep`: left as it is.

`pad` grows a panel or control crop, and `fit = "size"` makes it exactly `size` around its centre.

## Steps

A step is a table whose first key is the action, the other keys are its options.

- `{ open = "example:Wall bracket" }`, also `fixture:sketch-extrude.json` (from `fixtures/` here, then `tools/harness/fixtures`), `file:<path>`, `new` or `home`. `name = "Block.funda"` opens a fixture under that file name, for the title bar.
- Any harness action with its arguments: `{ tool = "Extrude" }`, `{ pick_face = "..." }`, `{ type = ["Depth", "12"], enter = true }`, `{ drag_handle = "Distance", mm = 10 }`, `{ menu = "File/Export" }`, `{ panel = "history" }`, `{ view = "iso" }`, `{ press = "Escape" }`.
- `{ theme = "dracula" }`, `{ param = "width", value = "40" }`, `{ wait = 300 }`, `{ evaluate = "() => ..." }`.
- `{ click_css = ".selector" }`, `{ hover = ".selector" }` or `{ hover = [x, y], space = "world" }`.
- `{ mouse = "down", at = [x, y], space = "screen" }`, then `"move"` and `"up"`, to hold a drag open across GIF frames. `by = [dx, dy]` in place of `at` moves from where the mouse is, so a repeated frame keeps going.

## GIFs

A `.gif` entry takes its `steps`, fixes the crop, then takes `frames` in order:

```toml
gif = { delay = 100, loop = 0 }
frames = [
  { hold = 800 },
  { steps = [{ mouse = "move", by = [30, 0], steps = 4 }], repeat = 8, hold = 80, settle = false },
  { steps = [{ mouse = "up" }], hold = 1500 },
]
```

`repeat` runs the frame's steps again before each of its pictures, `hold` is how long a frame shows in ms. The encoder is in `gif.py`, plain Python with no dependency: one palette of up to 255 colours, and each frame stores only what changed.

To turn the camera, make each frame its own short right drag (down, move `by`, up) pressed on empty canvas well away from the part: the orbit then pivots on the part's centre every time, and the picture is still when it is taken. Pressed on the part, each drag pivots on whatever is under the cursor, and the mouse left over a face highlights it. `orbit` in `ai-plugins-reference.toml` does this.

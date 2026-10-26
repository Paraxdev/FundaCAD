# FundaCAD design spec

This is the visual language of FundaCAD as it exists in the code, written for
whoever is about to build or change UI: a contributor, a plugin author or an AI
agent. Read it before you write markup or styles, and run the
[checklist](#13-checklist-before-ui-work-is-done) before you call the work done.

The code is the source of truth. Every value below is quoted from
`src/styles/_tokens.scss`, `src/styles/_glass.scss` and the other partials in
`src/styles/`. Where this page asks for something no code does yet, it says
so with the words **prescribed, no code does this yet**. If you change one of
those files, change this page in the same commit.
`tests/ui/designSpec.test.ts` holds the rules a machine can check
([section 15](#15-the-guard-test)).

![The workspace in FundaCAD Noir: every panel floats over the model as glass](design/workspace-dark.png)

## 1. Principles

1. **The model is the hero.** The WebGL viewport fills the stage. Apart from
   the 36px title bar and, in Render mode, the Render dock column beside the
   stage, every piece of chrome floats over the model and leaves it visible
   around and through itself.
2. **Glass, never a slab.** A surface over the model is translucent: a tinted
   fill with `backdrop-filter: blur(24px) saturate(1.08)`, one soft shadow and
   squircle corners. The bodies behind smear into the panel. That smear is the
   product's signature.
3. **Float with air.** Floating cards sit `--float-gap` (12px) from the stage
   edges and from each other. The layers that hold them pass pointer events
   through, so the model stays pickable in every gap.
4. **Depth without lines.** Depth comes from fill and shadow, never from an
   outline around a rounded surface. Each level up is a touch lighter (card,
   tile, chip) and a field sinks a touch darker. A hover, a selection or a
   pressed state is a fill or a wash, never a border colour or a ring. Layout
   dividers stay: the title bar edge, the lines between the head, body and foot
   of a dialog, menu separators. The rules and the few exceptions are in
   [Depth without lines](#depth-without-lines).
5. **Calm accent.** The accent appears only on what is active, selected,
   focused or primary, as a wash, a text colour, an underline or a small fill,
   never as a large flat fill. There is no glow, sheen, rim or inner highlight
   anywhere. One exception is in every tool panel: `.measure-title` is
   `--accent-hot`, so the readout reads as the tool's output
   ([7.13](#713-tool-and-readout-panels-measure-panel)). Card and dialog titles
   stay `--text`.
6. **Dense rows, generous shell.** Rows and labels are small (12 to 12.5px,
   34px rows, 40px tiles). The air lives at the shell level: gaps, card
   padding, big corner radii.
7. **Tokens only.** Every colour, radius, gap, duration and shadow is a custom
   property. Themes swap the colour tokens, and one shipped theme is light.
8. **Degrade, never redesign.** Blur off (potato mode or a software renderer),
   animations off and touch input each have one shared switch. A new surface
   that uses the shared tokens and classes supports all three with no code of
   its own.
9. **Reuse before you invent.** A new surface is an existing glass class, or a
   selector added to the existing lists in `_glass.scss`. A new look is almost
   always a mistake.

Nothing is flat and opaque unless this spec names it. The legitimate exceptions:

| Flat on purpose | Why |
|---|---|
| `#titlebar` (opaque `--panel`, `border-bottom: 1px solid var(--line)`) and what sits in it (`.tb-btn`, `.menu-btn`, `.seg-btn`, `#context-tab`) | The one full width strip that does not float; the stage starts below it |
| Inset wells inside a glass dialog (`.pref-card`, `.prefs-pane-flow .prefs-row`, `.plug-consent`, `.mats-list`) | Groups inside the glass shell; they never blur, and they have no edge |
| Tiny labels on the model (`.snap-tag`, `.areabox`, `.sketch-dim`, viewport readouts) | Labels, not panels |
| Everything under `html.no-glass-blur` | A performance fallback, not a design ([4.5](#45-blur-off-and-potato-mode)) |

One surface is glass but docked, not floating: `#renderdock`, the Render
mode settings. `#main` is `grid-template-columns: minmax(0, 1fr) auto`
(`_layout.scss`), so the dock is a grid column that narrows the stage. It keeps
a `var(--s-3)` margin on the top, right and bottom and none against the stage,
blurs the page behind it rather than the model, and under 560px stacks below
the stage. It is the only docked panel. Do not dock a new one: a new panel
floats in `#float-layer` or wears `.measure-panel`.

### The failure this spec exists to prevent

![Anti reference: the first Home screen, flat opaque panels and tiles](design/dont-flat-home.png)

The first Home screen covered the stage with opaque `var(--panel)`, used
`var(--raised)` tiles with `1px solid var(--line)` and `--r-md` corners, a
one off `box-shadow: -8px 0 24px rgba(0, 0, 0, 0.3)`, no blur, no squircle and
hex fallbacks from an old palette. It followed the flat base rules of its
sibling partials, which are not what the user sees: `_glass.scss` repaints a
fixed list of selectors, and Home was not on it. **If your screen would not
look like the same product as the workspace shot above, it is wrong.**

## 2. Tokens

All tokens live on `:root` in `src/styles/_tokens.scss`. There are no SCSS
variables for design values, and `src/styles/main.scss` explains why.

Rules:

- Write `var(--token)` with **no fallback**. Fallbacks still sit in
  `_modals.scss` (`var(--accent, #ff7a3c)` and `var(--accent-hot, #ff9a5c)`,
  from an old orange palette), `_home.scss`, `_browser.scss`, `_layout.scss`,
  `_targetedit.scss` and several overlay components (`LiveSessionPill.vue`,
  `PropertiesPanel.vue`, `InterferencePanel.vue` and others). They never fire,
  and copying one spreads a value the theme cannot change.
- Never write a raw colour (`#hex`, `rgb()`, `hsl()`, a named colour) in a
  component or partial. Derive tints with `color-mix` on a token:
  `color-mix(in srgb, var(--accent) 16%, transparent)`. The few literals that
  remain in `_glass.scss` are the scrims and the amber of `.toast-warning`
  ([2.3](#23-the-fills-of-the-glass)).
- Never invent a token name. These are read in the code but defined nowhere and
  must not spread: `--danger` (use `--error`), `--fg` (`--text`), `--muted`
  (`--text-mute`), `--border` (`--line`), `--bg-panel` and `--panel-1`
  (`--panel`), `--panel-3` (`--panel-2`), `--fg-dim` (`--text-dim`),
  `--bg-sunken`. A new token goes in `_tokens.scss`, and a new colour token also
  in `PALETTE_TOKENS` in `src/ui/theme.ts`.

### 2.1 Colours by role (FundaCAD Noir values)

Surfaces, back to front:

| Token | Noir | Use |
|---|---|---|
| `--bg` | `#050409` | Page background |
| `--viewport-bg` | `#0b0912` | The scene background, read by the Three side (`viewport/themeColors.ts`), not by CSS |
| `--panel` | `#1b1826` | Base of every glass fill (through `--float-bg`), the title bar, the no blur fill |
| `--panel-2` | `#272233` | Flat inner controls, native `option` background |
| `--raised` | `#322c42` | Hover fill of flat rows and icon buttons |
| `--raised-2` | `#3d3651` | Off track of `.ft-switch` |

Lines (layout dividers only, see [Depth without lines](#depth-without-lines)):

| Token | Noir | Use |
|---|---|---|
| `--line` | `#322c42` | Hairline dividers between the parts of a dialog, menu or dock (`.modal-head`, `.modal-foot`, `.menu-sep`, `.ctx-sep`, `.rd-tabs`, `.prefs-nav`) and the title bar edge |
| `--line-strong` | `#5c5470` | The scrollbar thumb. Decorative only (2.45:1 on `--panel`) |

Text:

| Token | Noir | Use |
|---|---|---|
| `--text` | `#f6f0e4` | Primary text, titles, values |
| `--text-dim` | `#aaa1b5` | Secondary labels, idle icons, a dimmed tree row |
| `--text-mute` | `#7d7590` | Hints, caps labels, idle close glyphs, metadata, a hidden tree row. Fails AA on panels in Noir, never for text a user needs |

Accent (also what selected edges, dimensions and manipulator handles are drawn in):

| Token | Noir | Use |
|---|---|---|
| `--accent` | `#51d6a8` | Primary button fill, the focus outline, the tab underline, the `.rd-tab` bar, a checked checkbox, switch on |
| `--accent-hot` | `#7ee7c2` | Text and icons of an active, selected or hovered row; primary hover |
| `--accent-tint` | `rgba(81, 214, 168, 0.14)` | Light selected fill (`.prefs-nav-btn.active`) |
| `--accent-tint-2` | `rgba(81, 214, 168, 0.24)` | Stronger selected fill (`.seg-btn.active`, `.rd-chip.active`, `.pref-seg .on`) |
| `--accent-wash` | `color-mix(in srgb, var(--accent) 20%, transparent)` | The on state of a tile, laid over the tile fill as a gradient layer (`.rail-btn.active .rail-tile`, `.icon-btn.active`) |
| `--on-accent` | `#00140d` | Text on an accent fill |
| `--accent-blue` | `var(--accent)` | Legacy alias kept for old plugins and palettes (`theme.ts` writes it with the accent). Never read it in new code |

Fills of depth ([3](#3-surfaces-and-elevation) puts them to use):

| Token | Noir | Use |
|---|---|---|
| `--float-bg` | `color-mix(in srgb, var(--panel) 72%, transparent)` | A card over the model |
| `--float-bg-solid` | `color-mix(in srgb, var(--panel) 92%, transparent)` | Menus, popovers, dialogs, anything text heavy |
| `--float-tile-bg` | `color-mix(in srgb, #fff 5%, var(--float-bg))` | A tile on a card: rail tiles, Home cards, wells |
| `--float-chip-bg` | `color-mix(in srgb, #fff 10%, var(--float-bg))` | A chip, pill, button or key cap on a card |
| `--field-bg` | `rgba(0, 0, 0, 0.3)` | A text field or select, sunk below the surface it sits on |
| `--check-off` | `rgba(0, 0, 0, 0.45)` | An empty checkbox, a deeper well than a field so the small box still reads |
| `--hover-wash` | `rgba(255, 255, 255, 0.07)` | A hover, laid over the fill of the control |
| `--float-shadow` | `0 2px 5px rgba(0, 0, 0, 0.32), 0 16px 34px -14px rgba(0, 0, 0, 0.62)` | The one shadow of all glass |

Retired tokens: `--float-line`, `--glass-sheen`, `--glass-inset`,
`--glass-rim` and `--accent-glow`. They stay defined and transparent so an old
plugin stylesheet that still reads one draws nothing. No core rule reads them,
the guard fails if one does, and a new rule never should. An uploaded palette
that sets `--accent-glow` still loads, the token is simply ignored.

Status:

| Token | Noir | Use |
|---|---|---|
| `--ok` | `#17c99a` | A step deeper than the accent, so an ok mark and a selection differ |
| `--warn` | `#ffab2e` | Warnings, amber History steps, `.perf-warn` |
| `--error` | `#ff5c5c` | Errors, destructive items, failed steps |
| `--error-tint` | `rgba(255, 92, 92, 0.14)` | Error backgrounds |
| `--pick-line` | `#b48cff` | The second pick colour, apart from the accent: the Mirror line or plane, in the view and on its panel field |

There is no info, success tint, warn tint or disabled token. Derive them:

| Need | Write |
|---|---|
| Hover of a control | `linear-gradient(var(--hover-wash), var(--hover-wash)), <the control's own fill>` |
| Menu or list row hover, selected row | `color-mix(in srgb, var(--accent) 16%, transparent)`, text `--accent-hot`, no ring |
| Tile on | `linear-gradient(var(--accent-wash), var(--accent-wash)), var(--float-tile-bg)` |
| Field focus | `outline: 1px solid var(--accent)`, no ring and no border change |
| Warn or error surface | `color-mix(in srgb, var(--warn) 9%, var(--float-bg-solid))` (`.perf-pop`), `color-mix(in srgb, var(--error) 22%, var(--float-bg-solid))` (`.toast-error`) |
| Warn or error small text on glass or a panel | `color-mix(in srgb, var(--warn) 60%, var(--text))` or the same with `--error` (`.sketch-dim.conflict`, `.rel-row.over .rel-sym`); the bare `--warn` and `--error` fall under AA in Solarized Light, keep them for the border |

### 2.2 Shape and motion tokens

These are never themed. They are covered in their own sections:
[glass](#4-the-glass-recipe), [type](#5-typography),
[spacing and radii](#6-spacing-radii-sizes-touch-and-breakpoints),
[motion](#8-motion).

### 2.3 The fills of the glass

A control on glass is not drawn in `--panel` tones. It takes the fill of its
level, so the surface under it still shows through the translucent card. A
control gets its fill by being on a selector list in `_glass.scss`:

| Fill | Where |
|---|---|
| `--float-tile-bg` | Rail tiles, Home cards, the wells of Preferences |
| `--float-chip-bg` | `.btn`, `.pop-wide`, `.palette-btn`, `.choice-btn`, `.section-chip-btn`, `.key-chip kbd`, `.tl-btn`, pills and chips on the model |
| `--field-bg` | `.sm-input`, `.sm-select`, `.param-row input`, Home search and sort, the Items filter |
| `--hover-wash` | Laid over the fill of any of the above on hover |
| `--accent-wash` | Laid over `--float-tile-bg` for a tile that is on |
| `rgba(5, 4, 9, 0.35)` | The scrim of `.modal-overlay`, `.cmdk-backdrop`, `.choice-backdrop` |

To give a new control this look, reuse `.btn`, `.sm-input`, `.opt-row` or
`.float-toggle`, or add its selector to the matching list in `_glass.scss`.
Never write a new fill with `rgba()` or a hex: the guard rejects a new literal
anywhere. The light theme redefines these tokens
([10](#10-light-and-dark-themes)), so a control that uses them follows.

## 3. Surfaces and elevation

| Level | What | Fill | Shadow | Radius |
|---|---|---|---|---|
| 0 | The scene | `--viewport-bg` under the model, `--bg` under the canvas | none | none |
| 1 | Glass over the model: cards, view control groups, the sketch palette, the tool prompt | `--float-bg` (72%) | `--float-shadow` | float |
| 1 tile | Rail tiles, Home cards | `--float-tile-bg` | `--float-shadow` | tile |
| 1 chip | Rail pills, dimension fields, the section and updating chips, viewport readouts | `--float-chip-bg` | `--float-shadow` | chip |
| 2 | Solid glass for menus and text: popovers, context and title bar menus, the chooser, toasts, the console, the command palette, measure panels, and the docked Render dock ([1](#1-principles)) | `--float-bg-solid` (92%) | `--float-shadow` | float or tile |
| 3 | A dialog on a scrim: `.modal-panel` | `--float-bg-solid` | `--shadow-3` | float |
| Chrome | `#titlebar` | `var(--panel)`, opaque | none | none |
| Field | Text fields and selects | `--field-bg`, a sunken well | none | chip |
| Well | Groups inside a dialog | `--float-tile-bg` (`.pref-card`, `.prefs-pane-flow .prefs-row`), `--panel-2` (`.plug-consent`), none (`.mats-list`) | none | 8px, 8px, 6px, `--r-sm` |

Shadows:

- `--float-shadow` is a tight contact shadow under a soft drop,
  `0 2px 5px rgba(0, 0, 0, 0.32), 0 16px 34px -14px rgba(0, 0, 0, 0.62)`. It is
  the one shadow of all glass, and with the fill the only thing that lifts a
  surface off the model.
- `--shadow-3` is used by glass in exactly one place, `.modal-panel`, because a
  soft black shadow has no contrast on the dark scrim. `--shadow-1`,
  `--shadow-2`, `--shadow-3` and `--shadow-pill` are the older hard offset set
  in Noir. Never put them on anything over the model: "a hard offset over a lit
  model reads as a hole in the scene" (`_tokens.scss`). On a light theme they
  are soft ([10](#10-light-and-dark-themes)).
- Never write a new `box-shadow` with its own offsets and colours. There is no
  halo, glow or ring shadow in the language. Focus is an outline
  ([11](#11-accessibility)).

### Depth without lines

A rounded surface has no outline. It is told apart from what is behind it by
its fill and its shadow alone.

- **No edge.** A rounded surface (anything with a `border-radius` or
  `corner-shape`) never sets a visible `border`, `border-color`, `outline` or a
  1px `box-shadow` ring. Where the box needs a border for its geometry, write
  `border: 1px solid transparent`, so every control keeps its size.
- **Levels by fill.** Card, tile and chip each step a touch lighter than the
  one below, and a field steps darker. Use `--float-bg`, `--float-tile-bg`,
  `--float-chip-bg` and `--field-bg`, never a hand mixed white or black.
- **State by fill.** A hover lays `--hover-wash` over the control's own fill. A
  tile that is on lays `--accent-wash` over its fill. A row that is selected
  takes `color-mix(in srgb, var(--accent) 16%, transparent)` and `--accent-hot`
  text. A pressed control scales to 0.94. None of them changes a border or adds
  a ring.
- **Text steps, it does not fade.** A dimmed or hidden tree row steps to
  `--text-dim` or `--text-mute` instead of lowering its opacity.
- **What keeps a line.** Layout dividers, because they split the parts of one
  surface and are not its edge: the title bar's bottom edge, the lines between
  the head, body and foot of a dialog, menu separators, the segment dividers of
  a control, the Render dock tab bar. Signal borders that flag an error or a
  warning (`--error`, `--warn`). Sketch labels on the model, which tell their
  state by an accent, dashed, red or amber border. Drawn glyphs, swatches,
  material balls and screenshots, whose edge is the thing. The guide ring.
- **Focus is the one outline.** Keyboard focus draws a crisp accent outline,
  never a ring shadow ([11](#11-accessibility)).

`tests/ui/designSpec.test.ts` fails on a new outline around a rounded surface,
and on any rule that reads a retired token.

Scrims (`.modal-overlay`, `.cmdk-backdrop`, `.choice-backdrop`, final values in
`_glass.scss`): `background: rgba(5, 4, 9, 0.35)` with
`backdrop-filter: blur(6px) saturate(1.05)`. The workspace stays visible behind
a dialog, blurred and dimmed. A new modal reuses `.modal-overlay` rather than
writing its own scrim.

Stacking tokens: `--z-float` 20, `--z-popover` 200, `--z-menu` 3000,
`--z-modal` 4000, `--z-toast` 5000. Most layers still use literals, so pick
your layer from what is actually on screen:

| z | Layer |
|---|---|
| 20 | `#float-layer` (`--z-float`), the cards and rail |
| 200 | `.float-popover` (`--z-popover`) |
| 1000 | `.modal-overlay` |
| 1500 | `.measure-panel` |
| 2000 | `.menu-popup` |
| 2450 | `.logcon` |
| 2500 | `.toast-stack` |
| 3000 | `.context-menu` |
| 4000 | `.choice-backdrop` |
| 4001 | `.select-pop`, `calc(var(--z-modal) + 1)`, so a picker clears its dialog |
| 5000 | `.cmdk-backdrop` |

New layers use a `--z-*` token or `calc()` on one, never a new literal.

## 4. The glass recipe

There is no SCSS mixin. The glass is applied by **allowlist**: `_glass.scss`
loads after every partial that lays a surface out (see `main.scss`) and repaints
the selectors it names. A selector that is not on its lists renders with its
flat base rules. That is the whole mechanism, and the reason Home came out flat.

### 4.1 The declarations

Group A, over the model (`_glass.scss`, first rule):

```scss
corner-shape: squircle;
background: var(--float-bg);
-webkit-backdrop-filter: var(--float-blur);
        backdrop-filter: var(--float-blur);
border: 1px solid transparent;
box-shadow: var(--float-shadow);
```

The transparent border only keeps the box size. `.float-popover`,
`.context-menu`, `.choice-card` and `.dim-unit-menu` take the solid fill,
`var(--float-bg-solid)`. Tiles (`.rail-tile`, Home cards) take
`--float-tile-bg`, and chips (`.rail-pill`, `.dim-field`, `.dim-btn`,
`.section-chip`, `.updating-chip` and the other readouts) take
`--float-chip-bg`. Group B (dialogs, menus, toasts, docks) is the same recipe
with the solid fill throughout.

The tokens, with their values:

| Token | Value | Role |
|---|---|---|
| `--float-bg` | `color-mix(in srgb, var(--panel) 72%, transparent)` | Translucent fill over the model |
| `--float-bg-solid` | `color-mix(in srgb, var(--panel) 92%, transparent)` | Fill for menus, popovers, dialogs, anything text heavy |
| `--float-tile-bg` | `color-mix(in srgb, #fff 5%, var(--float-bg))` | A tile, one step above the card |
| `--float-chip-bg` | `color-mix(in srgb, #fff 10%, var(--float-bg))` | A chip, two steps above the card |
| `--float-blur` | `blur(24px) saturate(1.08)` | The backdrop filter |
| `--float-shadow` | see [3](#3-surfaces-and-elevation) | Depth |
| `--float-radius` | 16px (26px with squircle) | Cards, groups, popovers, dialogs, docks |
| `--float-tile-radius` | 11px (17px with squircle) | Rail tiles, context menus, title bar menus, toasts, `.rd-tile`, card close buttons |
| `--float-chip-radius` | 8px (12px with squircle) | Pills, rows, inputs and buttons inside glass |
| `--float-gap` | 12px | Distance from the stage edges and between cards |

The radii grow under `@supports (corner-shape: squircle)` because a squircle
needs a larger radius to look the same size. Always pair a float radius with
`corner-shape: squircle`, never a literal radius.

### 4.2 Use an existing glass class first

| Class | Component | Use it for |
|---|---|---|
| `.float-card` | Items (`#browser`), History (`#timeline`), Fillet members | A card over the model, with `.float-card-head`, `.float-card-title`, `.float-card-close`, `.float-card-more`, `.float-card-body`, `.float-card-foot` |
| `.float-group` | `ViewportControls.vue` | A column or row of `.icon-btn` |
| `.float-popover` | `components/ui/Popover.vue` | Anything that opens from a button: options, pickers, `Select.vue`'s list |
| `.context-menu` | `ContextMenuHost.vue` | Right click menus |
| `.measure-panel` | `components/overlays/FloatingPanel.vue` | A small tool or readout panel. Worn by `MeasureReadout.vue`, `PropertiesPanel.vue`, `InterferencePanel.vue`, `OverhangPanel.vue`, `StressPanel.vue`, `MirrorToolPanel.vue` and `ParamsDialog.vue`; check these before you build a new one. Contents and API in [7.13](#713-tool-and-readout-panels-measure-panel) |
| `.modal-panel` | `components/overlays/ModalFrame.vue` | A dialog, on `.modal-overlay` |
| `.choice-card` | `ModalHost.vue` chooser | A short question with a few answers |
| `.cmdk-card` | `CommandPalette.vue` | The command palette |
| `.float-card-close` | any glass surface | A 28 by 28 icon button for close, copy or more, inside or outside a card ([7.1](#71-floating-card-float-card)) |
| `.menu-popup` | `MenuBar.vue` | Title bar menus |
| `.toast` | `ToastStack.vue` through `ui/toast.ts` | Short confirmations |
| `.rail-tile`, `.rail-pill` | `components/ui/RailButton.vue` | Tool buttons on the rail |
| `#viewport .prompt` | `PromptBanner.vue` | The tool prompt pill |
| `.section-chip` | `SectionChip.vue`, in `#viewport .vp-top` | A state that stays on over the model, with its word buttons |
| `.updating-chip` | `UpdatingChip.vue`, in `#viewport .vp-top` | A passing state over the model that takes no clicks, like a slow rebuild |

### 4.3 A new surface

1. Lay it out in its own partial in `src/styles/` (or the partial it belongs
   to), loaded before `glass` in `main.scss`. Give it no background, border,
   shadow or radius there.
2. Add its selector to the lists in `_glass.scss`: group A (over the model) or
   group B (dialog, menu, toast, dock, text heavy), the fill list of its level
   (card, tile or chip) and the matching radius list.
3. Add its controls to the control lists (squircle plus chip radius) and its
   rows to the hover and selected lists. Fields go on the `--field-bg` list.
4. Check it with blur off ([4.5](#45-blur-off-and-potato-mode)) and in the light
   theme ([10](#10-light-and-dark-themes)).

Do not restate the recipe inline in a component. `SurfaceNodeEditor.vue` does,
and is the one legacy exception.

### 4.4 What glass floats over, and what breaks it

`App.vue` lays out `#titlebar`, then `#main` holding `#stage` (relative), which
holds `#viewport` (absolute, `inset: 0`, the canvas) and `#float-layer`
(absolute, `inset: 0`, `z-index: var(--z-float)`, `pointer-events: none`) with
`.float-left` and `.float-right`. Cards set `pointer-events: auto` again. The
Render dock is a second grid column of `#main`, beside the stage, and blurs
the page behind it. Overlays (`.measure-panel`, dialogs, menus, toasts) are
teleported to `<body>` and are `position: fixed`.

An ancestor with `filter`, `backdrop-filter`, `opacity` below 1, `mask`,
`clip-path`, `mix-blend-mode` or `will-change` becomes the backdrop root, and
glass inside it blurs nothing. So:

- Keep `#float-layer`, `.float-left` and `.float-right` free of anything but
  layout and pointer events.
- A full screen surface (such as Home) paints its backdrop on a `::before`
  layer (`position: absolute; inset: 0; z-index: -1; pointer-events: none`),
  never on itself, so it is not the backdrop root of its own cards. Its
  backdrop may be a scrim or an opaque tone of the theme; its panels and cards
  are still glass. **Prescribed, no code does this yet**: on `dev`, Home paints
  `.home { background: var(--panel) }` itself ([14](#14-known-debt-do-not-copy)).
- Animate opacity on the glass element itself (`pop-in`, `glass-in` do), never
  on its parent.
- `.float-card` uses `overflow: hidden` to clip to the squircle, so anything that
  should spill out of a card belongs on an unclipped element.

### 4.5 Blur off and potato mode

`src/ui/glassBlur.ts` puts `no-glass-blur` on `<html>` when potato mode is on
(Preferences, Viewport) or the WebGL renderer is software (SwiftShader,
llvmpipe, Microsoft Basic Render). A blurred panel over a WebGL canvas re-blurs
on every repaint, which a CPU renderer cannot afford. `_glass.scss` then sets:

```scss
html.no-glass-blur {
  --float-blur: none;
  --float-bg: var(--panel);
  --float-bg-solid: var(--panel);
}
html.no-glass-blur *, html.no-glass-blur *::before, html.no-glass-blur *::after {
  -webkit-backdrop-filter: none !important;
          backdrop-filter: none !important;
}
```

The fills go opaque, while shape, shadow, spacing and accent use stay. This is
the only legitimate opaque glass, and it must still look finished:

![Blur off: opaque fills, same shapes and shadows](design/workspace-blur-off.png)

To support it, do nothing special: use `--float-bg`, `--float-bg-solid` and
`--float-blur`. A hand written translucent `rgba()` fill would show the model
unblurred once blur is off. A backdrop that only works because of its blur
(a scrim over busy content) needs an opaque value under
`html.no-glass-blur`. `tests/ui/glassBlur.spec.ts` covers the switch.

## 5. Typography

Fonts (self hosted through Fontsource in `src/main.ts`, only the weights the
chrome uses):

| Token | Family | Loaded weights | Use |
|---|---|---|---|
| `--ui` | `"Space Grotesk", "Inter", system-ui, sans-serif` | 400, 500, 700 | Everything |
| `--mono` | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | 400, 500 | Key caps, shortcut hints, branch names, the grid size, console text |

Weights 550, 600 and 650 have no face of their own and render as 700. The UI
has three visual weights: 400 body, 500 controls, 600/700 titles and caps
labels. New mono text uses 400 or 500. `.key-chip kbd`, `.grid-btn`,
`.versions-branch-name` and `.prompt-key` use mono 600, which has no face and
renders as a synthetic bold; do not copy it.

The base is `font-size: 13px` with `font-feature-settings: "cv11", "ss01", "tnum"`
on `html, body`, so numerals are tabular everywhere. Numbers in fields use the
UI font, not mono. All sizes are px, there is no rem.

| Size | Role | Examples |
|---|---|---|
| 9px | On canvas micro text, badge digits | `.dim-field`, `.icon-btn-badge` |
| 10px | Caps micro labels, counts | `.palette-title`, `.panel-title`, `.context-tab`, `.tree-count` |
| 10.5px | Secondary micro | `.rail-sub`, `.rd-head`, `.sm-section` |
| 11px | Small secondary text, default caps label | `.rail-group-name`, `.cmdk-group`, `.cmdk-key`, `.opt-hint`, `.sm-input` |
| 11.5px | State and note text | `.ft-state`, `.param-note`, `.toast-action` |
| 12px | Controls and body in panels | `button`, `.btn`, `.param-row label`, `.pop-note`, `.prompt` |
| 12.5px | Rows and labels of the floating shell | `.rail-label`, `.opt-row`, `.ctx-item`, `.tree-folder`, `.float-tab`, `.toast` |
| 13px | Card titles | `.float-card-title` (600) |
| 14px | Dialog title | `.modal-head h2` (600, letter-spacing 0.3px) |
| 15px | Command palette input | `.cmdk-input` |

There is no display type. Nothing in the chrome is above 15px except two
Preferences headings at 18px.

Caps labels are small, bold, uppercase and tracked, in `--text-mute` or
`--text-dim`. The existing ones use px tracking: `.panel-title` 10px/700, 1px,
`--text-mute`; `.palette-title` 1.2px, `#context-tab` 0.8px and
`.home-nav-section` 0.4px, all `--text-dim`. Match the sibling label when you
extend a surface. A label in a new surface is
`font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-mute)`
(0.06em for a section head), and `--text-dim` only where it must be read, not
just scanned. Titles and row labels are sentence case and untracked.

Line height is mostly left to the default. Paragraph text inside panels uses
1.45 (`.pop-note`), rail labels 1.2 to 1.25, icon buttons and chips 1.

## 6. Spacing, radii, sizes, touch and breakpoints

### 6.1 Spacing

| Token | Value | Typical use |
|---|---|---|
| `--s-0` | 2px | Tight gaps in lists |
| `--s-1` | 4px | Card body top padding, menu popup padding |
| `--s-2` | 8px | The most used: row padding, gaps |
| `--s-3` | 12px | Popover padding, toast gap, button vertical padding |
| `--s-4` | 16px | Button horizontal padding, pref card padding |
| `--s-5` | 20px | Dialog head, body and foot padding |
| `--s-6` | 28px | Shortcut sheet padding |
| `--s-7` | 36px | The widest gap, `.sm-grid` columns, menu item label to shortcut |

The shell still carries a few off scale px values (card head `10px 10px 6px 14px`,
rail gap 6px, `.opt-row` `7px var(--s-3)`). Match them when you extend those
components, use tokens for anything new.

### 6.2 Radii

Glass and everything inside it: `--float-radius`, `--float-tile-radius`,
`--float-chip-radius` with `corner-shape: squircle` ([4.1](#41-the-declarations)).
An inner radius is the outer radius minus the inset, as `.icon-btn` does with
`calc(var(--float-radius) - 4px)`.

`--r-xs` 2px, `--r-sm` 3px, `--r-md` 4px, `--r-lg` 5px are the older square
radii of flat controls (the title bar, panel fields). `--r-pill` 999px is for
switch tracks, the scrollbar thumb and the prompt. Do not put `--r-*` on a
floating surface. Dividers are always 1px.

Controls inside glass that still bend this, so do not copy them: the History
transport `.tl-btn` (`--r-sm`), `.float-toggle` (6px, no squircle), `.pref-seg`
(6px), `.rd-search` (`--r-md`) and `.key-chip kbd` (6px, squircle).

### 6.3 Sizes

| Element | Size |
|---|---|
| Title bar | 36px tall, logo 22px, `.tb-btn` 26 by 24 |
| Rail tile | `--rail-tile` 40px, 32px in `.tool-rail.compact`; rail pill min height 28px |
| `.icon-btn` | 40 by 40 inside a `.float-group` with 3px padding |
| Card close and more | 28 by 28 |
| History row | 34px |
| Default button | padding `var(--s-3) var(--s-4)` at 12px, about 33px tall |
| `.ft-switch` | 36 by 20, knob 14px |
| Card widths | Items 264px, History 288px, sketch palette 240px, Render dock 300px |
| Popovers | min width 220px, max height `calc(100vh - 16px)` |
| Dialog | `min(720px, 92vw)`, max height 88vh; Preferences `min(960px, 94vw)` |
| Toast | max width 560px |

### 6.4 Icons

Use `<Icon name="…" :size="N" />` (`components/shell/Icon.vue`), default 16, or
`IconButton.vue` (default 20). Icons are SVG files in `src/assets/icons/forge/`
(outline pack) and `src/assets/icons/anvil/` (solid pack, falls back to forge):
24 by 24 viewBox, about 20 by 20 live area, `stroke-width` 1.4, round caps and
joins, no fill, no hard colours (`tests/ui/iconFiles.test.ts`). Colour comes
from `currentColor`: idle `--text-dim` or `--text-mute`, hover `--text`, active
`--accent-hot`. Never use a Unicode glyph or emoji as an icon.

Names are the file names, in camelCase. Look in the folder before you pick
one; a name that is not there renders nothing. The common actions:

| Action | Name |
|---|---|
| Close, dismiss | `close` |
| Copy, copied | `copy`, then `check` |
| More options | `more` |
| Add, remove | `plus`, `minus` |
| Search | `search` |
| Show, hide | `visible`, `hidden` |
| Expand, collapse | `caretRight`, `caretDown` |
| Undo, redo | `undo`, `redo` |
| Warning | `warning` |
| Save, open, export, import | `save`, `open`, `export`, `import` |

There is no `trash`, `settings`, `info`, `error`, `eye` or `chevron` icon.

| Size | Use |
|---|---|
| 12 to 15 | Inline in rows, close crosses, title bar buttons (15) |
| 16 | Default, row icons |
| 18 | History node glyph, rail group caret |
| 20 | View control icon buttons, rail tiles |
| 28, 36 | Empty states |

### 6.5 Touch targets

`src/input/pointerKind.ts` sets `<html data-pointer="mouse|pen|touch">` from the
last pointer event; there is no `pointer: coarse` media query. A touch laptop
flips between kinds, so **nothing keyed on `data-pointer="touch"` may change
layout**. Keep the compact visual size and grow the hit area with a transparent
pseudo element on a positioned host, sized to reach about 40px and held back
where a neighbour or a scroller edge is closer (`_touch.scss`):

```scss
:root[data-pointer="touch"] .your-btn { position: relative; }
:root[data-pointer="touch"] .your-btn::before { content: ""; position: absolute; inset: -8px -6px; }
```

The floor is 36px for anything over the model. A hover that moves things
(`translateY`) is cancelled under touch; a hover only affordance needs a
`@media (hover: none)` fallback that shows it.

### 6.6 Breakpoints

| Where | Trigger | What changes |
|---|---|---|
| Narrow stage | `#stage.narrow`, stage under `STAGE_NARROW_PX` 820 (`ui/layoutBreakpoints.ts`, measured on the stage, not the window) | Items and History become drawers over the model, one at a time, still glass |
| Compact title bar | `@media (max-width: 760px)` | Tighter title bar, segment labels hidden |
| Phone | `@media (max-width: 560px)` | Brand, context tab and doc name hidden, rail pills hidden, the Render dock stacks below |
| Preferences | `@media (max-width: 640px)` | One column |
| Short stage | `.tool-rail.compact` (JS, by height) | 32px tiles |

Nothing changes above the breakpoints. There are no container queries.

## 7. Component recipes

Every interactive element needs all five states: hover, active (pressed),
focus visible, disabled and selected (or on), where they apply. If a row below
says "none", that is a gap in the code, not permission.

### 7.1 Floating card (`.float-card`)

Glass group A, `--float-radius`, `overflow: hidden`.

| Part | Recipe |
|---|---|
| `.float-card-head` | flex, gap `--s-2`, padding `10px 10px 6px 14px` |
| `.float-card-title` | 13px, 600, `--text` |
| `.float-card-close`, `.float-card-more` | The small icon button, see below |
| `.float-card-body` | padding `var(--s-1) var(--s-2) var(--s-2)`, scrolls, `overscroll-behavior: contain` |
| `.float-card-foot` | padding `4px 6px`, no divider line |
| Section label (`.panel-title`) | 10px, 700, uppercase, letter-spacing 1px, `--text-mute` |

The small icon button, `.float-card-close` (and `.float-card-more` for a menu
button), is not tied to a card. Its base is in `_float.scss`, its squircle in
the control list of `_glass.scss` and its touch hit area in `_touch.scss`, so
it works in any glass surface: a card head, a `.measure-panel`, a popover. Use
it for any 28px icon action (close, copy, more) instead of a new class, which
would miss the squircle and touch lists.

| State | Recipe |
|---|---|
| Idle | 28 by 28, no fill or border, `--float-tile-radius`, squircle, `--text-mute`, icon 12 to 14 |
| Hover `:hover:not(:disabled)` | fill `--raised`, colour `--text` |
| Pressed `:active:not(:disabled)` | `transform: scale(0.94)` |
| Disabled `:disabled` | opacity 0.45, `cursor: default`, no hover |
| Focus visible | the shared outline |
| Transition | background, color, transform, each `var(--t-fast) var(--ease)` |
| Touch | `inset: -6px` hit area (`_touch.scss`) |
| Markup | `title` and `aria-label` with the same text, `<Icon>` inside |

### 7.2 Icon button (`.icon-btn`, `IconButton.vue`)

Inside a `.float-group` (glass A, padding 3px, gap 2px).

| State | Recipe |
|---|---|
| Idle | 40 by 40, no fill or border, radius `calc(var(--float-radius) - 4px)`, squircle, `--text-dim` |
| Hover | fill `--raised`, colour `--text` |
| Active (on) `.active`, `aria-pressed` | `linear-gradient(var(--accent-wash), var(--accent-wash)), var(--float-tile-bg)`, colour `--accent-hot`, no shadow |
| Disabled `.disabled` plus `aria-disabled` | opacity 0.38, no fill, `cursor: default` |
| Focus visible | the shared outline |
| Warn `.perf-warn` | colour `--warn`, hover and active fill warn 16% |

### 7.3 Rail tile (`.rail-btn`, `.rail-tile`, `.rail-pill`)

`RailButton.vue`. The tile is glass A at `--rail-tile`, `--float-tile-radius`,
filled with `--float-tile-bg`. The pill (label) is glass A, `--float-chip-radius`,
filled with `--float-chip-bg`, padding `3px 9px`, label `.rail-label`
12.5px/600, sub label `.rail-sub` 10.5px `--text-mute`.

| State | Recipe |
|---|---|
| Hover | tile fill `linear-gradient(var(--hover-wash), var(--hover-wash)), var(--float-tile-bg)`, `translateY(-1px)`; the pill does not change |
| Pressed | `transform: scale(0.94)` |
| Selected `.active`, held `.holding` | tile fill `linear-gradient(var(--accent-wash), var(--accent-wash)), var(--float-tile-bg)`, icon `--accent-hot`, label `--accent-hot`; no ring, no halo |
| Disabled `.disabled` | opacity 0.45 |
| Focus visible | the shared outline, on the `.rail-btn` button |
| Transition | transform, background, border-color, box-shadow, color, each `var(--t-fast) var(--ease)` |

### 7.4 Buttons

The fills below are the tokens of [2.3](#23-the-fills-of-the-glass): a button
gets them by wearing the class, never by restating them. A button has no visible
border; its `1px solid transparent` only keeps its size.

| Class | Idle | Hover (`:hover:not(:disabled)`) | Focus visible | Other states |
|---|---|---|---|---|
| `.btn` (secondary, in glass) | squircle, chip radius, fill `--float-chip-bg`, no shadow, padding `var(--s-3) var(--s-4)`, 12px | `--hover-wash` over the fill | the shared outline | disabled: give it opacity 0.45 and `cursor: default`, the base has none |
| `.btn-primary` (always with `.btn`) | fill `--accent`, text `--on-accent`, 600, no shadow | fill `--accent-hot` | as `.btn` | One primary per dialog |
| `.pop-wide` (full width popover action), `.palette-btn` | as `.btn`, full width, gap `--s-2`, margin top `--s-2` | as `.btn` | as `.btn` | `.ghost`: no fill; disabled opacity 0.45 (`.versions-save .pop-wide:disabled`) |
| `.choice-btn` | min width 64px, fill `--float-chip-bg`, chip radius, caption `small` 10px `--text-mute` | fill accent 16% mixed into the chip fill | the shared outline | `.choice-primary`: accent fill, `--on-accent`; disabled opacity 0.4 |
| `.modal-close` | transparent, `--text-dim`, close icon 15px, `aria-label` and `title` "Close" | fill `--raised`, colour `--text` | the shared outline | |
| `.tb-btn` (title bar) | 26 by 24, `--panel-2`, `--text-dim` | `--raised`, `--text` | the shared outline | disabled opacity 0.3 |
| `.tl-btn` (History transport) | 26 by 26, `--float-chip-bg`, `--r-sm`, `--text-dim` | `--raised`, `--text` | the shared outline | disabled opacity 0.3 |

The bare `button` rule (`_layout.scss`) has **no disabled state**. Any new
button defines `:disabled` itself (opacity 0.45, `cursor: default`, no hover).
Its base hover border is the off palette `#3d4452`; do not copy it.

### 7.5 Inputs and selects

A field is a sunken well: `--field-bg`, darker than the surface it sits on, with
no edge. Focus draws a 1px accent outline.

| Class | Idle | Focus | Error or other |
|---|---|---|---|
| `.sm-input` (dialogs, the dock) | squircle, chip radius, fill `--field-bg`, padding `var(--s-2) var(--s-3)`, 11px | `outline: 1px solid var(--accent)`, no ring | |
| `.sm-select.select-trigger` (`Select.vue`, preferred) | as `.sm-input` plus a drawn caret | as `.sm-input` | `:disabled` opacity 0.5; opens a `.float-popover.select-pop` of `.opt-row`s |
| `.param-row input` (feature values in cards) | `--field-bg`, `--r-sm`, padding `var(--s-2) var(--s-3)`, 12px, tabular | `outline: 1px solid var(--accent)` | `.input-error` and `.param-stale` use hard coded reds and ambers, use `--error` and `--warn` for new work |
| `.dim-field` (on the model) | glass A in `--float-chip-bg`, chip radius | `.typed`: the same fill with the shadow, no border | `.dim-bad`: border `--error`, fill `--error-tint` |

Prefer `Select.vue` over a native `<select>`. Fields keep a visible focus;
never `outline: none` without a replacement.

### 7.6 Checkboxes, switches and sliders

A setting is toggled with the themed checkbox. A switch is for a live toggle in
a tool panel or popover, where the change shows in the model as you flip it.

- **Settings pages** (Preferences, plugin settings, the plugin list, the
  sketch palette) use the shared `.check` class from `_checkbox.scss`. Never
  put `.ft-switch`, `.param-switch`, `ToggleRow` or `Toggle` in anything
  Preferences renders, the guard test fails on it.
- **Live toggles** use `.ft-switch` in a `.float-toggle` row (`Toggle.vue`, in
  the view controls) or `.param-switch` through `ToggleRow.vue` (feature
  properties). The Export dialog and the Stress setup and results steps keep
  their switches too.

| Class | Idle | On | Disabled | Focus |
|---|---|---|---|---|
| `.check` (`<span class="check"><input type="checkbox" /><span class="check-box"></span></span>`) | 18 by 18, squircle, radius 6px, fill `--check-off`, no edge; hover `--hover-wash` over the fill. The native input is laid over the box, so ids, labels and change handlers stay native | fill `--accent`, a `--on-accent` tick | box opacity 0.5, `cursor: default` | `outline: 2px solid var(--accent)`, offset 2px |
| `.ft-switch` in a `.float-toggle` row (`Toggle.vue`, `role="switch"`, `aria-checked`) | 36 by 20, track `--raised-2`, pill, knob 14px `--text`; row hover white 4% | `.on`: track `--accent`, knob `translateX(16px)` `--on-accent`, hover `--accent-hot` | row `.disabled` opacity 0.45 | the shared outline |
| `.param-switch` (`ToggleRow.vue` in `FeatureProperties.vue`) | native checkbox over a 30 by 17 `.track`, `--panel-2`, no edge, knob `--text-dim` | track fill `--accent`, knob `translateX(13px)` and `#fff` | track opacity 0.55 | the shared outline round the track, offset 2px |
| `.sm-slider` | native range, `accent-color: var(--accent)` | | | |

`.float-toggle` also shows `.ft-state` ("On" or "Off", 11.5px `--text-mute`),
and the whole row flips the switch.

### 7.7 Tabs and segmented controls

| Class | Idle | Hover | Selected | Focus |
|---|---|---|---|---|
| `.float-tabs > .float-tab` (`Tabs.vue`) | 12.5px, 600, `--text-dim` | `--text` | `.active`: `--text` and a 2px `--accent` underline from 25% to 75% | the shared outline, inset |
| `.pref-seg > button` | 30px tall, 13px, `--text-dim`, fill `--panel`, dividers `--line` | `--raised`, `--text` | `.on`: `--accent-tint-2`, `--accent-hot`, 600 | the shared outline, inset |
| `.seg-btn` (title bar Model or Render) | 11px, `--text-mute` | `--raised`, `--text-dim` | `.active`: `--accent-tint-2`, `--accent-hot` | the shared outline |
| `.rd-tab` (Render dock) | 11.5px, `--text-mute`, 2px transparent bottom border | `--raised`, `--text-dim` | `.active`: `--accent-hot` and an `--accent` bottom bar (a bar, not a fill) | the shared outline |
| `.prefs-nav-btn` | 14px | `--raised` | `.active`: `--accent-tint`, `--accent-hot`, 600 | the shared outline |

A tab that cannot be chosen yet (the Stress panel's Results before a Run) passes `disabled` and a `title` saying why
to `Tabs.vue`: opacity 0.45, `cursor: default`, no hover. Keep it in the bar rather than hiding it, a bar of one tab
reads as a title.

### 7.8 Chips and key caps

| Class | Recipe |
|---|---|
| `.key-chip kbd` (`KeyChip.vue`) | mono 10px, `--text-dim`, padding `0 4px`, radius 6px, fill `--float-chip-bg`, no edge |
| `.rd-chip` | padding `3px var(--s-2)`, `--panel-2`, pill radius, 11px `--text-dim`; hover `--raised`, `--text`; `.active` fill `--accent-tint-2`, `--accent-hot`; disabled opacity 0.55 |
| `#context-tab` | 10px, 700, uppercase, letter-spacing 0.8px, padding `var(--s-1) var(--s-3)`; `.sketch` turns it accent (`--accent-hot`, fill `--accent-tint-2`) |
| `.tree-count` | 10px, 600, `--text-mute`, `--panel-2` pill, hidden when empty |
| `.section-chip` (`SectionChip.vue`) | glass A in `--float-chip-bg`, chip radius, padding `var(--s-1) var(--s-1) var(--s-1) var(--s-3)`, gap `--s-2`, 600 12px `--text`, the section icon in `--accent`, `pop-in`; `role="toolbar"`; shown only while a cut is on, absent otherwise; under 560px, or when the top row is too narrow for them, the words hide and the icon's `title` says them |
| `.section-chip-btn` | chip fill of `.pop-wide`, chip radius, padding `var(--s-1) var(--s-3)`, 600 12px `--text-dim`; hover `--text`; `.active` (Edit while editing, `aria-pressed`) as `.dim-btn.dim-toggle.on`; `.disabled` with `aria-disabled` opacity 0.45, no hover; shared focus outline; a 40px hit area on touch |
| `.updating-chip` (`UpdatingChip.vue`) | glass A in `--float-chip-bg`, chip radius, padding `var(--s-1) var(--s-3)`, gap `--s-2`, 500 11.5px `--text-dim`, `pop-in`, `role="status"`, `pointer-events: none` so a pick goes through to the model; a 10px ring spinner in `--accent` on a 25% accent track; shown while a rebuild other than a tool preview has run past `OUT_OF_DATE_GRACE_MS` (600 ms, `app/staleModel.ts`), gone when it lands, is cancelled or the document is replaced; it never ghosts the model |

### 7.9 Rows

| Class | Idle | Hover | Selected | Disabled |
|---|---|---|---|---|
| `.opt-row` (`ChoiceList.vue`) | padding `7px var(--s-3)`, 12.5px, chip radius | white 5% wash | `.selected`: accent 16% fill, `--accent-hot` | `.disabled` opacity 0.45, no hover |
| `.ctx-item` (context menu) | padding `var(--s-3) var(--s-4)`, 12.5px, chip radius, `.ctx-key` 11px `--text-dim` | accent 16%, `--accent-hot` | | `.disabled` opacity 0.45, `pointer-events: none` |
| `.menu-item` (title bar menu) | padding `var(--s-3) var(--s-4)`, gap `--s-7`, `.menu-shortcut` 11px `--text-mute` | accent 16%, `--accent-hot` | `.menu-check` gutter in `--accent` | `[disabled]` `--text-mute`, `pointer-events: none` |
| `.cmdk-item` | padding `var(--s-3) var(--s-4)`, gap `--s-3`, chip radius | `.active` (pointer or keys): accent 16%, `--accent-hot` | | |
| `.tree-folder`, `.feature-row`, `#timeline .timeline-node` | padding `var(--s-2) var(--s-1)` on `.tree-folder`, `--s-2` on the others (History rows 34px tall), chip radius | `--raised` | `.selected`: accent 16% fill, `--accent-hot` | |

A destructive row (`.ctx-item.danger`, Remove body) is red text only. It
currently uses hard coded reds; new destructive rows use `--error`.

### 7.10 Popovers, menus, dialogs, palette, toasts, prompt

| Surface | Recipe |
|---|---|
| `.float-popover` (`Popover.vue`) | glass solid, `--float-radius`, padding `--s-3`, min width 220px, `z-index: var(--z-popover)`, `glass-in` entrance. Content: `.pop-section` 12.5px/600, `.pop-rule` a 10px gap with no line, `.pop-note` 12px `--text-dim` line height 1.45 |
| `.context-menu` | glass solid, `--float-tile-radius`, padding 5px, separators `.ctx-sep` 1px |
| `.menu-popup` | glass B, `--float-tile-radius`, padding `--s-1`, `pop-in` |
| `.modal-panel` (`ModalFrame.vue`) | glass B with `--shadow-3`, `--float-radius`, on `.modal-overlay`. `.modal-head`, `.modal-body`, `.modal-foot` share padding `--s-5`; head and foot are layout dividers, `1px solid var(--line)`; `h2` 14px/600; foot buttons right aligned, gap `--s-3`, Cancel present, one primary. `role="dialog"`, `aria-modal`, `aria-labelledby` the `h2` |
| `.cmdk-card` | glass B, `--float-radius`, `min(560px, 92vw)`, on `.cmdk-backdrop` at `padding-top: 12vh`, `role="dialog"`, `aria-modal`, `aria-label="Command palette"` |
| `.measure-panel` | see [7.13](#713-tool-and-readout-panels-measure-panel) |
| `.toast` | glass B, `--float-tile-radius`, padding `var(--s-3) var(--s-4)`, 12.5px, bottom centre in `.toast-stack`; `.toast-error` and `.toast-warning` tint the fill; `.toast-action` accent chip |
| `#viewport .prompt` | glass A, pill, padding `var(--s-3) var(--s-5)`, 12px, a 6px accent dot, `prompt-in` entrance |
| `#viewport .vp-top` | the top middle stack of the Section chip and Normal to Sketch: absolute, top `--s-4`, a column with gap `--s-2`, centred in the span the cards leave free (`useClearOfCards.ts` sets `--row-left` and `--row-right`, as PromptBanner does); when that span is too narrow it sets `data-narrow` (the chip drops its words), and when that is not enough it moves the stack down to the first row with room (`--row-top`), `z-index: calc(var(--z-float) - 4)`, pointer events only on its children |

![A context menu and the selection state of the shell](design/context-menu-dark.png)

![Preferences: a glass dialog with inset wells and one primary button](design/preferences-dark.png)

### 7.11 Tooltips

There is no tooltip component. Use the native `title` plus an `aria-label`
with the same text, and put the shortcut in brackets, written as in
[9](#9-voice-and-wording): `title="Reset camera (Shift+Home)"`. A text that
names Ctrl or Alt goes through `fmtKeys()` (`src/input/platform.ts`), which
writes the Command and Option glyphs on a Mac:
`:title="fmtKeys('History (Ctrl+Alt+H)')"`. Do not invent a tooltip popover.
On the model, where a hand cannot spare a hover, show a real element instead.

### 7.12 Plugin UI

A plugin cannot add selectors to `_glass.scss`, so it draws with what the host
gives it. `fundacad/ui` exports `FloatingPanel` (a `.measure-panel`),
`ModalFrame` (a `.modal-panel`), `Icon`, `InlineLabel` and the Render dock rows
`RenderSection`, `RenderSlider`, `RenderSwitch`, `RenderChoices`. Inside them,
use the app's classes (`.btn`, `.btn-primary`, `.sm-input`, `.opt-row`,
`.float-toggle`, the `.measure-*` classes of [7.13](#713-tool-and-readout-panels-measure-panel),
`.float-card-close`) and tokens. Never ship a plugin panel with its own
background, blur or shadow.

### 7.13 Tool and readout panels (`.measure-panel`)

`FloatingPanel.vue` is the shell; it draws the glass and nothing else.

```ts
defineProps<{ open: boolean; closeOnEsc?: boolean; panelClass?: string }>(); // closeOnEsc false, panelClass ""
defineEmits<{ close: [] }>();
```

- `open` is required. The root is a `<Teleport to="body">` holding
  `<div v-if="open" class="measure-panel" :class="panelClass">`, so `class`,
  `title` and other attributes on `<FloatingPanel>` are dropped. Size or move a
  panel only through `panelClass` and a rule for that class in `_modals.scss`
  (`.properties-panel` min width 260px, `.stress-panel` 340px wide and
  scrolling).
- It renders no head, title or close button. The content is yours, from the
  classes below.
- `closeOnEsc` adds a capture phase `keydown` listener on `window` that emits
  `close` and does not stop the event, so Escape also reaches the global
  handler (clearing the selection, leaving the tool). See
  [11](#11-accessibility) for when to leave it off.
- Placement is fixed for every panel: `position: fixed; top: 128px; right: 268px;
  z-index: 1500`, outside `#float-layer`, so two panels open at once overlap.
  The shell is `min-width: 180px`, `padding: var(--s-4)`, `font-size: 12px`.

| Class | Recipe |
|---|---|
| `.measure-title` | 600, `--accent-hot`, `margin-bottom: var(--s-2)`. The panel's name, one per panel |
| `.measure-row` | flex, `justify-content: space-between`, gap `--s-5`, padding `var(--s-0) 0`. A label and a value |
| `.measure-k` | the label, `--text-mute` |
| `.measure-v` | the value, `font-variant-numeric: tabular-nums` |
| `.measure-divider` | 1px `--line`, margin `var(--s-2) 0` |
| `.measure-select`, `.measure-number` | small inline fields; `.measure-number` 60px, right aligned |
| `.measure-hint` | 10px, `--text-mute`, `margin-top: var(--s-2)`. The last line, saying how the panel closes ("Esc to close", "Esc to exit", "Overhang again to close") |
| Actions | `.btn`, or `.btn.btn-primary` for the one main action; a 28px icon action is `.float-card-close` ([7.1](#71-floating-card-float-card)) |

Do not add a head with its own padding: the shell padding is the inset, and a
second padded head doubles it. A minimal readout:

```vue
<FloatingPanel :open="!!panels.measure">
  <div class="measure-title">Measure</div>
  <div v-for="(r, i) in rows" :key="i" class="measure-row">
    <span class="measure-k">{{ r.k }}</span>
    <span class="measure-v">{{ r.v }}</span>
  </div>
  <div class="measure-hint">Esc to exit</div>
</FloatingPanel>
```

#### Pick fields

A tool that collects more than one selection gives each its own row, as
`MirrorToolPanel.vue` does (`.mirror-panel`, `.mirror-field` in `_modals.scss`):

- a 28px `IconButton` toggle first, `active` on the field that takes the next
  clicks, and the field name and value after it ("Nothing picked", "3 bodies",
  "XY plane");
- a `.float-card-close` clear button last, disabled while the field is empty;
- `.mirror-field.active` wears the selected row look, so the live field reads
  at a glance in both themes;
- buttons take `@pointerdown.prevent`, so Enter after a click still goes to the
  tool, and the tool leaves Tab and Enter alone while focus is in the panel;
- no `closeOnEsc`: the tool owns Escape, and the prompt banner says why a pick
  was refused.

### 7.14 Feedback: copy, toasts and errors

`toast(message, opts)` (`src/ui/toast.ts`) takes
`opts: { kind?: "info" | "warning" | "error"; action?: { label, onClick }; timeout?: number; detail?: unknown; source?: string }`.
It returns the toast's id for `dismissToast`, or null for an error.

- `info` (the default) and `warning` show a `.toast` (3.5s, a warning 6s,
  one with an action 9s so it can be read and its button reached).
- The same message, kind and action label again restarts the toast already
  showing, with the newer action, rather than stacking a copy.
- `error` does not show a toast. It goes to the title bar notice
  (`showErrorNotice`) and the console log, with `detail` kept for the report.
- Every toast is also a console entry and a bug report breadcrumb, so do not
  toast on every keystroke or hover.

Copy has two patterns, pick by the button:

- An icon button that copies (the console's `.logcon-copy`): swap the icon to
  `check` and the `title` to "Copied" for 1200ms, then back. If the clipboard
  refuses, fail silently, the text stays selectable.
- A text action that copies (McpSection's config): `toast("Copied.")`, and on
  failure `toast("Could not copy. Select the text and copy it.", { kind: "error" })`.

### 7.15 Marks in the scene

The origin triad and the origin plane tiles are drawn in the 3D scene, so the
guard test cannot see them; hold them to these rules by hand.

- Axis colours come from `AXIS_COLOR` (`src/viewport/originTriad.ts`) and are
  never themed. A plane takes its normal axis colour: XY blue, XZ green, YZ red.
- Neutral parts read tokens through `themeColor` and are read again on a theme
  change.
- Sizes are screen pixels, held through `gizmoScale.ts` at every zoom.
- The tiles are 68px, 10px off the axes, one per quadrant facing the home view,
  never below about 41px. Their 29px corner is the same squircle as `corner-shape:
  squircle`, a rail tile's 17px on 40px scaled up (`TILE_CORNER_RADIUS_PX` and
  `SQUIRCLE_EXPONENT` in `src/viewport/originTiles.ts` and `cornerProfile.ts`).
- What a body hides draws faint, not gone.
- A name in the scene is a camera facing sprite, `--ui` 700 at 11px, inked in
  `--text` or `--viewport-bg`, whichever reads on the ground. It fades out when
  what it names is seen edge on.

## 8. Motion

| Token | Value | Use |
|---|---|---|
| `--ease` | `cubic-bezier(0.2, 0, 0.15, 1)` | The one easing |
| `--t-fast` | 110ms | Hover, press, colour, the entrance of menus, toasts and the palette |
| `--t-med` | 160ms | Larger entrances: glass popovers, the chooser, the tool prompt |

The standard transition is
`transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);`.
Transition only background, color, box-shadow, opacity and
transform, never layout. The one layout property that moves is the `width` of
a progress fill inside a fixed track (`.timeline-busy .busy-bar i` and
`.timeline-node .t-bar i` at `0.4s var(--ease)`, `.rd-emitting-bar` at
`120ms linear`), because it moves nothing around it.

Off the scale, do not copy: `profile-panel-in 0.14s ease-out`
(`_utilities.scss`), the error notice's `err-pop` on
`cubic-bezier(0.3, 1.6, 0.5, 1)` and `logcon-flash 1.6s` (`_notice.scss`).

Entrances are small, 4 to 6px of travel and a scale of 0.97 to 0.98:

| Keyframes | From | Timing | Used by |
|---|---|---|---|
| `pop-in` (`_titlebar.scss`) | `opacity: 0; transform: translateY(-4px) scale(0.98)` | `var(--t-fast) var(--ease)` | Menus, toasts, the palette, the console, the selection editor |
| `glass-in` (`_glass.scss`) | `opacity: 0; transform: translateX(-4px) scale(0.97)` | `var(--t-med) var(--ease)` | Popovers, the chooser, rail flyout tiles (staggered by `calc(var(--i, 0) * 16ms)`) |
| `prompt-in` (`_utilities.scss`) | `opacity: 0; transform: translateY(-6px)` | `var(--t-med) var(--ease)` | The tool prompt |

Menus, popovers and dialogs have no exit animation, they unmount. A toast fades
out over 0.18s. No bounce, except the error notice's triangle (`err-pop`). Camera moves fly
with smootherstep (`viewport/viewFlight.ts`), between 0.18s and 0.5s.

Reduced motion: `src/ui/motion.ts` sets `<html data-motion="off">` from the
Animations switch (Preferences, Accessibility), following the system's
`prefers-reduced-motion` until the user chooses. `_motion.scss`, loaded last,
sets every animation and transition to 0.01ms (not 0, `animationend` must still
fire). So a CSS transition needs no code of its own. An infinite animation needs
a still state under both `@media (prefers-reduced-motion: reduce)` and
`:root[data-motion="off"]` (see `busy-bar-still` in `_timeline.scss`). Script
driven motion checks `motionOn()` (or `cameraFlightsOn()` for the camera).

## 9. Voice and wording

The UI speaks like the manual (`manual/docs/`): plain, short, calm, second
person, present tense. No exclamation marks, no emoji, no marketing, no "simply"
or "just", no blame. Never name another CAD product; say "mainstream MCAD
convention" if you must compare. No em or en dashes and no spaced hyphen as
punctuation, join clauses with a comma (`scripts/check-repo-hygiene.sh`).
The product is spelled FundaCAD.

| Kind | Rule | Good | Bad |
|---|---|---|---|
| Button | One or two words, the verb of what happens | Save, Discard, Remove from list, Open copy | OK, Yes, Submit |
| Command that opens a dialog | Title Case, real ellipsis character | Save As…, Export…, Keyboard Shortcuts… | Save as..., Export Dialog |
| Confirm | A full sentence naming the object, the consequence in the hint | "Save changes to Bracket before closing?" with Discard "lose the unsaved changes" | "Are you sure?" |
| Error | What happened in plain words, then the way out, joined with a comma; lead with "Could not" | "Could not reach the clipboard, so the report was not copied." | "Error: clipboard write failed!" |
| Rejection in a tool | Say what to do next | "That face is curved, a hole needs a flat face" | "Invalid selection" |
| Success | Short, past tense or present state, full stop | "Copied.", "Bracket is installed." | "Success!!" |
| Empty state | One sentence about what will appear, maybe the next step | "Your modeling history will appear here. Start with a Sketch, or drop a STEP, STL or 3MF file." | "Nothing here :(" |
| Tool prompt | Imperative, parts joined by " · ", ending with the key to leave | "Click a profile · Ctrl-click adds areas · Enter" | "Please select a profile to extrude." |
| Tooltip | What the control does, sentence case, shortcut in brackets | "Reset camera (Shift+Home)" | "Camera" |
| Setting | A noun label, then 1 to 3 sentences on the effect and the default | Animations: "Off makes every transition instant…" | "Enable animations?" |

UI names are proper nouns mid sentence: History, Items, Home, Preferences.
Tool names are Title Case (Linear Pattern, Press/Pull). Keys are joined with
a plus, as in the menus, the command palette and the hint tables: Ctrl+S,
Ctrl+Alt+H, Shift+Home, Esc, Enter. Write Ctrl and Alt, never the Mac names,
and show any text that names them through `fmtKeys()` (`src/input/platform.ts`),
which turns them into the Command and Option glyphs on a Mac. Use "No X yet" for lists that will fill and
"X appear here" for passive sources. Technical engine text goes after a plain
lead; the full text is kept in the console.

## 10. Light and dark themes

`src/ui/theme.ts` applies a theme by writing the colour tokens inline on
`<html>`, plus `color-scheme`. Only the tokens in `PALETTE_TOKENS` change, as
hex or `rgb()`/`rgba()` values: `--bg --panel --panel-2 --raised --raised-2
--viewport-bg --line --line-strong --text --text-dim --text-mute --accent
--accent-hot --accent-tint --accent-tint-2 --on-accent --ok --warn --error
--error-tint --pick-line --accent-blue`. Shape, glass, motion and z tokens
never change from a palette. A palette that sets the retired `--accent-glow`
still loads, the token is dropped.

Shipped: FundaCAD Noir (built in, dark), Dracula, **Solarized Light** (the light
one: `--bg #fdf6e3`, `--panel #eee8d5`, `--raised #ffffff`, `--text #073642`,
`--text-dim #3a4f55`, `--text-mute #4d6165`, `--accent #25669b`,
`--accent-hot #173f5f`), Colour-Blind Safe, and the Noir Blue, Red and Orange
tints. Users can upload their own palette.

![The same workspace in Solarized Light](design/workspace-light.png)

### The light theme

`apply()` in `theme.ts` toggles the class `html.theme-light` for every palette
whose `mode` is `light`, shipped or uploaded. An uploaded light palette needs
nothing more than `"mode": "light"`: the `:root.theme-light` block in
`_tokens.scss` derives the paper cards from its `--raised`, `--bg`, `--panel`
and `--text`, so the cards follow the palette.

- **Paper cards.** The card is a near white sheet: `--float-bg-solid` mixes
  `--raised` into `--bg`, and `--float-bg` is that at 97%. A tile is a step
  darker than the card, a chip another step, and a field a grey well
  (`--field-bg` mixes `--text` 11% into the card). `--hover-wash` and
  `--check-off` are mixes of `--text`.
- **Soft shadows.** `--float-shadow`, `--shadow-2`, `--shadow-3` and
  `--shadow-pill` are inked in `--text` and soft. A black offset slab reads as a
  hole on paper.
- **Clear of the grid.** Floating chips, tiles and rails over the viewport
  stand clear of the pale scene: a card against `--viewport-bg` must reach a
  contrast above 1.15:1.
- **Readable text.** Every text token (`--text`, `--text-dim`, `--text-mute`,
  `--accent`, `--accent-hot`) reads at 4.5:1 or better on every fill it sits
  on: the card, the solid card, a tile, a chip and a field. `--on-accent` on
  `--accent` is held above 4.5:1 too. A light theme's `--accent-hot` is darker
  than its `--accent`, not lighter, because it is text on an accent tint.

`tests/ui/designSpec.test.ts` and `tests/ui/themeContrast.test.ts` hold these
numbers for Solarized Light.

What this means for you:

- Build every fill from `--panel`, `--panel-2`, `--raised`, `--line*`,
  `--text*`, `--accent*`, the fill tokens of [2.1](#21-colours-by-role-fundacad-noir-values)
  or `color-mix` of them. The glass fills mix `--panel`, so glass recolours
  itself.
- Do not add white or black overlays of your own. The fill tokens carry the
  light variants. A hard coded dark fill stays dark on a light theme and
  its text becomes unreadable, so viewport readouts are glass chips, and
  `tests/ui/themeContrast.test.ts` rejects a hard coded dark readout fill.
- Check every screen in FundaCAD Noir **and** Solarized Light (Preferences,
  Appearance, Theme).

## 11. Accessibility

Focus:

- The shared outline (`_base.scss`):
  `:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }`.
  It shows on keyboard focus only, never on a pointer click, and it is the one
  outline on a rounded surface ([Depth without lines](#depth-without-lines)).
- Fields (`.sm-input`, `.sm-select`, `.param-row input`, the Items filter) draw
  a 1px accent outline with no offset while focused. The checkbox draws a 2px
  outline at a 2px offset around its box.
- Tabs and segments use an inset outline (`outline-offset: -2px`), so a clipped
  row does not hide it. On the rail the outline is on the `.rail-btn` button,
  not on the `.rail-tile` inside it.
- Never use a ring `box-shadow` for focus, and never `outline: none` without a
  replacement.

Contrast (Noir): `--text` on `--panel` 15.35:1, `--text-dim` 7.03:1, `--accent`
9.57:1, `--accent-hot` 11.70:1, `--on-accent` on `--accent` 10.43:1, `--error`
5.76:1. `--text-mute` is 4.00:1 on `--panel` and 3.06:1 on `--raised`: hints and
metadata only. `--line-strong` is decorative. On the light theme every text
token reaches 4.5:1 ([10](#10-light-and-dark-themes)).

Semantics: an icon only button has an `aria-label` (and the same `title`).
Toggles use `aria-pressed`, switches `role="switch"` with `aria-checked`,
option groups `role="radiogroup"` with `role="radio"`, tabs `aria-selected`.
A dialog has `role="dialog"` and a name: `aria-labelledby` pointing at its
visible title (`ModalFrame.vue` and the chooser in `ModalHost.vue`, through
`useId()`), or an `aria-label` when it has no title (`CommandPalette.vue`,
`HomeScreen.vue`, `ConsolePanel.vue`, `TargetEditPanel.vue`). A modal one also
has `aria-modal="true"`. Decorative icons get `aria-hidden`.

Keyboard: every control is reachable and shows the focus outline. Single letter
shortcuts are ignored while typing (`isEditableTarget`, `ui/focus.ts`). Every
confirm offers Cancel.

Escape depends on what the surface is:

| Surface | Escape |
|---|---|
| A menu, popover, the command palette (`MenuBar.vue`, `ui/menu.ts`, `ContextMenuHost.vue`, `Popover.vue`, `CommandPalette.vue`) | Closes the topmost one only. It calls `claimEscape()` (`ui/escapeClaim.ts`) while open, and tools check `escapeClaimed()` so the same key does not also cancel them |
| A dialog (`ModalFrame.vue`, the chooser) | Closes it through its own handler and the modal gate (`composables/useModalGate.ts`) |
| A non modal tool panel with nothing of its own to cancel (Properties, Interference, Parameters) | `close-on-esc` on `FloatingPanel`. It does not claim Escape, so the key also reaches the global handler; the hint says "Esc to close" |
| A panel that belongs to a running tool or mode (Measure, Overhang) | No `close-on-esc`. Whatever owns the panel closes it: `MeasureTool` owns Escape for its whole run and drops the panel with its highlight ("Esc to exit"), Overhang goes with the Draft toggle ("toggle Draft to close") |
| A tool panel with layers of its own to back out of (Stress) | No `close-on-esc`, its own bubble phase `keydown` in `StressPanel.vue`. One layer per press: a drag, placing a spot or Read a point first (`viewport/stressGlyphs.ts` takes them in capture and stops the key), then a focused field gives up focus, and only then the panel closes, keeping the setup and the last result as the Close button does |

Never call `claimEscape()` from a tool panel: the tool would stop hearing its
own Escape.

Disabled is opacity 0.45 (the common value), `cursor: default`, and no hover;
menu and context rows also take `pointer-events: none`.

Not handled yet, so do not rely on them: `prefers-contrast`, `forced-colors`,
`prefers-reduced-transparency`, a role on the toast stack.

## 12. Do and don't

| Do | Don't |
|---|---|
| Reuse a glass class, or add your selector to the lists in `_glass.scss` | Ship a flat opaque panel (`var(--panel)`, `var(--panel-2)` or `var(--raised)` as a surface fill) over or instead of the workspace |
| Fill glass with `--float-bg` or `--float-bg-solid`, a tile with `--float-tile-bg`, a chip with `--float-chip-bg`, a field with `--field-bg` | Write a translucent `rgba()` fill or your own `backdrop-filter: blur(...)` |
| Use colour tokens and `color-mix` on them; give controls their fill by wearing a class on the `_glass.scss` lists | Write a hex, `rgb()`, `hsl()` or named colour, or a `var(--token, #hex)` fallback |
| Use `var(--float-shadow)` | Add a one off shadow, a glow or a halo, or a hard `--shadow-2`/`--shadow-3` on something over the model |
| Tell a surface apart by its fill and shadow; write `border: 1px solid transparent` where the box needs a border | Draw an outline, a border colour or a 1px ring around a rounded surface |
| Show hover with `--hover-wash`, on with `--accent-wash` or an accent 16% fill | Change a border colour or add a ring for a state |
| Divide the parts of a dialog, menu or dock with `--line` | Draw the edge of a surface in `--line` or `--line-strong` |
| Use `--float-radius`, `--float-tile-radius`, `--float-chip-radius` with `corner-shape: squircle` | Use `--r-*` or a px radius on a floating surface |
| Keep 12px (`--float-gap`) around floating surfaces | Dock a new panel edge to edge (the Render dock is the one docked column) or cover the model with a sheet |
| Keep the accent for active, selected, focused and primary, and for `.measure-title` | Fill a large area with the accent, or colour a card or dialog title |
| Toggle a setting with the `.check` checkbox | Put a switch on a settings page; switches are for live toggles in tool panels |
| Grow small targets to about 40px with a pseudo element under touch | Ship a 24px target, or change layout for touch |
| Give every control a visible focus outline | Remove the outline and leave nothing, or draw focus as a ring shadow |
| Check FundaCAD Noir and Solarized Light | Test only the dark theme |
| Check with blur off | Rely on blur to make text legible |
| Use `--t-fast`, `--t-med` and `--ease` | Write `0.14s ease-out` |
| Write `title` plus `aria-label`, shortcuts as Ctrl+Alt+H through `fmtKeys()` | Build a custom tooltip, or write "Ctrl Alt H" |
| Build a readout from `FloatingPanel` and the `.measure-*` classes | Invent `.my-panel-head` and `.my-row` with their own padding |
| Leave Escape to the tool that owns the panel | Call `claimEscape()` from a tool panel |
| Use `--error` | Use `--danger` or a hard coded red |

## 13. Checklist before UI work is done

Run all of it. Paste the screenshots into the review.

1. **Reuse first.** Is the surface an existing class from [4.2](#42-use-an-existing-glass-class-first)
   or [7](#7-component-recipes)? If it is new, is its selector on the `_glass.scss`
   lists (fill, radius) and are its controls and rows on the
   control, hover and selected lists?
2. **Tokens only.** No raw colour, no fallback, no invented token, no new
   shadow, radius or duration literal. Fills come from the `_glass.scss` lists. `npx vitest run tests/ui/designSpec.test.ts` passes.
3. **Glass is live.** In the browser, the bodies smear through the panel, the
   surface has no outline and is told apart by its fill and one soft shadow,
   the corners are squircle, and there is a 12px gap to the stage edges and
   neighbours. Hover, selected and on states are fills, not borders or rings.

4. **Both themes.** FundaCAD Noir and Solarized Light, nothing stays dark on
   light or light on dark, the cards stand clear of the grid and every text
   reads at 4.5:1 on its fill in the light theme.
5. **Blur off.** Turn on potato mode (Preferences, Viewport), or run
   `document.documentElement.classList.add("no-glass-blur")`. The screen is
   opaque and still looks finished.
6. **Narrow and wide.** A wide window, a stage under 820px, and a window under
   760px and 560px. Nothing overflows, nothing scrolls sideways.
7. **Touch.** With `<html data-pointer="touch">`, every small target reaches
   about 40px and nothing moves.
8. **Keyboard.** Tab through it: every control shows the accent outline, Escape does what
   [11](#11-accessibility) says for this kind of surface, Enter does the
   primary thing. A dialog has `role="dialog"` and a name.
9. **Motion.** Entrances use `pop-in` or `glass-in`; with Animations off
   (Preferences, Accessibility) everything jumps to its end state.
10. **Wording.** Every string passes [9](#9-voice-and-wording), and
    `sh scripts/check-repo-hygiene.sh` passes.
11. **Side by side.** Screenshot the new UI next to an existing panel (the
    workspace shot in this page, or the real app) in both themes. If it would
    not pass for the same product, it is not done.

## 14. Known debt, do not copy

- `_home.scss` on `dev`: opaque, no glass, hex fallbacks, a one off shadow.
  When the glass Home lands, its counts in `COLOUR_BASELINE` and
  `FLAT_BASELINE` drop, the guard fails until they are lowered, and this line,
  the anti reference caption in [1](#1-principles) and the Home bullet of
  [4.4](#44-what-glass-floats-over-and-what-breaks-it) change in the same commit.
- Flat leftovers: `.timeline-props.floating`, the bare `.palette` (only
  `.float-right .palette` is glass), `.dropchip`, `.profile-panel`.
- Flat base rules under glassed surfaces (`_modals.scss`, `_utilities.scss`,
  `_console.scss`, `_targetedit.scss`), including hand written blurs and a
  stale comment about a "flat, zero-blur elevation". `_glass.scss` overrides
  them; read the final result, not the base.
- Off palette literals: `#3d4452` hovers, `#e24a3b` and `#ff7a66` danger,
  `#d2a83b` warning (`.toast-warning`), `#ff6b6b`, `#e0a020`, `#7fe08a`,
  `rgba(74, 208, 125, …)` (`button.finish`).
- Undefined tokens listed in [2](#2-tokens), and `--grid-minor` and
  `--grid-major`, read by `viewport/scene.ts` but never defined.
- `--z-menu`, `--z-toast` and `--shadow-pill` are defined and unused.
- Raw colours inside the measure panels: `OverhangPanel.vue` writes
  `color: #e24a3b`, and `PropertiesPanel.vue` and `InterferencePanel.vue` write
  `var(--accent-hot, #ff9a5c)` inline.
- No base disabled state for `button`, no focus state on `.rd-search`.
- 12 components carry an SFC `<style>` block although `main.scss` says there
  are none; new styles go in `src/styles/`.

## 15. The guard test

`tests/ui/designSpec.test.ts` reads every `src/components/**/*.vue` and
`src/styles/*.scss` through Vite and checks:

1. **Colour literals are a ratchet.** Each file holds exactly the raw colour
   literals (hex, colour functions, named colours) listed for it in
   `COLOUR_BASELINE`. A new file starts at zero. When you remove literals,
   lower the number in the same commit; the test fails until you do, so the
   room never stays open for new ones.
2. **No new flat slab or hard shadow.** Outside a hover, press, focus or
   selected rule, a `background` of `var(--panel)`, `var(--panel-2)`,
   `var(--raised)` or `var(--raised-2)`, and a `box-shadow` with
   `--shadow-1/2/3`, are counted per file against `FLAT_BASELINE`, exactly, a
   new file at zero. That is the signature of the flat Home. A floating surface
   goes on the `_glass.scss` lists instead; an inset well or flat control in a
   new file is the rare case where the number goes up, and the review should
   ask why.
3. **Blur goes through the glass.** Outside `_glass.scss`, a `backdrop-filter`
   is `var(--float-blur)` or `none`, unless the file is on `BLUR_ALLOWED` with a
   reason.
4. **Tokens exist.** Every `var(--name)` is defined in `_tokens.scss` or set
   locally (a declaration, an inline `:style`, a `setProperty`). The old
   undefined names are listed in `UNDEFINED_ALLOWED`; that list only shrinks.
5. **No outline around a rounded surface.** A rule that rounds a surface, by
   its own declarations, by a class the templates give the same element or by a
   parent selector, may not paint an edge: a visible `border`,
   `border-color`, `border-style`, `border-image`, `outline`, `outline-color`,
   a ring `box-shadow` (zero offset, a blur of 1px at most, a spread, however
   it is spelled) or a masked `::after` ring. Only a real `:focus` or
   `:focus-visible` state is exempt, not `:focus-within`. Signal borders
   (`--error`, `--warn`) and the entries of `OUTLINE_ALLOWED` (sketch labels,
   drawn glyphs, swatches, the guide ring) are exempt too
   ([Depth without lines](#depth-without-lines)).
6. **Retired tokens stay invisible.** `--float-line`, `--glass-sheen`,
   `--glass-inset`, `--glass-rim` and `--accent-glow` are defined as
   transparent in `_tokens.scss`, and no component or partial reads them.
7. **The accent is calm.** `--float-blur` saturates only lightly (`saturate(1.0x)`) and
   `--accent` is `#51d6a8`.
8. **The light theme reads.** On Solarized Light every text token reaches
   4.5:1 on the card, solid card, tile, chip and field, `--on-accent` on
   `--accent` clears 4.5:1, and a card clears its viewport at above 1.15:1.
9. **Settings use the checkbox.** Nothing Preferences renders contains a
   `.param-switch`, `.ft-switch`, `ToggleRow` or `Toggle`.
10. **An error shows on a typed field.** Of the rules that name a dimension
    field in a `.dim-bad` box, the winning background keeps `--error-tint`, so a
    refused typed value does not look normal.

It cannot see a screen. Whether a surface is glass, both themes and blur off
are still yours to check with the [checklist](#13-checklist-before-ui-work-is-done).

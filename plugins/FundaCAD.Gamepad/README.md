# Game controller

Flies the view and runs commands from a game controller or a Steam Deck.

## Default layout

| Input | Does |
| --- | --- |
| Left stick | Pan (moves the cursor while the cursor is on) |
| Right stick | Rotate |
| Right / left trigger | Zoom in / out |
| A | Enter, or click while the cursor is on |
| B | Escape |
| X / RB | Undo / Redo |
| Y | Command palette |
| LB | Cursor on / off |
| D-pad | Top, Front, Isometric and Right views |
| Right stick click | Fit view |
| Left stick click | Cycle projection |
| View / Menu | Reset camera / Save |

Every button except the triggers can be rebound in Preferences, Game
Controller, to any command the palette has, to a key, or to the cursor.

## Steam Deck

Start FundaCAD from Steam (Add a Non-Steam Game) so Steam Input presents the
Deck as a controller; the "Gamepad with Mouse Trackpad" layout keeps both
trackpads working as a mouse, which makes the on-screen cursor unnecessary.
Launched outside Steam, the Deck is in its desktop mouse mode and no pad
exists for this to read.

## Why these grants

`device.input` because it reads the controller. `document.write` because a
button can run any command, Undo and Save included, and those are edits.

## What is here

- `gamepad.ts`, the bindings, the stored settings, and the stick arithmetic,
  with no DOM so the suite can drive it.
- `main.ts`, polling the pad, moving the camera, sending keys and clicks.
- `GamepadSection.vue`, the Preferences page.
- `state.ts`, which pad is being read, for that page.

No native code. The pad is read through the webview's Gamepad API. On Linux
that needs a WebKitGTK built with libmanette; one built without it reports no
pads and this plugin quietly does nothing.

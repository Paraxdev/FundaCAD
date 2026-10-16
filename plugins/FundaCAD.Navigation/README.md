# Mouse and keys

Choose which mouse button orbits and pans, add a radial menu at the cursor, and
move keyboard shortcuts. Off until you turn it on; turning it off puts the
default mouse and keys back.

## Button presets

| Preset | Orbit | Pan | Zoom | Context menu |
| --- | --- | --- | --- | --- |
| Right orbits (default) | Right drag | Shift+right or middle drag | Wheel | Right click |
| Middle orbits, Shift+middle pans | Middle drag | Shift+middle drag | Ctrl+middle drag, wheel | Right click |
| Middle orbits, Ctrl+middle pans | Middle drag | Ctrl+middle drag | Shift+middle drag, wheel | Right click |
| Alt+left orbits | Alt+left or right drag | Alt+Shift+left, Shift+right or middle drag | Alt+Ctrl+left drag, wheel | Right click |

The left button alone always selects, in every preset. Alt+left orbits with a
body selected and inside a sketch too. It steps aside only for the datum pose
and light aim dials and a sketch pattern being placed, which read Alt
themselves.

On Linux, some window managers take Alt+drag to move the window before the app
sees it. Pick a middle button preset there, or change the window manager's
modifier.

## Radial menu

Off by default. Turn it on under this plugin's row in Preferences > Plugins. Hold the trigger,
move towards a command and let go; or tap the key (W unless you move it) and
click. What it offers depends on what you are doing: nothing selected,
something selected, or in a sketch, and each of the three lists is yours to
change. Past eight commands, the rest go in a More ring.

The mouse trigger is Alt+right drag by default. Right drag or middle drag work
only in a preset that leaves that drag free.

## Keyboard shortcuts

Every shortcut in the `?` sheet can move to another key. A key already in use
is named, and the one you chose is preferred over it; the `?` sheet lists every
clash. Undo, save, Escape, Tab and `?` cannot move, and Alt combinations are
left to the tools.

The pattern tool reads the arrow keys itself while it is open, so moving the
view steps off the arrows does not free them there.

## What it asks for

| Grant | Why |
| --- | --- |
| `input.remap` | to change what the mouse buttons and keys do |
| `document.read` | to know whether something is selected or a sketch is open, for the radial menu |

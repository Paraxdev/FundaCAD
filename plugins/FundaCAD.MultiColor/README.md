# Multi-material

Filament slots, per body and per texture colour, and the toolhead mapping a
multi-colour print needs.

## Why these grants

`document.read` and `document.write` are the whole feature: a slot assignment
is stored on the body, so there is nowhere else for it to live.

## Why it is off until asked for

All of it answers to hardware. On a single-material machine every surface it
adds is a control with nothing on the other end.

## Why it has no code of its own

This one has nothing to START. It is read where the work happens, by the
document store, the browser tree, the exporters and the print flow, on every
rebuild. That is also why it cannot be a Python plugin: those answers are
needed synchronously, inside a render, and a process on the other end of a
socket cannot give them.

Turning it off hides the palette, the slot assignments, and the paint they
produce. It does not delete any of them: they are saved, loaded and exported
exactly as before, so turning it back on finds the work still there. A toggle
that ate data would not be a toggle.

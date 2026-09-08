# Multi-material

Filament slots, per body and per texture colour, and the toolhead mapping a
multi-colour print needs.

## Why these grants

`document.read` and `document.write` are the whole feature: a slot assignment
is stored on the body, so there is nowhere else for it to live.

## Why it is off until asked for

All of it answers to hardware. On a single-material machine every surface it
adds is a control with nothing on the other end.

## What is here

- `palette.ts` — what a slot means: the body colour menu, the nearest-slot match
  an import uses, and the paint the viewport is handed.
- `PaletteSection.vue` — the palette panel, contributed to the browser.
- `main.ts` — everything the app is told about all of it.

This used to be a manifest and this file and nothing else, while the capability
itself was eight `if (multiMaterialEnabled())` checks spread through the app: in
the render bridge, the browser panel, the body context menu, the import path,
the texture tool and the exporters. Each one was a piece of the core that knew
what a palette was and knew which switch decided whether it counted.

## Why it is TypeScript and not Python

It answers per rebuild, per body, per face, synchronously, inside the render
path — `paint` is asked again for every chunk of a progressive load. A process
on the other end of a socket cannot serve that. It is the "a view and some TS"
case rather than the "drive it from Python" case, and the difference is not
preference: it is whether the answer has to arrive within a frame.

## What stays in the app

The document. `palette` and `bodyColors` are the FILE FORMAT, and a file saved
with colours has to open, save and export unchanged on a machine where this is
switched off. A format that lost data when a plugin was absent would be a much
worse bargain than a checkbox that hides a panel.

So turning it off hides the palette, the slot menus and the paint they produce,
and deletes none of them. Turning it back on finds the work still there. A
toggle that ate data would not be a toggle.

## Why it needs the printer, without importing it

The panel it draws is a list of what is loaded in a machine's toolheads. It
cannot answer that, and the capability that can should not have to own a colour
panel. So it asks the app for a value called `filaments`, which the printer
capability offers and the app passes along without looking inside. With no
printer running there is no answer, so the panel draws nothing — which is what
it should do on a machine with no printer anyway.

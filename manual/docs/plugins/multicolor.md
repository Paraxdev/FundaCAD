# Multi-material

This plugin gives each body a filament slot, and slot 1 prints on toolhead 1, slot 2 on toolhead 2 and so on. It is off by default, so switch it on in Edit, Preferences, Plugins.

<!-- shot: multicolor-palette | Palette section with three filament slots -->

## The Palette

A Palette section appears in the Items card once the document has a body and the printer answers. It needs the [Printer connection](printing.md) plugin on.

- A new document has four slots: White, Black, Red and Blue.
- Click a swatch to change its colour, and double-click a name to rename it.
- Sync filaments from printer, the button beside the dot, copies the loaded filaments into the slots. It asks before it overwrites slots you changed.

The dot is green when the slots match the printer, and yellow when the printer's filaments changed since the last sync.

## Give a body a slot

1. Right-click the body in the Items card or in the viewport.
2. Open Color and pick a slot, or None to clear it.

An imported mesh with its own colour goes on the nearest slot.

# Surface Texture

A printed surface texture on the faces you pick, or on a whole body: knurl, hex,
waves, ribs, voronoi, Perlin noise, or a heightmap read from an image file. It is
real mesh displacement rather than an appearance setting, so what you see is what
the slicer gets.

## Why it asks for what it asks for

| grant | what it does with it |
| --- | --- |
| `document.read` | reads the body and faces you selected, and the values of a texture you are re-opening |
| `document.write` | adds the texture feature, and replaces it when you edit one |
| `files.read` | only for the Heightmap pattern: the image you pick in the panel |

`files.read` is the one worth a sentence. Nothing is read unless you choose the
Heightmap pattern and then press Browse, and the only path that reaches the
document is the one you picked in that dialog.

## What happens to your textures if you remove this

They stay, and they keep building. The `texture` feature is part of the document
format and the geometry that makes it is part of the application, so a file with
a texture in it opens, rebuilds, renders and exports on a machine where this was
never installed.

What you lose is the ability to make a new one or change an old one from a panel.
The feature still appears in the history — as a row the build does not have a
name or a mark for, which is honest, because without this that is exactly what it
is — and its numbers are still in the value rows, still parameter-drivable, and
still editable by hand.

That line is deliberate and it is the same one the multi-material capability
draws. A plugin may own how something is CREATED and PRESENTED. It may not own
whether a file you already saved still opens.

## What it adds to the application

Everything below goes through the contribution table, so all of it appears when
this is switched on and is gone when it is switched off, with nothing in the
application naming this plugin.

- a **tool**: the Texture verb, which selecting a face or a body offers beside
  Fillet and Press/Pull, and which holds the window while it is running
- a **view**: the docked panel with the pattern, the depth, the scale and the
  rest, kept in this plugin's own state rather than in one of the application's
  stores
- a **ribbon button** in MODIFY, and the action behind it
- an **icon**, because the application does not have a mark for a tool it does
  not have
- **how a `texture` feature is drawn and edited**: its name and mark in the
  history, its three dropdowns and its switch, which of its value rows a given
  pattern actually reads, what its shape slider is called, and what happens when
  you double-click it

## Notes

The preview is real geometry at display resolution, computed by the same sidecar
path the final build uses, about half a second behind the slider. Exports keep
full detail. A vertex-shader preview was tried and dropped: it can only move
vertices that already exist, so it is invisible on a flat face, and without
recomputed normals the shading never changes.

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

Your file opens, every value is kept, and nothing is dropped when you save it
again. What stops is the building: the geometry that turns a texture into
displaced mesh is in this plugin, in `geometry/`, so without it a textured body
builds smooth and the feature's row goes red saying, by name, that Surface
Texture is not running. Install it or switch it back on and the same file builds
exactly as it did, because the numbers never went anywhere.

That is a deliberate change, and it used to be the other way round. The
`texture` feature was part of the document format, its rows were in the
application's own tables, and the two thousand lines that displace a mesh were
in `sidecar/`, dispatched from a table that said `"texture"` in plain text. A
file with a texture in it built on a machine where this plugin had never been
installed, which sounds generous and meant something worse: this was a panel in
front of a feature the application had anyway, and uninstalling it changed
nothing about what FundaCAD could build.

So the trade now is the honest one. A plugin that owns a feature owns the
geometry, and a document that uses one needs it. What the application still
guarantees, and what makes that trade safe, is that it can carry a feature it
cannot build: the values stay in the value rows, still typed, still
parameter-drivable, listed by their own field names since nothing else knows
what to call them, and a save writes them back untouched.

## What is in here

| | |
| --- | --- |
| `main.ts`, `textureTool.ts`, `TextureToolPanel.vue`, `panel.ts` | the tool, the panel, and everything it contributes to the window |
| `textureForm.ts` | the feature's SCHEMA: its fields, its rows, its dropdowns, and which of them a given pattern reads |
| `geometry/texture.py`, `texture_height.py`, `texture_mesh.py` | the displacement itself, imported into the geometry engine |
| `geometry/register.py` | what claims the `texture` feature type and the mesh pass behind it |

The manifest names both halves: `featureTypes` is what lets the application say
"this needs Surface Texture" while this plugin is not running, and `geometry` is
the module the engine imports when it is. See `sidecar/plugin_geometry.py` for
the registry on the other side.

Geometry a plugin registers runs inside the engine with everything that process
has. There is no sandbox around it and there is not going to be one: geometry
code that cannot call the kernel is not geometry code, which is the same bargain
Blender, Rhino and Fusion make. `sandboxNote("builtin")` is where a person is
told, in the words they read before installing.

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
- **the `texture` feature itself**: its name and mark in the history, its value
  rows and what they are called, its Faces row, its three dropdowns and its
  switch, which of those rows a given pattern actually reads, what its shape
  slider is called, and what happens when you double-click it
- **the geometry**, registered into the engine at startup: the feature handler
  that runs in the rebuild, and the mesh pass that displaces faces at
  tessellation time against the final shape

## Notes

The preview is real geometry at display resolution, computed by the same sidecar
path the final build uses, about half a second behind the slider. Exports keep
full detail. A vertex-shader preview was tried and dropped: it can only move
vertices that already exist, so it is invisible on a flat face, and without
recomputed normals the shading never changes.

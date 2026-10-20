# Printed look

Draws the fine layer lines a printed part has across its surface in the Realtime
view. Display only: the model, the file and every export are unchanged.

## Why these grants

`document.read` and nothing else. It writes nothing to the document: what it
draws is a function of its own settings, kept by the app, so there is no write
grant for it to hold.

## What is here

- `look.ts`, the pure half: the settings a person chooses, and the ridges they
  map to (direction to a unit axis, values clamped to what the viewport draws).
- `settings.ts`, the declared settings. Layer lines are off until asked for.
- `LayerLinesSection.vue`, the switch, height, direction and depth rows on the
  Render dock's Environment tab.
- `presets.ts`, the Filament group under the Render dock's New material menu.
  Material classes, no supplier names. Picking one adds a plain copy to the
  document, so the entries are in normal form and stay editable afterwards.
- `main.ts`, everything the app is told about it: the relief, the section, the
  Layer lines command and the settings under Preferences.

## Why the ridges are not in the app

The viewport can draw ridges for anyone who contributes them. What a printed
part's layers look like, and which axis they stack along, is this plugin's
business. With it off the app draws exactly what it drew before.

## The filament presets

Starting values, not yet tuned on a look board.

| Preset | Colour | Metalness | Roughness | Other |
| --- | --- | --- | --- | --- |
| PLA, matte | #e7e4dc | 0 | 0.85 | sheen 0.35 |
| PLA, glossy | #2f6fd6 | 0 | 0.38 | |
| PLA, silk | #c9a94a | 0.45 | 0.22 | anisotropy 0.6, specular colour as the colour |
| PETG, translucent | #6fb7e0 | 0 | 0.28 | opacity 0.5, attenuation #3d8fc4 over 6 mm, scatter 1.5 mm |
| PLA, carbon fibre fill | #2b2c2e | 0 | 0.78 | sheen 0.2, no flakes yet |
| PLA, wood fill | #a77a4c | 0 | 0.88 | voronoi specks at 0.4 mm tinted #6b4a2c |
| PLA, glow | #d9f2b4 | 0 | 0.6 | emissive 0.35, casts no light |
| TPU | #1f2022 | 0 | 0.7 | sheen 0.4 |

Glow shines and blooms but lights no other part and adds no area lights.

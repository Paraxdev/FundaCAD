# Printed look

This plugin draws the fine layer lines a printed part has across its surface. It changes only the Realtime view, never the model or its exports. It is on by default, with layer lines off.

<!-- shot: print-look-section | Environment tab with the Layer lines switch on -->

Turn on Layer lines in one of these places:

- Layer lines under Print on the rail.
- The Printed look section of the Environment tab in Render.
- The command palette, by searching for Layer lines.

The section has three settings.

| Setting | What it does |
| --- | --- |
| Layer height | The spacing between lines, 0.2 mm to start |
| Direction | The axis the layers stack along, +Z for a part printed flat on the bed |
| Depth | How deep each line is, as a share of the layer height, 0.35 to start |

Colour variation and Groove shading are in Edit, Preferences, Plugins, behind Settings on the plugin's row. There Direction is called Build direction.

## Filament materials

The plugin adds a Filament group to the New material menu in the Material tab of Render. Each entry adds a copy to your document that you edit like any other material.

<!-- shot: print-look-filament | New material menu with the Filament group open -->

| Material | Look |
| --- | --- |
| PLA, matte | Chalky off white with a soft rim |
| PLA, glossy | Blue with a sharp highlight |
| PLA, silk | Gold with a highlight stretched along the layers |
| PETG, translucent | Blue, half see-through and milky |
| PLA, carbon fibre fill | Dark and flat |
| PLA, wood fill | Brown with fine darker specks |
| PLA, glow | Pale green that shines but lights no other part |
| TPU | Near black rubber with a soft rim |

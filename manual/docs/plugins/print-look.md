# Printed look

This plugin draws the fine layer lines a printed part has across its surface. It only changes how the model is drawn in the Realtime view, the model and its exports are untouched. It is on by default and layer lines start off.

<!-- shot: print-look-section | Environment tab with the Layer lines switch on -->

Open the Render panel, go to the Environment tab and turn on Layer lines in the Printed look section. You can also search for Layer lines in the command palette.

| Setting | What it does |
| --- | --- |
| Layer height | The spacing between lines, 0.2 mm to start |
| Direction | The axis the layers stack along, +Z for a part printed flat on the bed |
| Depth | How deep each line is, as a share of the layer height |

Colour variation and Groove shading are in Edit, Preferences, Plugins, under the plugin's Settings.

## Filament materials

The plugin also adds a Filament group to the New material menu in the Render panel's Material tab. Each entry adds a copy to your document that you can edit like any other material.

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

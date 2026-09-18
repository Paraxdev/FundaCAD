# Printer connection

Sends jobs to a printer on your network, reads its status, and opens a model in
your slicer.

## Why these grants

`process.spawn` is not padding. Opening a model in a slicer starts another
program on the machine, and that is the single most consequential thing
anything in this app does on the user's behalf.

`network.local`, not `network`. It reaches printers on the local network, and
"connect to the internet" would be a worse description rather than a more
cautious one. The app's side of that grant refuses any address that is not
private or link-local, so the sentence on the screen is also what is enforced.

`files.read` is the sliced G-code you pick to send: the upload names the file by
the handle the picker gave back, never by a path.

`files.write` is the colored 3MF project on its way to the slicer, or to where
you save it.

## What is here

Everything. The app contains no knowledge that a printer or a slicer exists, and
`tests/plugins/coreIndependence.test.ts` refuses the words in its sources.

- `printerClient.ts`: the Moonraker protocol, the printer list, the status
  monitor and the camera poller, over the app's generic
  `plugin_local_request`.
- `slicer.ts`: where OrcaSlicer installs on each platform and where it keeps
  its presets.
- `printFlow.ts`: the two flows, open in the slicer and send to the printer.
- `printDialog.ts`, `FilamentMappingDialog.vue`, `FilamentMappingHost.vue`: the
  filament mapping.
- `exportProject.ts` and `geometry-rs/`: the project 3MF. The engine rebuilds and
  meshes, and the component in `geometry-rs/` registers the writer that decides what
  the file looks like, including flattening the slicer's presets into it.
- `PrintStatusPill.vue`, `CameraPanel.vue`: the live progress pill and camera.
- `native.ts`: typed wrappers over the app's generic commands.

`main.ts` is the whole of what the app is told about any of it: four rows in
File, a PRINT group in the ribbon with its three icons, three action ids, three
overlays, and one value offered to other plugins.

## Settings, and where they came from

The printer list is `printers.json` and the slicer location is `slicer.json`
(`slicer_path`, `orca_datadir`), both in this plugin's data directory. The app
shell used to keep them as `printers.json` and `settings.json` directly under
its data directory; the first time either is needed they are moved here with
`plugin_data_adopt`, so an existing configuration keeps working. The active
printer stays in `fundacad.activePrinter`.

## Why the 3MF PROJECT export is here

The app's own `Export…` still writes 3MF among its formats and is unchanged.
This is the other one: one object per body with a toolhead assignment each, a
preset naming one printer model, and a check afterwards that asks a machine what
filament it has loaded. Every sentence in it is about a printer.

## Why it offers `filaments` rather than drawing the palette

A palette is a list of colours in a document, which belongs to the capability
that owns colours; what is actually loaded in toolhead 3 right now can only be
answered here. Neither can draw that panel alone and neither should import the
other, so the panel belongs to the one that owns the data and this contributes
the answer under a name the two agree on.

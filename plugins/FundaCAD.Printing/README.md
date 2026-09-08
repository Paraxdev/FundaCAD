# Printer connection

Sends jobs to a printer on your network, reads its status, and opens a model in
your slicer.

## Why these grants

`process.spawn` is not padding. Opening a model in a slicer starts another
program on the machine, and that is the single most consequential thing
anything in this app does on the user's behalf.

Not `network`. It reaches the printers configured in this app, over the local
network, and "connect to the internet" would be a worse description rather than
a more cautious one. `printer.control` is where that reach is declared, and it
says which machines it means.

`files.write` is the sliced job on its way to the machine, and the colored 3MF
project on its way to the slicer.

## What is here

Everything. The typed wrappers over the Rust commands (`printerClient.ts`), the
two flows (`printFlow.ts`), the filament mapping (`printDialog.ts`), the project
export (`exportProject.ts`), the status pill, the camera panel and the mapping
dialog. `main.ts` is the whole of what the app is told about any of it: four
rows in File, a PRINT group in the ribbon, three action ids, three overlays, and
one value offered to other plugins.

The app used to carry all of that itself — three rows written out in the menubar
behind a capability check, a ribbon group plus a list of which of its buttons to
remove again, three cases in the action dispatcher, three components mounted by
`App.vue`, a `camera` field on the panels store, a `filament` field on the
dialogs store, a colored-3MF exporter in `io/files.ts`, and a printer probe with
a thirty-second staleness poll inside the browser panel.

## Why the 3MF PROJECT export moved here

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

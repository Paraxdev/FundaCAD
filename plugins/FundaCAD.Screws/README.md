# Fasteners

A library of standard fasteners and your own, in one searchable list. Pick one to see a live
preview and its specs, then insert it into the model or drag it onto a face.

Open it from INSERT, Fasteners.

## What is in the catalogue

Metric from M1.6 to M24 where the standard defines the size, inch from #2 to 1/2, with the
standard lengths for each size.

| family | standards |
| --- | --- |
| Socket head cap screw | ISO 4762 (DIN 912), ASME B18.3 |
| Button head socket screw | ISO 7380-1, ASME B18.3 |
| Low head socket cap screw | DIN 7984 |
| Countersunk socket screw | ISO 10642 (DIN 7991), ASME B18.3 82 degree |
| Countersunk cross recess screw, Phillips or Pozidriv | ISO 7046-1 |
| Pan head cross recess screw, Phillips or Pozidriv | ISO 7045 |
| Pan head hexalobular screw | ISO 14583 |
| Cheese head slotted screw | ISO 1207 |
| Hex head bolt, partially and fully threaded | ISO 4014, ISO 4017, ASME B18.2.1 |
| Hex flange bolt | DIN 6921 |
| Set screws, flat, cone and cup point | ISO 4026, ISO 4027, ISO 4029 |
| Shoulder screw | ISO 7379 |
| Knurled thumb screw | DIN 464 |
| Pan head tapping screw | ISO 7049 |
| Hex nut, thin nut, nylon insert lock nut | ISO 4032, ISO 4035, ISO 7040, ASME B18.2.2 |
| Hex flange nut, square nut | DIN 6923, DIN 562 |
| Plain and large washers, spring lock washer | ISO 7089, ISO 7093-1, DIN 127 B, SAE |
| Heat-set threaded inserts for printing | common knurled insert sizes, M2 to M8 |

Dimensions are the standards' nominal values. The spec table adds the thread, the clearance and
tap drill holes, a counterbore or countersink where the head wants one, and a mass in steel measured
off the solid.

## How an inserted fastener is kept

Exactly like an imported STEP part. The solid is generated once, stored in the document, and the
body is an ordinary imported body from then on: move it, cut with it, export it. The file opens and
builds on a machine without this plugin. The spec it was made from is kept on the feature, so
right-clicking the body and choosing Fastener Specs shows what it is.

With one flat face selected, Insert puts the fastener at the centre of that face with its axis along
the face normal. A drop puts it where the pointer is on the face. Otherwise it goes to the origin.
Screws hang from the face with the head on it, a countersunk head sits flush, nuts and washers stand
on it, an insert goes into it.

## Threads

Simplified by default: a plain cylinder at the nominal (major) diameter, for screws and for the holes
in nuts and inserts, so a screw in its nut does not show as a clash and a clearance hole checked
against it is checked against the outside of the thread. Choose Modelled helix for a real 60 degree
thread, cut to the ISO 68-1 basic depth, right or left hand. It is slower to build and much heavier.

## Your own fasteners

My fasteners, New fastener, or Make a custom one from this on any catalogue item. The form asks for
everything the kind and head need: head type and its dimensions, drive type and size, thread
diameter, pitch (or threads per inch), hand, thread length, simplified or modelled, length, point,
units, a name and notes. It refuses a fastener that is incomplete or cannot exist, a head narrower
than its shank, a thread longer than the shank, a drive that does not fit. Saved fasteners show in
the catalogue list with a Custom badge, and are exported and imported as a JSON file.

They are kept in this app's settings on this machine. A fastener you inserted is in the document
regardless.

## Why it asks for what it asks for

| grant | what it does with it |
| --- | --- |
| `document.read` | reads which face is selected, and which fastener a body came from |
| `document.write` | adds the inserted fastener to your history |
| `geometry.build` | builds the preview and the solid in the geometry engine |
| `files.read` | reads a fastener library file you pick to import |
| `files.write` | writes your fastener library to a file you pick |

It reaches no network.

## What is in here

| | |
| --- | --- |
| `catalogue/metric.json`, `catalogue/inch.json` | the families: standard, sizes, dimensions, lengths |
| `catalogue/threads.json` | thread pitches, clearance and tap drill holes, length series |
| `catalogue/fields.json` | which numbers each kind, head, drive, point, nut, washer and insert needs |
| `catalogue.ts` | a family, size, length and drive expanded into a complete spec, and the spec table |
| `spec.ts` | the spec, and the completeness and sanity checks |
| `search.ts`, `library.ts`, `state.ts` | the list and its filters, your own fasteners, the window state |
| `insert.ts` | generating and storing the solid, and where it goes |
| `LibraryPanel.vue`, `FastenerPreview.vue`, `CustomForm.vue` | the window |
| `geometry-rs/` | the solids: `spec.rs` checks, `fastener.rs` builds, `shapes.rs` heads and drives, `thread.rs` threads |

Adding a size is a row in a family's `sizes`. Adding a family is an entry in `metric.json` or
`inch.json`: `fixed` for what every member shares, `columns` mapping the table's columns onto spec
fields, `threadLength` for the thread length rule, and `lengths` naming a series in `threads.json`.
A new head, drive or nut shape also needs its fields in `fields.json` and its solid in `geometry-rs/`.

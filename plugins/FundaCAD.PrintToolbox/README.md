# 3D Printing Toolbox

Hole shapes, layer tricks and edge finishes that let a part print without
supports. Each tool but the bed fit check is a feature in the history, built as
exact geometry, so a fillet or a boolean after it sees the reshaped hole and an
export carries it.

| tool | what it does | pick |
| --- | --- | --- |
| Teardrop | turns a sideways round hole into a teardrop whose roof leans at a set angle from the build direction, optionally cut flat | the inside face of each hole |
| Roof Bridge | squares off the top half of a sideways hole so its roof is one flat bridge | the inside face of each hole |
| Counterbore Bridge | cuts one layer to a wall to wall slot as wide as the bore, the next to a square, optionally a third to an octagon, so a counterbore's ceiling bridges cleanly | the flat floor of each counterbore |
| Sacrificial Layer | closes a hole with a membrane one or more layers thick, which the slicer bridges and you drill out afterwards | a hole's inside face, or the flat face it opens onto |
| Thread-Forming Ribs | turns a plain round hole into a self-tapping screw hole: thin axial ribs protrude inward, below a lead-in, for the screw to cut its own thread into | the inside face of each hole |
| Zip-Tie Channel | cuts a U-shaped channel under a flat face so a zip tie can loop through the part; refuses a channel that would break through the far side | the face to cut under |
| Elephant-Foot Chamfer | chamfers the outer edges of the lowest face opposite the build direction, to cancel first-layer squish | the body, or its bottom face |
| Vertical Edge Fillet | fillets every edge of a body that runs parallel to the build direction, optionally convex edges only | the body |
| Bed Fit Check | a toast, not a feature: reports whether the model's bounding box fits a printer bed and, if not, the scale that would make it fit | (no pick, uses the built model) |

All nine live in the PRINT ribbon group. The first six are offered when faces
are selected; the chamfer and fillet act on the selected bodies, or the active
one when nothing is selected, and add their feature at once, no pick and wait.
With faces already selected a face tool acts at once too; otherwise it waits
for a pick and Enter. Every value is edited afterwards in the feature's rows.
The build direction a feature records is the one Overhang was set to when it
was made.

A chamfer or fillet edge the kernel refuses is skipped rather than failing the
whole feature; the row's tooltip says how many. Elephant-Foot Chamfer only
fails outright when none of the lowest face's edges could be chamfered, and the
same for Vertical Edge Fillet.

## Why it asks for what it asks for

| grant | what it does with it |
| --- | --- |
| `document.read` | reads which faces you selected and which body they belong to |
| `document.write` | adds the feature to your history |

It reads no files, writes no files, and reaches no network.

## What happens to these features if you remove this

The file opens and every value is kept. What stops is the building: the geometry
is in `geometry/`, so without this plugin the holes build in their plain shape
and each feature's row says, by name, that this plugin is not running. Install it
again and the same file builds as it did.

## What is in here

| | |
| --- | --- |
| `main.ts` | everything contributed to the window |
| `printForm.ts` | each tool as data: feature type, rows, defaults, and the feature a pick makes |
| `faceTool.ts` | the one pick tool every face-target verb runs through |
| `bodyTool.ts` | the pick-free counterpart for a verb that acts on a body: the chamfer and the fillet |
| `bedFit.ts` | the bed fit check's pure math, presets and remembered setting; not a feature |
| `geometry/register.py` | claims the feature types from the geometry engine |
| `geometry/ptb_holes.py` | teardrop and roof bridge |
| `geometry/ptb_layers.py` | counterbore bridge and sacrificial layer |
| `geometry/ptb_ribs.py` | thread-forming ribs |
| `geometry/ptb_zip.py` | zip-tie channel |
| `geometry/ptb_edges.py` | elephant-foot chamfer and vertical edge fillet |
| `geometry/ptb_read.py`, `ptb_occ.py` | reading picked holes, floors and bodies, and the kernel helpers |

Adding a tool is a `PrintTool` in `printForm.ts` listed in `PRINT_TOOLS`, an icon
in `main.ts`, a handler in `geometry/register.py`, and its type in the manifest's
`featureTypes`.

# 3D Printing Toolbox

Hole shapes and layer tricks that let a part print without supports. Each one is
a feature in the history, built as exact geometry, so a fillet or a boolean after
it sees the reshaped hole and an export carries it.

| tool | what it does | pick |
| --- | --- | --- |
| Teardrop | turns a sideways round hole into a teardrop whose roof leans at a set angle from the build direction, optionally cut flat | the inside face of each hole |
| Roof Bridge | squares off the top half of a sideways hole so its roof is one flat bridge | the inside face of each hole |
| Counterbore Bridge | cuts one layer to a wall to wall slot as wide as the bore, the next to a square, optionally a third to an octagon, so a counterbore's ceiling bridges cleanly | the flat floor of each counterbore |
| Sacrificial Layer | closes a hole with a membrane one or more layers thick, which the slicer bridges and you drill out afterwards | a hole's inside face, or the flat face it opens onto |

All four live in the PRINT ribbon group and are offered when faces are selected.
With faces already selected a tool acts at once; otherwise it waits for a pick
and Enter. Every value is edited afterwards in the feature's rows. The build
direction a feature records is the one Overhang was set to when it was made.

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
| `faceTool.ts` | the one pick tool every verb runs through |
| `geometry/register.py` | claims the feature types from the geometry engine |
| `geometry/ptb_holes.py` | teardrop and roof bridge |
| `geometry/ptb_layers.py` | counterbore bridge and sacrificial layer |
| `geometry/ptb_read.py`, `ptb_occ.py` | reading picked holes and floors, and the kernel helpers |

Adding a tool is a `PrintTool` in `printForm.ts` listed in `PRINT_TOOLS`, an icon
in `main.ts`, a handler in `geometry/register.py`, and its type in the manifest's
`featureTypes`.

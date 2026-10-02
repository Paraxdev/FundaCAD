# Stress samples

Two small synthetic parts with a stress study already saved in the file, so the
Stress panel opens set up and needs only Run. Both were modelled over MCP from
named parameters. Every supported or loaded face is a selector from `inspect`,
except the lever's pin hole, which is given by a point on its surface
(`by: "nearest"`, point (-4, 0, 5)). The hole is one face that wraps all the
way round, so that point picks the whole hole. The app tints a face given by a
point, but not one given by a curved-face fingerprint, which is why the sample
does not use the `match` selector `inspect` lists for the hole.

| File | What it shows | Supports | Load | Material |
|---|---|---|---|---|
| `wall-bracket.funda` | An L bracket with a filleted gusset under its arm, screwed flat to a wall | Fixed on the back face | 30 N down on the arm's outer end, plus its own weight | PLA, gravity on |
| `pinned-lever.funda` | A lever that turns on an 8 mm pin and rests against a stop | Pinned in the pin hole, slider on the stop lug's face | 70 N along -Y on the far end | PETG |

The lever needs both supports: a pin alone leaves it free to turn about the pin,
and the slider on the lug is what stops the turn. The slider holds the whole lug
face across its 6 mm width, so it also resists a little of the turn the way a
short clamp would, which is why its reaction is a bit below the 233 N a point
stop 30 mm from the pin would take.

A slider is not a contact: it holds its face both ways, like a pin in a slot,
so the stop can pull the lug as well as push it. The result is only right while
the stop pushes, which it does here (its reaction on the lever points along +Y,
into the lug). Reverse the load to +Y and the run gives the mirror
result with the stop pulling the lever back, which a real stop cannot do, and
nothing warns about it. Check the sign of a slider's reaction whenever it
stands in for a stop.

## In the app

1. Open the file with File, Open.
2. Open Inspect, Analyze, Stress. The panel reads the study back from the file:
   the body, the supports, the load, gravity and the material.
3. Press Run.

## Over MCP

`doc_open` the file, `build`, then call `stress` with the study's supports,
loads, gravity and material. For the bracket:

```json
{"body": "body1",
 "supports": [{"type": "fixed", "faces": [<back face selector from the file>]}],
 "loads": [{"faces": [<end face selector from the file>], "force": [0, 0, -30]}],
 "gravity": [0, 0, -9.81], "material": "PLA"}
```

The selectors are the ones under `stress` in the file, unchanged.

## What a run gives

At the automatic element size, with the engine as of this writing:

| | Wall bracket | Pinned lever |
|---|---|---|
| Element size | 2.167 mm (23774 elements) | 2.461 mm (20881 elements) |
| Peak von Mises | 15.08 MPa, at the tip of the gusset, in the 2 mm fillet where it meets the arm's underside | 10.94 MPa, in the 2 mm fillet where the stop lug meets the arm, on its far-end side, near (35, -10) |
| Safety factor | 3.32 | 4.57 |
| Largest deflection | 0.470 mm, at the arm's outer end | 0.930 mm, at the far end |
| Weight | 0.227 N (23.2 g) | none, gravity is off |
| Reactions | 30.23 N up at the wall | 158.0 N along -Y at the pin, 228.0 N along +Y at the stop |

The peak von Mises is not converged at these sizes, so read it as a rough
figure. Deflections and reactions are steady:

| Element size | Bracket peak | Bracket deflection | Lever peak | Lever deflection | Lever stop reaction |
|---|---|---|---|---|---|
| 3.0 mm | 12.62 MPa | 0.459 mm | 13.76 MPa, stop face | 0.934 mm | 224.5 N |
| 2.6 mm | 12.33 MPa | 0.456 mm | 10.74 MPa, stop face | 0.923 mm | 229.1 N |
| 2.3 mm | 12.77 MPa | 0.455 mm | 14.86 MPa, fillet | 0.910 mm | 221.7 N |
| 1.5 mm asked, grown to 2.049 and 2.185 mm | 11.86 MPa | 0.459 mm | 13.40 MPa, stop face | 0.912 mm | 222.2 N |
| 1.8 mm over MCP, `maxElements` 80000 and 60000 | 14.41 MPa | 0.455 mm | 13.88 MPa, stop face | 0.914 mm | 224.4 N |

So between about 2 and 3 mm elements the bracket's peak moves between 11.9 and
15.1 MPa (safety factor 3.3 to 4.2), and the lever's between 10.7 and
14.9 MPa (safety factor 3.4 to 4.7), with no steady trend either way. The
deflections stay within about 3 percent, the bracket's reaction does not
change, and the lever's stop reaction stays within about 3 percent.

Two things keep the peaks moving. Both sit on 2 mm fillets, which elements of
about 2 mm cannot resolve. And on the lever, at most sizes the peak jumps to
the stop face's upper outer corner, around (32, -13, 9), where the slider's
hold ends: stress where a support ends grows as the mesh is refined, and the
run warns about it.

The panel keeps the mesh within 30000 elements, so asking it for less than
about 2 mm grows the size back (the run warns that it did). A finer mesh needs
`maxElements` through the MCP `stress` tool.

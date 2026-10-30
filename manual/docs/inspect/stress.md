# Stress

Stress shows how a part bends and where the material works hardest, so you can tell whether a bracket or clip will hold.

![The Stress panel's Set up tab with one support and one load, beside the bracket](../img/stress-bracket.png)

1. Under Inspect, open Analyze and pick Stress. The Set up tab opens.
2. Pick the part under Body. A selected body, or the only one, is picked for you.
3. Under Support 1, press Click faces and click a face that is held, such as the inside of a screw hole.
4. Under Load 1, press Click faces, click the face that is pushed, and type the Force in newtons.
5. Pick a Material, such as PETG, and press Run.

The answer opens in the Results tab, see [Reading the stress result](stress-results.md). The setup is saved with your file.

## Placing supports and loads

Each support and load has four buttons.

1. Click faces: click a face to add all of it. Shift click adds more, Esc stops.
2. Spot: click the body to place a round spot, for a local support or load. Set its Radius, or drag its rim in the view.
3. Use selected faces: takes the faces you already selected in the view.
4. Clear: takes away the row's faces and spots, so you can place it again.

Add support and Add load add more rows. The colours of the rows match the marks in the view. The X at the top right of a row removes it.

While Stress is open, Ctrl+Z and Ctrl+Y undo and redo only your setup, such as a support's faces, a load's force or the material. A note says what was undone. Once you close Stress, they undo the model again.

## Supports

A support is where the part is held. Pick its type in the row.

1. Fixed: held every way.
2. Pinned: for a hole or a pin, held in place but free to turn about its axis.
3. Slider: held against the face, free to slide along it.

## Loads

A load is a Force in newtons or a Pressure in MPa. A new load starts at 100 N.

1. Direction starts at Into the face. You can also pick an axis, such as Down (-Z), or Custom vector and type X, Y, Z.
2. Drag a load's arrow in the view to change its size and direction. It snaps to each axis and to Into the face.
3. Turn on Own weight to add the part's weight, and pick which way is down.

## Material and more options

Material lists PLA, PETG, ABS, ASA, PA12 nylon, PC, aluminium 6061-T6 and steel S235, and starts at PLA. Pick Custom to type your own E, Poisson's ratio, Yield and Density.

More options holds Mesh detail, how finely the part is split into small pieces. It starts at Standard.

| Mesh detail | What it does |
| --- | --- |
| Coarse | Uses one even split, the quickest run. |
| Standard | Splits finer where the stress is high and solves again. |
| Fine | Finds the peak more closely and takes longer. |

Thin walls and small faces get a finer split by themselves. If that would take too long or need too much memory, the run stops and offers one button, such as Run with finer detail (about 20 seconds). Press it to run once with the limit raised. A part too thin for even that run gets no button, the message says which wall is the thinnest. A solid part with a face too narrow for the mesh gets no button either, as a split that fine would not fit in memory, so pick a wider face.

A study that used to warn that a fixed face got too little of the split now tries a finer one first, so its numbers can differ from an older result.

While it runs, the panel shows Analysing… with a Cancel button.

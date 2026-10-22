# Examples

Home lists the examples under **Start here** on a first run, and under **Examples** once you have documents of your own. Each one opens as a new, untitled document named after its card. Nothing is written to disk: change anything you like, and Save asks where to keep your copy. Click the card again for a fresh one.

## Wall bracket

An L bracket screwed to a wall, with a stress study ready to run. Open the Stress panel and run it to see where the bracket bends most, then change `thickness` in the parameters and run it again. See [Stress](../inspect/stress.md).

## Box with a lid

A box and a lid laid flat side by side, ready to print. The lid has a lip that fits inside the box with `clearance` all round, 0.2 mm to start with.

- Change `innerWidth`, `innerDepth` or `innerHeight` and both parts follow, the lid still fits.
- If your printer makes the fit too tight, raise `clearance` to 0.3 or 0.4 and print again.
- `wall`, `floor` and `lipHeight` set how thick the walls are, how thick the bottom and the lid are, and how deep the lip goes.

See [Parameters](../model/parameters.md).

## Capsule holder

A tube and a screw-on cap laid side by side, ready to print. Both threads are modelled, a revolve that climbs one `pitch` each turn, and the cap's thread leaves `clearance` of play on both flanks, 0.25 mm to start with.

- Change `innerDiameter`, `innerLength`, `wall` or `pitch` and both parts follow, the cap still screws on. It is checked from an `innerDiameter` of 14 mm up, a narrower tube can leave the cap's thread cut short, so run Interference after changing it.
- Set `screwedOn` to 1 to put the cap on the tube and see the fit, and back to 0 to lay both out again. Run [Interference](../inspect/interference.md) with it on to check that the parts do not touch.
- If your printer makes the thread too tight, raise `clearance` to 0.3 or 0.4 and print again.
- `threadLength` sets how far the thread runs down the tube. It is kept between 2.5 and 9 pitches and within `innerLength`, a `clearance` under 0.05 is used as 0.05, and the groove is kept to leave 0.4 mm of wall,.

See [Parameters](../model/parameters.md).

## Plate

A plate with four holes, sized by parameters. Change `width`, `depth` or `holeInset` and the holes stay in their corners.

## Pinned lever

A lever on a pin with a stress study ready to run, for a part that turns instead of bending.

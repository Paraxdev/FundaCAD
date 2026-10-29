# Examples

Home shows the examples under **Start here** on a first run, and under **Examples** once you have documents of your own. A card opens its example as a new, untitled document with the card's name.

Nothing is written to disk. Change anything you like, and Save asks where to keep your copy. Click the card again for a fresh one.

## Wall bracket

An L bracket screwed to a wall, with a stress study ready to run.

1. Open the Stress panel and click **Run** to see where the bracket bends most.
2. Change `thickness` in the parameters and run it again.

See [Stress](../inspect/stress.md).

## Box with a lid

A box and a lid laid flat side by side, ready to print. The lid has a lip that fits inside the box with `clearance` all round, 0.2 mm to start with.

- Change `innerWidth`, `innerDepth` or `innerHeight` and both parts follow, the lid still fits.
- If the fit prints too tight, raise `clearance` to 0.3 or 0.4.
- `wall` sets the walls, `floor` the bottom and the lid, `lipHeight` how deep the lip goes.

See [Parameters](../model/parameters.md).

## Capsule holder

A tube and a screw-on cap laid side by side, ready to print. Both threads are modelled, and the cap's thread leaves `clearance` of play on both flanks, 0.25 mm to start with.

- Change `innerDiameter`, `innerLength`, `wall` or `pitch` and both parts follow, the cap still screws on.
- Set `screwedOn` to 1 to put the cap on the tube, and back to 0 to lay both out again.
- If the thread prints too tight, raise `clearance` to 0.3 or 0.4.
- `threadLength` sets how far the thread runs down the tube. It stays between 2.5 and 9 pitches, and within `innerLength`.

With a tube under 20 mm `innerDiameter` or a longer thread, set `screwedOn` to 1 and run [Interference](../inspect/interference.md) to check that the parts do not touch.

See [Parameters](../model/parameters.md).

## Plate

A plate with four holes, sized by parameters. Change `width`, `depth` or `holeInset` and the holes stay in their corners.

## Pinned lever

A lever on a pin with a stress study ready to run, for a part that turns instead of bending. Run it in the Stress panel to see the load around the pin.

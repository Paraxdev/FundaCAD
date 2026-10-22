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

## 3D printer

A printer frame imported from a STEP file, about 100 parts in named groups: Frame, Motion, Bed, Toolhead and Electronics. It takes the same import your own STEP files take, with its colours and its parts tree, so it shows what to expect when you open your own printer.

- Open the Items panel and expand Printer to see the groups. The eye on a group hides every part in it, and Alt+click on an eye shows only that one. See [Items](../model/items.md).
- Turn on a section to look inside the frame. See [Section](../inspect/section.md).
- Click a part to select it and read its size and weight in Properties. See [Properties](../inspect/properties.md).

## Plate

A plate with four holes, sized by parameters. Change `width`, `depth` or `holeInset` and the holes stay in their corners.

## Pinned lever

A lever on a pin with a stress study ready to run, for a part that turns instead of bending.

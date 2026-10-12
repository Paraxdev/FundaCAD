# Your first part

This makes a plate 40 mm by 20 mm and 5 mm thick, with a 6 mm hole, and exports it for your slicer.

**Sketch.** Click New Document, press S and click the XY plane, which lies flat on the floor. Press R and click two opposite corners.

![A rough rectangle drawn on the sketch plane](../img/first-part-rectangle.png)

**Size it.** Press D, click the bottom edge, type 40 and press Enter. Click a side edge and type 20. Press C to draw a circle inside, then D and type 6 for its diameter.

**Make it solid.** Press E, click inside the rectangle but outside the circle, and drag the arrow up or type 5 and press Enter.

![The extrude arrow with the plate previewed](../img/first-part-extrude.png)

**Change your mind.** Click the Extrude step in the History and change 5 to 8. The plate follows. Press F, click an edge and type a radius to round it.

**Save and export.** Ctrl+S saves a `.funda` file that keeps the whole history. Ctrl+E opens the Export window, where STL with Millimeter and Medium suits most slicers.

<!-- shot: first-part-export | Export window set to STL, Medium -->

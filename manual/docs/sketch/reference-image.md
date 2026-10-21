# Reference images

Put a photo or a drawing on a plane and sketch over it. Photograph a broken part on a cutting mat, insert the photo, scale it to a length you know, and redraw the part on top.

Choose Reference Image under Insert, click a base plane, a datum plane or a flat face, and pick a PNG or a JPEG. The image lands 100 mm wide on that plane, half transparent, and gets a row under Reference images in the Items list.

<!-- shot: reference-image | a photo of a bracket under a sketch on XY, calibrated to 100 mm -->

## Scale it to a real size

Click the image's row to open its panel and press Calibrate. Click two points on the image that you know the distance between, for example two marks 100 mm apart on the mat, then type that distance and press Enter. The image scales about the first point, so that point stays where it was. A unit works too: `4 in`.

To set a size without two points, type a width in the panel. The height follows from the picture's own proportions.

## Move, turn and fade it

| In the panel | What it does |
| --- | --- |
| Width | the size, about the centre |
| Angle | turns the image about the plane's normal, in degrees |
| Opacity | how much of the model and the grid shows through |
| Flip X, Flip Y | mirrors a photo taken from the other side |
| Lock | stops moving and calibrating by accident |

Shift drag the selected image to move it along its plane. Each drag, each calibration and each change in the panel is one step of Undo.

A sketch on the same plane draws over the image. The row in Items has an eye to hide the image, a lock and a cross to delete it. The Display popover hides every reference image at once.

## Saving, pictures and exports

The image is saved inside the .funda file, so the file opens with the image on another computer. A version of FundaCAD that does not know reference images still keeps them when it saves the file.

A picture from Render leaves reference images out. Switch on Reference images under Edge lines to have them in it. A path traced picture never has them. Exports to STL, STEP, 3MF and the rest never contain them, an image builds nothing.

## More about

An image on a datum plane follows the datum when the datum moves. An image on a body face keeps the plane the face had when you picked it, so if the face moves later, insert the image again or move it by hand. A row that says image not found means the file was saved without the picture, which happens when a document is downloaded from the browser version.

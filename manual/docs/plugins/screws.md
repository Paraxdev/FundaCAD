# Fasteners

Almost every printed part ends up with a screw in it somewhere. The Fasteners plugin is a library of standard screws, bolts, nuts, washers and heat-set inserts that you can drop into your model. That lets you check that a hole you modelled really fits an M3 screw, and it lets you see an assembly with its hardware in place.

It is on by default. Open it with Fasteners, under Insert on the rail.

## Finding one

The window has two tabs, Catalogue and My fasteners. The Catalogue is a searchable list. Type what you are after into the search box, for example `M4x20`, `socket`, `ISO 7380` or `#10`. The drop-downs beside it narrow the list by kind, by Metric or Inch, by standard, by drive and by head type.

Metric sizes run from M1.6 to M24 and inch sizes from #2 to 1/2, each with the usual standard lengths. You will find socket head, button head and countersunk screws, cross recess screws, hex bolts, set screws, shoulder screws, thumb screws, nuts in several styles, washers, and heat-set inserts for 3D printing.

<!-- shot: fasteners-window | The Fasteners window with an M3 button head screw selected, preview on the right and specs below it -->

Click a row and the window shows a live preview and a table of specs. The table has the thread, the clearance hole and the tap drill hole to use for it, a counterbore or countersink if the head needs one, and the mass of the part in steel.

Under the preview you can change the length, and the drive and thread pitch where the standard offers a choice.

Thread decides how the thread is drawn. Simplified, the default, is a plain cylinder at the full diameter of the thread. It builds fast, and a screw sitting in its nut does not show up as a clash. Modelled helix builds a real thread, which looks right but is slower and much heavier, so keep it for places like a close-up render.

## Putting it in the model

Select one flat face on your model and press Insert on selected face. The fastener goes to the centre of that face with its axis pointing out of it. A screw hangs from the face with its head on it, a countersunk head sits flush, nuts and washers stand on the face, and an insert goes into it. You can also drag a row from the list onto a face, and it lands where you drop it.

With no face selected the button reads Insert at origin, and the part appears at the origin.

An inserted fastener becomes an ordinary body, in the same way an imported STEP part is. You can move it, cut with it and export it. The finished solid is stored inside your document, so the file opens and builds on a computer that does not have this plugin. To see what a fastener is later, right-click its body and choose Fastener Specs.

## Your own fasteners

When the catalogue does not have what you need, choose New fastener on the My fasteners tab, or press Make a custom one from this on a catalogue item to start from it. The form asks for the head type and size, the drive, the thread diameter and pitch, the lengths, and a name. It will not accept a fastener that cannot exist, for example one whose head is narrower than its shank.

Your fasteners show up in the catalogue list with a Custom badge. They are stored with the app on your computer, and Export JSON and Import JSON move them to another computer or to a friend. A fastener you have already inserted lives in the document either way.

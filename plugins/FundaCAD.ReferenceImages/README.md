# Reference Images

A photo or a drawing put on a base plane, a datum plane or a flat face, to
sketch over. The classic use: photograph a broken part on a cutting mat,
insert the photo, calibrate it to a length you know, and redraw the part.

| gesture | what it does |
| --- | --- |
| INSERT, Reference Image | pick a plane or a flat face, then a PNG or a JPEG |
| click a row under Reference images | opens the image's panel: width, angle, opacity, flip, lock |
| Calibrate | click two points on the image, type the real distance; it scales about the first point |
| Shift drag the selected image | moves it along its plane, one undo step |
| the eye, the lock, the cross on a row | hide, lock, delete |

## Grants

`document.read` and `document.write`: an image is an entry in the document's
`referenceImages` list. Nothing else is asked for. The bytes go to the engine's
blob store through the geometry client the app already holds, the same store
imported shapes use, so the file embeds them when it is saved.

## What the app does and what this does

The app carries the list: it keeps every entry whole, unknown fields too,
writes it back on save and puts it on the undo stack. It also has a
"references" overlay kind, so the Display popover can hide every image and a
picture leaves them out unless its Reference images switch is on. Everything
else, what an entry means, the quads, the tools and the panel, is here.

An entry holds the blob hash as a string value (`image`), never as a key, so a
version that does not know reference images still finds the hash and embeds the
blob when it saves. Exports never see the list: it is not part of the document
the engine builds.

An image on a datum plane follows the datum. An image on a face keeps the plane
the face had when it was picked.

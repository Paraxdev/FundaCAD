<!-- The "What's new" section below is also the card Home shows after an update: keep it short and written for makers, one group per bold line, one bullet per change. -->

## What's new since the last beta

**Security**
- A STEP or XBF import no longer reads other files or network locations that the file names.
- More damaged or oversized documents and imports now stop with a clear message, instead of freezing or filling memory or disk.
- Plugins work within firmer limits, and installing a plugin or exporting through one keeps your old file if something goes wrong.
- The assistant connection checks documents more strictly and follows the same save rules everywhere.
- On Windows and Linux, the part of FundaCAD that reads your files runs with fewer rights, so a bad file can do less harm.

**Accessibility**
- Interface size goes from 80 to 200 percent, with a readable text floor and Comfortable text.
- After renaming in Items by keyboard, focus goes back to the row.

**Modeling**
- Moving the camera in Path traced no longer shows black bands or partial pictures.
- Inside a closed model, Automatic projection stays in perspective near an axis, unless you pick a view.
- The fillet preview shows the G2 or G3 shape you picked, the same one Enter builds.
- Zebra stripes follow the surface and show curvature, with a stripe direction and width.
- The tool value box takes parameter names and expressions.
- A modeling step that fails shows its error and the next step runs, instead of the engine restarting.
- Hiding a sketch in Items shows at once.
- The origin plane tiles have four rounded corners and a small gap again.
- A mouse wheel keeps zooming at every Interface size, and Ctrl with the wheel pans the view up and down.

**Stress**
- Stress runs thin walled parts by itself, with no size to set. More options has Mesh detail: Coarse, Standard and Fine.
- While the Stress panel is open, Undo and Redo change only the Stress setup.
- Every support now has a remove button like a load, and supports and loads have Clear to empty their faces.
- A deformation scale below 1 now says it is drawn smaller than true size.

**Assistants**
- AI assistants can list, create, edit and assign render materials, on bodies and on single faces. In the open app each change is one step you can undo.

**Files**
- Big 3MF and SVG files import with less memory.
- A recovered session is cleared once you save it, discard it or choose Don't save.

**Updates**
- Settings, Updates has a channel picker.

**Linux**
- The Flatpak and AppImage now use native Wayland, for sharper text at a fractional display scale.

**After you update**
- In the Flatpak, assistants work in Documents/FundaCAD and ask before using any other path.
- A STEP file that refers to other documents imports without those references, and a note on the import says so.
- A plugin that uses a name another plugin already uses is not loaded, and the plugin list names the plugin that owns it.
- On Linux with a SpaceMouse, unplug it and plug it back in once. If you set it up with setup-spacemouse.sh, run it again.
- If you set Scrolling to Mouse to work around the wheel problem, you can set it back to Automatic.

## Known limits

- If flashing light affects you, stay in Realtime or Matcap. Path traced can still change the whole picture quickly while you move the camera.
- On low powered or software graphics, Path traced is greyed out with the reason.
- With Realtime while moving off, the traced picture can trail the edges for a moment while you drag.
- While you zoom in Path traced, the picture can restart a few times before it settles and show a single brighter frame.
- With the camera inside a solid wall, also while it passes through one, Path traced shows a black picture.
- In the Flatpak, a 3D mouse does not work without setup. See the 3D mouse page of the manual.
- On Ubuntu with the open nouveau Nvidia driver, the Flatpak and AppImage close right after they start on Wayland.
- On Linux, an HDR dropped on the window is not picked up yet. Use Import HDR in the Render panel.
- With more than 128 edges in one fillet or chamfer, the drag stops the size only at the 128 edges nearest the arrow. A size too big for an edge farther away shows as a red preview instead.

## Downloads

Windows: the setup exe or the portable exe. macOS: the dmg. Linux: the AppImage, deb, rpm or Flatpak. The last 20 betas also stay on the releases page as their own versions, with a SHA256SUMS.txt to check the files.

## If you installed an earlier beta

Betas from before 1.0.386 cannot check updates signed with the new key, so install this one by hand once over your current copy. Your files and settings stay.

<!-- The "What's new" section below is also the card Home shows after an update: keep it short and written for makers, one group per bold line, one bullet per change. -->

## What's new since the last beta

**Security**
- Opening a .funda file is safer, damaged or crafted geometry inside it is refused instead of read.
- AI assistants can save only .funda files and export only the format you asked for, and never into folders that start programs.
- A document no longer opens the files it links to by itself, and a network link opens only once you picked it.
- Only FundaCAD's own plugins are shown as official, and that label can no longer be faked.
- Release builds are harder to tamper with.

**Accessibility**
- The tree, toolbars, pickers, lists and the command palette all work by keyboard.
- F6 moves between the main parts of the window, and screen readers can jump between them.
- Shortcuts can be changed, and they no longer fire while you type.
- Text and controls stay readable in every theme, and controls are big enough to hit easily.

**Modeling**
- The origin planes start at the origin and line up with the axis arrows.
- The arrow on a drop-down turns down when the list opens, instead of sliding away.

**Help**
- The manual has a beta and a dev version, with a switch on every page, and its lists are numbered.

**After you update**
- Plugins that start other programs, such as Printing, ask for your OK once more.
- An older document that links to another file through Insert Document says that file "may have changed" until you press Update once.
- A document opened from a .json file is saved with Save As.

## Known limits

- On low powered or software graphics, Path traced is greyed out with the reason.
- With Realtime while moving off, the traced picture can trail the edges for a moment while you drag.
- On Linux, an HDR dropped on the window is not picked up yet. Use Import HDR in the Render panel.
- With more than 128 edges in one fillet or chamfer, the drag stops the size only at the 128 edges nearest the arrow. A size too big for an edge farther away shows as a red preview instead.

## Downloads

Windows: the setup exe or the portable exe. macOS: the dmg. Linux: the AppImage, deb, rpm or Flatpak. The last 10 betas also stay on the releases page as their own versions, with a SHA256SUMS.txt to check the files.

## If you installed an earlier beta

Betas from before 1.0.386 cannot check updates signed with the new key, so install this one by hand once over your current copy. Your files and settings stay.

<!-- The "What's new" section below is also the card Home shows after an update: keep it short and written for makers, one group per bold line, one bullet per change. -->

> ### If you installed an earlier beta, install this one by hand once
>
> The key that signs updates changed with this beta. Betas installed before it cannot check updates signed with the new key, so they cannot update themselves to this one or to later ones. Download the installer for your system below and install it over your current copy. Your files and settings stay. From this beta on, FundaCAD updates itself again.

## What's new since the last beta

**Home**
- A new Home screen: start a blank document, open a file, or pick an example. Your recent files show as cards.
- Home sits on a calm background in the app's glass look. You can switch it to the workspace or your own picture in Preferences.

**Path traced**
- Path traced is lit by the real lights, the room you pick or your own HDR image, and glowing faces light the scene too.
- A Realtime while moving switch: on, you see the quick Realtime view while you orbit or edit, and the trace picks up again when you stop. Off, it always shows the trace.
- Edges, outlines, the grid, the gizmo and the selection stay visible over the traced picture.
- Orthographic views, depth of field and the ground shadow now work in Path traced.
- A graphics driver that stalls no longer freezes the view: Path traced greys out and says why.

**Realtime**
- Filament finishes and eight filament presets in the New material menu.
- A Printed look that draws layer lines.

**Modeling**
- Extrude can make a thin wall from open lines, for ribs, dividers and bins.
- Sketches mark loose ends, and Tie Loose Ends closes small gaps in one step.
- Export a sketch or a flat face as DXF or SVG at true size.
- Reference images: put a photo on a plane and scale it from two points and a distance.
- Threads no longer draw stray lines across the hole, so picking the thread works.
- A join or cut that only worked through a fallback now says so on its feature.

**Files**
- Big .fundab files saved by this version open much faster.
- Files saved by a newer version open, and the parts this version does not know are kept when you save.

**Linux and stability**
- If FundaCAD fails to start twice, it opens in safe mode and tells you why, with a button to restart normally.
- Opening a .funda or .fundab from the file manager opens it in FundaCAD.
- The 3D mouse works through spacenavd without a udev rule.
- Every installer is started and builds a box in CI before a release ships.

**For AI assistants**
- An agent harness and ui tools let assistants drive the real app the way a person would.

## Known limits

- On low powered or software graphics, Path traced is greyed out with the reason.
- With Realtime while moving off, the traced picture can trail the edges for a moment while you drag.

## Downloads

Windows: the setup exe or the portable exe. macOS: the dmg. Linux: the AppImage, deb, rpm or Flatpak.

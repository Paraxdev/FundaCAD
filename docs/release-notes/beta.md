<!-- The "What's new" section below is also the card Home shows after an update: keep it short and written for makers, one group per bold line, one bullet per change. -->

## What's new since the last beta

**Home**
- Example cards show a clear picture slot in dark themes. A template opened from Home no longer replaces a New document or an edit you made while it loaded without asking.

**Modeling**
- Fillets have a third continuity, G3, on key 3. G2 and G3 are greyed out on an edge that runs along a curved face, with the reason. A saved G2 fillet on such an edge no longer builds, so open it and press Enter to keep it as G1.
- A fillet or chamfer that cannot be built right is refused instead of coming out wrong. Some chamfers at a corner where edges meet used to come back 10 to 13 percent too big, with no word.
- Pattern tools lead with Linear and Circular, and bodies get Rect grid as a third choice. Hex Holes is now called Staggered Holes.
- The value box is one compact row with icon options, every option is a Tab stop, and hole type and Press/Pull mode and direction take one click. A number typed there redraws the preview at once, and Enter commits it.
- Letting go of a dragged handle keeps the tool open, so you can still change its options. Enter commits, Esc cancels, and digits you type after a drag are kept. With several edges or faces picked, the handle stands on the last one.
- History, planes, datums and the origin take plain, Ctrl and Shift picks like the body list, and hiding or deleting several at once is one undo step. Pickers number bodies that share a name, so two Box bodies read Box and Box 2.

**Sketch**
- Box select can take sketch profiles, with a choice for them on the box. Ending a sketch clears its alignment guides, and sketch keys keep working after you click a checkbox, slider or button in a panel.

**Inspect**
- In Stress, Click faces takes each whole face for a support or load, and the new Spot button places a local round spot.
- Colours off hides only the stress colours. The bent shape has its own switch, and the weakest spot stays marked. The safety factor reads at least, as in at least 4.5x safe, and Details says whether Standard refined and how far the peak moved.
- The stress colours are drawn on the part itself, with its sharp edges and round fillets, and a big body draws without freezing the window. The solver refines its mesh where the stress is highest, and Refinement in More options picks Standard, Fine or Off.
- Interference tints a clicked pair in violet, and a second click clears it. Printability shows Cancel only while a check runs. Overhang uses the app's select and slider, and says which faces need support.

**Render**
- The Path traced fallback shows as a warning with its full reason, and a finished view with double sided glass no longer restarts on every redraw. A saved environment is highlighted again after a reload, and HDR Rotation and Exposure show their value live.

**Accessibility and themes**
- The app has a new look, with borderless glass, depth from lighter fills and soft shadows, a calm accent without glow, paper cards in light themes and a themed checkbox for settings. The FundaCAD Noir accent is periwinkle instead of mint.
- Picked faces, edges and sketch areas follow the theme accent and keep enough contrast in every view, and a picked edge is drawn wide. Colour-Blind Safe draws the planes, triad and gizmos in vermilion, yellow and sky blue.
- Menus, dialogs, selects and tabs work from the keyboard. Arrows move, Escape closes the top one, and a dialog keeps focus inside and gives it back. Dialogs dim the app behind them when the glass blur is off.

**Files and big models**
- Box select on a big model opens at once. An edit on a big model recolours and saves only the bodies that changed, and a rebuild past 600 ms shows a small Updating chip while the model stays pickable.
- Undo or redo back to the saved state clears the unsaved mark and its crash copy. Nothing from a document you left follows you into the next one, and autosave no longer brings back discarded work.
- Fit and an opened document frame the model between the side panels. Open floating panels stack under the view cube, and the least recently used fold to their headers when space runs out.
- When an AI assistant opens or starts a document, it comes in untitled, so Save cannot write over your file. An assistant's edit made on an older revision is refused, and its changes keep your stress study, environment and materials.

**Settings and help**
- Settings has an Updates section. Turn automatic checks off or pick every launch, daily or weekly. A failed check or install offers the SourceForge mirror.
- With inches as the unit, the grid, its snap and its button step in fractions from 1/64 to 1/2 in, then 1, 2, 5 and 10 in.
- A View menu lists the view commands and analysis toggles, and Zebra, Curvature and Body Colors light on the tool rail while on. Plugins keep one name order and search by name, and Preferences is in the command palette.
- The manual and the app's Help links move to fundacad.dev.

**Linux**
- On a Steam Deck, FundaCAD starts without the renderer that left the window blank, and a window that never paints restarts once without it.

## Known limits

- On low powered or software graphics, Path traced is greyed out with the reason.
- With Realtime while moving off, the traced picture can trail the edges for a moment while you drag.
- On Linux, an HDR dropped on the window is not picked up yet. Use Import HDR in the Render panel.

## Downloads

Windows: the setup exe or the portable exe. macOS: the dmg. Linux: the AppImage, deb, rpm or Flatpak. Each beta also stays on the releases page as its own version, with a SHA256SUMS.txt to check the files.

## If you installed an earlier beta

Betas from before 1.0.386 cannot check updates signed with the new key, so install this one by hand once over your current copy. Your files and settings stay.

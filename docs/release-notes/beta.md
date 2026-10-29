<!-- The "What's new" section below is also the card Home shows after an update: keep it short and written for makers, one group per bold line, one bullet per change. -->

## What's new since the last beta

**Security**
- A zip names each file in two places. Opening a .funda file or installing a plugin now refuses a zip whose two names disagree, a trick that can hide a file from a check.
- The zip, Wasmtime and rustls libraries inside the app move past their published security fixes.

**Big models**
- A big STEP with broken vertices loads whole, with the vertices repaired, and a body with tens of thousands of faces is meshed at a detail the view can draw.
- Box select on a huge model repaints only what changed, so the box follows the pointer smoothly.
- A fillet or chamfer on thousands of edges opens much faster. Past 3,000 edges it asks first and names the count, and past 5,000 it refuses and says why, since a preview that big runs for minutes and can use up all free memory.

**Modeling**
- In the value box, Enter or Space on a button presses that button, so Cancel no longer commits the tool. A refused value says why.
- On a narrow window, each floating panel takes the space it fits, so Parameters and Stress stay open beside the side panel instead of folding under History.

**Accessibility**
- Screen readers hear prompts, selections, build results, errors, saves and exports through one announcer. An error that keeps repeating is said once, and a prompt is cleared once it has been heard.
- Every control has a name of its own, a unit picker is named after its field, such as Width unit, and History steps and tree rows say failed, suppressed or rolled back in words.
- Dialogs, Home, the command palette and Versions keep the app behind them out of reach, and give focus back when they close.
- In Preferences, Accessibility, Animations can follow the system, Announcements sets how much a screen reader hears, and Screen reader preset sets it to Verbose in one click.

**AI assistants and help**
- An AI assistant reads a big model in a fraction of the tokens, since long replies fold alike rows and come a page at a time.
- The manual at fundacad.dev matches the app again, with shorter pages and every picture retaken.

## Known limits

- On low powered or software graphics, Path traced is greyed out with the reason.
- With Realtime while moving off, the traced picture can trail the edges for a moment while you drag.
- On Linux, an HDR dropped on the window is not picked up yet. Use Import HDR in the Render panel.
- With more than 128 edges in one fillet or chamfer, the drag stops the size only at the 128 edges nearest the arrow. A size too big for an edge farther away shows as a red preview instead.

## Downloads

Windows: the setup exe or the portable exe. macOS: the dmg. Linux: the AppImage, deb, rpm or Flatpak. Each beta also stays on the releases page as its own version, with a SHA256SUMS.txt to check the files.

## If you installed an earlier beta

Betas from before 1.0.386 cannot check updates signed with the new key, so install this one by hand once over your current copy. Your files and settings stay.

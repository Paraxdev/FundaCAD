<!-- The "What's new" section below is also the card Home shows after an update: keep it short and written for makers, one group per bold line, one bullet per change. -->

## What's new since the last beta

**Security**
- Opening a .funda file or installing a plugin is safer, a file that tries to hide part of its content is refused.
- Updated dependencies to newer versions to fix vulnerabilities.

**Big models**
- A big STEP assembly with broken parts is now repaired and opens.
- Box select on a huge model follows the pointer smoothly.
- A fillet or chamfer on thousands of edges opens much faster, and a very large one asks first.

**Modeling**
- In the value box, Cancel no longer applies the tool, and a refused value says why.
- On a narrow window, Parameters and Stress stay open beside the side panel.

**Accessibility**
- Screen readers hear prompts, selections, build results, errors, saves and exports.
- Every control has its own name, and History and the tree say in words when a step failed or is turned off.
- Dialogs keep the keyboard inside and give focus back when they close.
- New settings in Preferences, Accessibility: Animations, Announcements and a Screen reader preset.

**AI assistants and help**
- AI assistants read big models with far fewer tokens.
- The manual matches the app again, with shorter pages and newer screenshots.

## Known limits

- On low powered or software graphics, Path traced is greyed out with the reason.
- With Realtime while moving off, the traced picture can trail the edges for a moment while you drag.
- On Linux, an HDR dropped on the window is not picked up yet. Use Import HDR in the Render panel.
- With more than 128 edges in one fillet or chamfer, the drag stops the size only at the 128 edges nearest the arrow. A size too big for an edge farther away shows as a red preview instead.

## Downloads

Windows: the setup exe or the portable exe. macOS: the dmg. Linux: the AppImage, deb, rpm or Flatpak. Each beta also stays on the releases page as its own version, with a SHA256SUMS.txt to check the files.

## If you installed an earlier beta

Betas from before 1.0.386 cannot check updates signed with the new key, so install this one by hand once over your current copy. Your files and settings stay.

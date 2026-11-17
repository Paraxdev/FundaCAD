<!-- The "What's new" section below is also the card Home shows after an update: keep it short and written for makers, one group per bold line, one bullet per change. -->

## What's new since the last beta

**Languages**
- FundaCAD speaks German, French, Spanish, Chinese and Japanese, machine translated. Pick one in Preferences, Appearance, Language, and it applies at once.
- Translated so far: Home, the menu bar, the command palette, the tool rail, Keyboard Shortcuts, Items and History, a step's properties, Undo and Redo, the selection readout, Stress, Preferences, Plugins, the render settings and update notices. The Language card links to the manual's full list.
- The command palette and Keyboard Shortcuts find everything by its translated or its English name.
- In German, French and Spanish, value boxes and expressions show and take a decimal comma. Saved files open the same in every language.
- Your own language file can correct any line or add a language. A file Notepad saved as .json.txt is read too, and a refused file names the line and column where it broke.

**Accessibility**
- Ctrl+1 to Ctrl+7 pick the front, back, left, right, top, bottom and isometric views, and a screen reader hears where the model is seen from once the view settles.
- Tab reaches the 3D view, and a screen reader hears a short summary of the bodies, view and selection. Describe Model in the command search lists every body with its size and position, with Copy as text.
- A running tool such as Mirror, Fillet, Text on face or Stress takes a face or edge from the Geometry list, or the lit one from the brackets and Enter on the 3D view, with no pointer needed.
- Up and Down step the value in Extrude, Press/Pull, Fillet and Chamfer, finer with Shift and ten steps with Page Up or Page Down, and a screen reader hears each new value.
- The shipped plugin panels, from Texture and Parameters to Printing and the 3D mouse settings, work by keyboard and with a screen reader, and a plugin that will not start says why.
- The guide speaks each step as it arrives, with its keys in words.
- Closing a dialog no longer reads the unchanged selection out again, and a key that moves focus out of Items keeps it where it went.

**Modeling**
- Extrude and Press/Pull show the body solid while open, with an outline of what the step adds or takes away.
- Fillet and Chamfer pick their edges on the model before them, and editing one shows that model faint. A click on the fillet's own round or the chamfer's own flat says to pick an edge of the model before it.
- In Fillet and Chamfer, the edge you click wins over a picked edge hidden behind it, and Undo or Redo picks on the new model.
- A fillet or chamfer that is too large says the largest size that fits, in the tool and on its History chip, and that size builds, also for a two distance chamfer, a plate full of holes and a slanted, curved or pointed corner.
- A chamfer on the rim of a round hole cuts the rim, and a chamfer on the four edges of a pyramid tip cuts the tip flat.
- A long helical cut, such as a narrow thread, comes out whole or warns that it may be partly uncut, and a whole one, like the Capsule holder's threads, shows no note.
- Offsetting a sketch outline with a spline in it keeps the copy closed and follows the spline's real curve, or says the distance is too large.
- A number typed with a space, like 12 500,5, gets a hint, and Enter no longer enters only part of it. An expression with a mistake is quoted back as you typed it.
- A Save right after a drag keeps the size the drag shows, and an edit that cannot be built is never written to the file.
- A large model opened again rebuilds as fast as on its first open.
- Fine metric grid steps read in µm.

**Interface**
- The selection readout names every kind you picked, so a face and an edge together read as both.
- In the command search, Ctrl+A selects what you typed, Ctrl+Z no longer undoes a step of the model, and Ctrl+F or Ctrl+K opens it while Move is up.
- Printability says what it checks each time it opens.
- The Stress panel stays in the window with History open, keeps a full height column in a small window, and its weak spot label stays clear of the panels.
- Parameter Setup and Extra Parameters show each parameter once, and every choice in full in a narrow panel.
- Preferences, Experimental groups its settings and lists more limits you can raise.
- If FundaCAD keeps failing to start or closes unexpectedly, it asks whether to start normally, in safe mode or with settings reset, and keeps a copy of the old settings.

**Rendering**
- A traced picture shows its progress in a bar, its button says Cancel render, Escape on the Camera tab cancels it, and a screen reader hears it start and finish.
- The frame rate readout hides when the panels leave it no room.

**Assistants**
- Preferences, AI assistants has a switch, Let AI assistants reach this window. Off, no assistant can reach the window and FundaCAD opens no port for one.
- An assistant that connects while FundaCAD is still opening waits for the window.
- An assistant that inspects a large body or checks its printability again gets its answer at once.

**Help**
- The manual has an Accessibility page and a page on modelling without sight, and Help opens them.
- The manual starts dark, keeps your light or dark choice across the beta and dev manuals, and its animations rest when you ask for reduced motion.
- On Linux, a problem report says whether a screen reader can reach FundaCAD.

**After you update**
- Choosing a view no longer closes the sketch you are drawing.
- An open Extrude or Press/Pull with its value set finishes when you click a face, an edge, the next profile or another tool, with no Accept. In Press/Pull, T now stops at a face.

## Known limits

- Only some parts of FundaCAD are translated so far, the rest stays English, and a machine translated line may read oddly.
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

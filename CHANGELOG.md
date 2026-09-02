# Changelog

What changed in each build, newest first. Everything under **Unreleased**
ships in the next rolling beta, and the release notes on the
[beta release](https://github.com/Paraxdev/fundacad/releases/tag/beta) are
generated from that section.

Older entries still say SindriCAD or Neocad, and are left that way on
purpose: this project began as a fork of the first, shipped for a while under
the second, and those entries describe builds that really were called that.
Rewriting them would misattribute the work and misdate the name.

Builds are versioned `0.1.<build number>` and every green `main` produces one, so
most entries land under Unreleased and stay there until a milestone is worth
naming. To draw that line, rename the heading to `## 0.1.NN (YYYY-MM-DD)` and
open a fresh `## Unreleased` above it. Cutting in the same commit as the last
change is tidiest, but not required: when Unreleased is empty the release job
falls back to the newest named section, so the build carrying a cut still
publishes real notes.

This file starts on 2026-08-03. For anything before that, see the
[commit history](https://github.com/MakerViking/sindricad/commits/main).

## Unreleased

### Fixed

- **A thread whose turns meet exactly can be cut with again.** Draw the section
  as tall as the pitch, so each crest lands on the next root with no flat
  between them, and the solid pinches to a LINE where the turns meet. OCCT
  reports that shape as valid and then quietly does nothing with it: subtracting
  such a thread from a block that should have lost 610.4 mm3 took 0.410, and the
  refusal that followed, "Subtract removed nothing", pointed at the boolean
  rather than at the thread. Welding the turns does not fix it, because the
  overlap between two crests is a lens whose width vanishes with its height and
  the kernel never gets a real intersection to find. Clearance does: the crest
  now stops a thousandth of a millimetre short of the root, ten times the
  measured floor and a thousandth of a printed layer, and the sweep stays one
  clean five-faced solid that cuts to within 0.06% of the hand-computed answer.
  A section genuinely TALLER than its climb is still refused, unchanged.

- **The values panel keeps one place.** It followed the history entry it
  belonged to along the bottom strip, on the argument that the entry's column
  tied the values to the operation. A long history breaks that argument: the
  strip scrolls, so the column slides out from under a panel being typed into,
  two entries a few pixels apart throw the panel across the window, and near the
  left edge it lands over the view controls and has to be lifted off them. It
  holds one berth now, against the right edge above the strip, and only its
  contents change.

- **A right-click on a dimension badge keeps the selection.** A badge sits on
  the geometry it labels, and a line's length badge lands at the midpoint, which
  is exactly where a right-click on that line is aimed. The press replaced the
  whole selection with the single entity under the cursor, so two lines picked
  for a Parallel or Perpendicular constraint were gone before the menu they were
  picked for was built. Only the primary button acts. *(Ported from upstream.)*

- **A pointer moved while a tool owns it no longer paints the model a frame
  later.** Hover was judged when the deferred pass ran rather than when the move
  arrived, so every "click a body / a face / an edge" step that handed the
  pointer back left one face of the model painted under the next step's prompt.

- **An imported mesh is judged body by body, and every part of a 3MF is
  counted.** The face limit was compared against the sum over every body in the
  file, so a two-object slicer project whose bodies are 1,850 and 1,737 faces was
  refused at their total, while either part on its own walked in. It is the
  largest single body now, the refusal names which body, and a separate
  whole-file backstop still stops a file that is too much to draw at once.
  Separately, all the triangle counters read only the first .model part, and in
  the production extension Bambu, Orca and PrusaSlicer write that part is a
  manifest with no triangles in it at all. *(Ported from upstream.)*

- **A SpaceMouse axis that is only leaking from a stronger one is ignored.** A
  puck spills a few counts onto its neighbours under a hard deflection, and once
  that leak clears the absolute deadzone nothing tells it apart from deliberate
  input, so a hard tilt also zoomed. Any axis below a quarter of the strongest
  MAPPED axis of the same frame is dropped; the settings preview runs the same
  filter as the viewport instead of its own copy of the deadzone, a suppressed
  axis dims in the readout, and the fraction is a slider under Deadzone.
  *(Ported from upstream.)*

### Added

- **A boolean asks which body to keep, and then which body to use.** Union,
  Subtract and Intersect took a body selection made beforehand and, failing
  that, put up a list of body names. A list of names is the wrong place to
  answer "which of these two solids": the answer is in the viewport and so is
  the question. Both are asked there now, in the order the operation reads, with
  the body under the cursor lit and the one already spoken for excluded. A
  selection of two or more bodies still commits straight away, because that
  gesture remains the only way to give one boolean several tool bodies.

- **Sizing a thread shows the thread.** It used to show nothing at all: you
  picked a face, a number moved in a box, and the thread appeared when you
  pressed Enter. Now the curve the groove will be cut along is drawn while the
  hand moves, from the same arithmetic the sidecar sweeps along, and the real cut
  arrives once the value settles. Two registers rather than one because a twenty
  turn thread is a real sweep through the kernel: rebuilding it every frame would
  make the drag lurch, and drawing only the curve would leave you guessing
  whether a groove that coarse can be cut at all.

- **A previewed value that cannot be built says so, where you are typing it.**
  Live previews ask the sidecar to build a value before it is committed, and the
  sidecar sometimes refuses: a thread whose turns would run into each other, a
  fillet larger than the edge it sits on. That answer used to go nowhere you were
  looking, so the model went on showing the last thing that did build while the
  boxes read the number that did not. The measures now turn red and carry the
  kernel's own sentence, which names the measurement that is wrong and what to
  change, in the heads-up box for a drag and under the row for a typed value. It
  goes the moment the value becomes buildable again. Every tool that previews
  gets this, not just the one it was built for.
- **A model that is not what the values say is withdrawn to a ghost.** The shape
  and the position stay legible, so a drag through an unbuildable range does not
  take the part away and back several times a second, but the claim that it is
  your part does not. Fainter than see-through, which is a working mode rather
  than a warning.

- **A revolve's sweep is dragged round a curved arrow.** It rides the sweep's own
  circle, at the real radius and in the real plane, and continues from where the
  helix ends: pull it round and the turns pile up, which is how 3600 degrees
  becomes an answer you arrive at rather than one you type. It sits beside the
  straight arrow that sets the pitch, at right angles to it, so neither needs a
  label. Both are still typed into the same two boxes.
- **The curved arrow stops where the geometry would.** Past a full turn, a climb
  shorter than the profile is tall makes each turn run into the last, and the
  sidecar refuses that build. The arrow meets a wall exactly there instead, so
  the limit is found by feel while you ask for it rather than read off an error
  afterwards. Pulling the other way, back below a turn, keeps working. A revolve
  that does not climb at all stops at one turn, since the second would re-sweep
  the solid the first one made.

- **A value typed into Properties shows its result before you commit it.** Type
  1600 into a revolve's angle, stop, and the part turns 1600 degrees while the
  box still has focus; press Enter to keep it, or leave the field and it goes
  back to what the document says. The real feature, rebuilt by the sidecar in
  the timeline position it will occupy, not a drawn approximation of it. A
  preview is not an undo step, so Enter is still what commits. Fields driven by
  an expression are unchanged and still answer on Enter.

### Fixed

- **A dragged handle can no longer disagree with the number beside it.** Typing
  in one of a tool's value boxes freezes it against the cursor, which is what
  stops a moving hand from overwriting a number you meant. A deliberate drag on
  the handle that owns that field now takes it back, so the geometry and the
  readout cannot say two different things.
- **A revolve's pitch arrow stays readable when you look down its axis.** That is
  not an odd view of a thread, it is the view that shows the turns, and the
  arrow collapsed to a blob with no length to read or aim at.

### Changed

- **The app is called FundaCAD.** Neocad is a brand somebody else holds, so the
  product name, the window title, the wordmark, the installer, the bundle
  identifier `dev.fundacad.app` and the repository have all moved. New documents
  save as `.funda`.

  Nothing you already have stops working. `.neocad` and `.sindri` both keep
  opening, permanently and by design: there is no upgrade step that can reach a
  file already sitting on someone's disk, so a name dropped from the read list
  is that person's work refusing to open. Opening a `.neocad` and saving over it
  keeps the `.neocad`; only Save As offers the new name. Every stored setting —
  theme, units, layout, recent files, the SpaceMouse map — is carried forward
  from its old key, and now through a chain of names rather than a single
  fallback, so a value last written two names ago is still found.

  The bundle identifier changing means an installer treats this as a new
  application rather than as an upgrade of the old one.

- **The default palette is Apollo** (lospec.com/palette-list/apollo). The
  previous grey palette is still there under Theme as "Concrete", along with
  Forge, Slate, Moss and Paper. Shape is untouched: a theme here has only ever
  been a repaint.

### Added

- **The Sketch Palette lists what is holding the sketch.** A Relations section
  under the toggles, showing every constraint on the open sketch, what it acts
  on, and its driving value where it has one. Hovering a row lights that
  geometry on the drawing, which is how you tell which two lines "Line 1 and
  Line 3" means; clicking selects them; the cross on the hovered row deletes
  the constraint. Above the list is the degrees-of-freedom count, so "fully
  defined" is a thing you can read rather than a shade of white you have to
  notice. The glyphs on the canvas answer "what is holding this line", and they
  are still there, on the same Show Constraints toggle. The list answers "what
  is holding this sketch", which is the question people actually ask, and no
  glyph pinned to geometry can answer it, because a glyph you cannot find looks
  exactly like a glyph that is not there.

  It also lists the relations nobody drew. Two endpoints at the same position
  compile to one point in the solver, so a chain drawn end to end is genuinely
  joined with no constraint recorded anywhere: the corner holds, and there is
  nothing in the file, on the canvas or in the timeline to say so. Those appear
  as implied, dimmed and dashed and with no delete button, because there is no
  record to delete. Writing coincident constraints for them instead would be
  redundant with the merge, and redundant is exactly what the over-defined
  warning is for.

- **Windows has a portable build.** `Neocad_<version>_x64_portable.zip` on the
  release page: unzip it wherever you like and run `neocad.exe`. Nothing is
  installed, no admin rights are asked for, and several builds can sit beside
  each other, which an installer cannot do. It carries the same files the
  installer lays down, geometry engine included, so the only thing it needs from
  the machine is the WebView2 runtime that Windows 11 and an up-to-date Windows
  10 already have.

  The zip drops one thing the installer keeps: a tree of editor autocompletion
  stubs that arrives with the geometry engine's dependencies and that a headless
  engine never reads. It held every one of the payload's longest file paths, and
  Windows still refuses to create a path over 260 characters, so unzipping into
  anything but a short folder failed. Both staging scripts drop it now, so the
  installed build and the zip stay the same set of files.

  The zip is unpacked FROM the installer rather than assembled separately, so it
  cannot quietly come to hold a different set of files than the installed build.
  Portable means no installer, not no traces: preferences and recent files stay
  in your user profile either way, and the readme inside the zip says so.

- **Revolve can climb while it turns, which is how you make a thread.** Draw the
  thread's cross section in a plane through the axis, set **Pitch** to the
  thread's pitch, and wind **Angle** past 360 for as many turns as the thread is
  long: 3600 for ten turns. Join it to a shank or Cut it out of a bore, whichever
  the thread is. Nothing else about the feature changes, and a revolve with no
  pitch is the flat revolve it always was.

  Pitch is how far one full turn rises, not how far the whole revolve does, so it
  is the number printed on the thread's spec and it stays right however many
  turns are wound on. A negative pitch runs the thread the other way down the
  axis, independently of which way the angle turns.

  Two things it refuses, rather than building quietly and wrongly: a section
  taller along the axis than one turn's climb, where every turn would eat the one
  before, and a section centred on the axis, which gives the climb no side to
  start from. Draw the section so it reaches a little way INTO the part it joins.
  A section that merely touches the surface meets it edge on, and that is the one
  case a union genuinely cannot resolve.

- **The pitch has an arrow on the model, not just a field in a panel.** Edit a
  revolve (double click it, or Edit from its context menu) and the thread's path
  is drawn as a dashed helix with a handle at the far end of it. Pull the handle
  up the axis and the helix stretches; let go and the thread is built. Pitch and
  Angle sit in a box beside it, so a number off a spec can still be typed.

  The handle moves the END of the sweep and writes the PITCH, which are different
  numbers: ten turns rise ten times the pitch, so dragging the end 15mm sets 1.5.
  Dragging past a full turn will not go below a climb the section can fit
  through, because that thread cannot be built, so the arrow simply stops there.
  A typed pitch is left exactly as typed and refused with a reason if it will not
  work, since quietly rewriting a deliberate number is worse than explaining it.

- **The beta release publishes even when there is no signing key.** The build
  that assembles the release used to stop outright unless the in-app updater's
  signing key was set up, so nothing was published at all: no installers, no
  download page, nothing to install. The installers do not need that key, and
  they are what people actually download.

  It now publishes them either way, and holds back only the update manifest,
  which is the one thing an unsigned build must not put out: a manifest points
  installed copies at bundles they would then refuse. The release notes say
  which of the two builds it is, so "does this update itself?" has an answer on
  the page rather than in a build log.

- **Model size is no longer a hard limit on what you can open.** Until now the
  finished geometry had to reach the 3D view as one piece, and there was a
  ceiling on how big that piece could be — about 128 MB. The 356 MB reference
  assembly came in at 95% of it, so a model only a few per cent larger simply
  refused to open, with a message telling you to hide some bodies in a document
  you could not open in the first place.

  The geometry is now sent in pieces and put back together as it arrives, so
  there is no ceiling to hit. Nothing about the models you already have changes —
  the same geometry, drawn the same way — but a document that used to be turned
  away now opens. A single body that is enormous on its own is still refused,
  and that message now tells you which body it is.

- **A large assembly now appears piece by piece instead of all at once.** The
  last stretch of opening a big model used to be one long pause with the
  previous document still on screen. Parts now fill in as they arrive, and the
  view frames the finished model before the first one lands, so the camera
  settles once and stays put while the rest appears. Measured on a 3,000-part
  assembly: it fills in over eight steps rather than arriving in a single jump.
  Picking and tools stay off until it has finished loading, which is when a
  selection would have survived anyway.

- **A very large assembly now opens instead of killing the app.** Importing the
  file worked, but on a 356 MB assembly of about 3,000 parts the app then died
  partway through drawing it, with no message. Two separate causes, both fixed.

  The finished geometry was too big to hand to the 3D view in one piece. Most of
  that turned out to be the model's edge lines, which were being sent as text;
  they are now sent in a compact binary form, about a quarter of the size and
  visually identical. On top of that, a document with more than about a thousand
  parts is now drawn at a slightly coarser level of detail, and above roughly two
  thousand parts coarser again. Curved surfaces on those very large assemblies
  are therefore a little less smooth than on an ordinary document, which is the
  trade that lets them open at all. Documents below that size are drawn exactly
  as before.

  The second cause was the step that works out how big the model is, so the view
  knows where to point the camera. On an assembly this size that single
  calculation took over a minute and a half, long enough that the geometry engine
  was assumed to have hung and was restarted, every time. It now measures the
  model already prepared for drawing, which takes no measurable time at all.

  If a model is still too large to display, SindriCAD now says so and names the
  size, rather than closing the connection to the geometry engine and leaving the
  app looking like it crashed.

- **Large STEP assemblies import.** A STEP file over 256 MB was refused outright,
  which ruled out most real assemblies exported from a full CAD system. STEP,
  STP and BREP files can now be up to 1 GB. Mesh formats keep the old limit on
  purpose: an STL of the same size is a far larger triangle count and a much
  heavier document, so the number that is safe for one is not safe for the other.

  Two things came with it. Before an import starts, SindriCAD works out roughly
  how much memory the file will need and checks that against what your machine
  actually has free. If it will not fit, you get a sentence saying how much is
  needed and how much is available, instead of the app being killed partway
  through and reporting that the geometry engine crashed. And once a large
  assembly is in, SindriCAD tells you what to expect from it rather than letting
  you discover it: above about a thousand bodies the 3D view starts to lag when
  you orbit, and above three thousand it is slow. Everything else, including
  modelling, export and printing, is unaffected at any of those sizes.

- **Exports show that they are running, and can be stopped.** Exporting replays
  your whole feature history, so on a large document it takes as long as an
  import does. Until now it did that with nothing on screen to say so and no way
  to stop it. Both the model export and the print-project export now show
  progress and have a working Stop button.

- **Exporting a STEP assembly keeps its structure.** Opening an assembly kept its
  tree, names and colours; exporting one then flattened all three, so a file you
  could open was a file you could not ship. A STEP export now carries the
  assembly hierarchy, the per-part names, the colours the original file
  carried, and the position of every part, including repeated subassemblies that
  appear in several places. Re-importing your own export gives you back what you
  started with: same parts, same names, same colours, same positions, same face
  count.

  Parts that contain no solid survive the round trip too. They used to vanish on
  the way in; now they make it all the way back out.

  Documents you modelled yourself also carry their body names into the exported
  file, so a part arrives called "Base Plate" rather than "Solid".

  Still not there: 3MF and glTF exports do not yet carry the tree, only STEP
  does, and a subassembly still cannot be renamed.

- **Imported STEP assemblies keep their structure.** A STEP file that contains an
  assembly is no longer flattened into a pile of bodies called Body1, Body2,
  Body3. The Browser now shows the tree the CAD system wrote: subassemblies as
  collapsible groups, parts under them with the names from the file, and each
  part still individually selectable. A product holding several solids, the
  common "M3 Nut (x20)" pattern, stays one named group whose pieces can be picked
  apart. Assembly groups start collapsed, and the eye on a group shows or hides
  everything inside it in one step.

  Two things came out of this that are worth naming. Parts that a file describes
  but that contain no solid used to be dropped without a word; they are kept now,
  so nothing in a file silently fails to arrive. And importing a large assembly
  got substantially faster as a side effect of the rework: on a 356 MB test
  assembly the import went from about 190 seconds to about 99.

  Two limits to be aware of. Subassembly names come from the file and cannot be
  renamed in the Browser, though individual bodies still can. And part colours
  from the file are recorded but not shown on screen, because colour in SindriCAD
  means which filament prints a body.

### Changed

- **Revolve asks for its axis by having you point at one.** Starting a revolve
  used to put up a list reading "X axis / Y axis / Z axis / an edge", in front of
  a viewport that was already drawing three labelled arrows at the origin, and
  answering "an edge" then asked the same question a second time in the viewport.
  Now the arrows are the control: hover lights the one under the cursor, click it
  to spin about it, or click any straight edge on the model instead. The arms
  carry an undrawn hit sleeve about a fingertip wide, because a shaft a pixel and
  a half across is not something anyone can aim at.

- **A revolve is a new body unless you say otherwise.** The second modal, asking
  New Body / Join / Cut before anything had been drawn, is gone. Nearly every
  revolve is a new body, and the Operation row on the feature changes it in one
  click afterwards, with the result on screen to look at while deciding.

- **A very large assembly opens about 40% faster.** Opening the 356 MB,
  3,000-part reference assembly for the first time went from roughly five
  minutes to under three, measured end to end on the same machine. Two things
  accounted for nearly all of it. Extracting the model's edge lines was spending
  almost all of its time on bookkeeping rather than on geometry, and is now
  about eleven times faster. And every surface in the model was being measured
  twice on every open, once to track which feature created it and once to draw
  it; the second measurement now reuses the first. What ends up on screen is
  unchanged: the same parts, the same edges, the same level of detail, down to
  the last point.

  Importing the STEP file itself is not part of that saving and is unchanged.
  That stage is almost entirely inside the geometry kernel, and every setting
  that could shorten it either made no difference or quietly dropped parts of
  the model, which is not a trade worth making. It is also paid only once per
  file: reopening a document you have already imported does not repeat it.

- **Progress while a large model is prepared for drawing now means something.**
  After the feature history finishes rebuilding there is a further stage that
  prepares every part for display, which on a large assembly runs for over two
  minutes. That entire stage showed the word "meshing" with the bar sitting at
  zero and offered no way to stop it. It now counts the parts as it works
  through them, and a Stop button appears for any rebuild long enough to want
  one.

- **Hiding and showing bodies is instant on a large assembly.** Clicking the eye
  next to a body rebuilt the whole 3D scene, which on a 3,000-part assembly
  locked the window up for about two thirds of a second every time. Hiding parts
  is the normal way to work with an assembly that size. Toggling visibility
  changes no geometry, so nothing is rebuilt for it now.

- **Importing an STL or 3MF is faster.** The same bookkeeping problem behind the
  edge-line saving above was also sitting in the mesh import path. A prismatic
  part imports between 1.3 and 6 times faster depending on its size, and the
  resulting model is identical.

- **The geometry cache no longer grows without limit.** SindriCAD keeps prepared
  geometry on disk so that a document you have opened before opens quickly.
  Nothing ever removed the older parts of it, so on a machine used for large
  assemblies it could reach several gigabytes and carry on from there. The cache
  is now given a size budget worked out from the free space on the drive it sits
  on, between 512 MB and 8 GB, and the least recently used entries are dropped
  once that is exceeded. What goes first is whatever is cheapest to recreate, so
  a dropped entry costs a moment of extra work rather than a full rebuild. Saved
  documents are never touched by this. Setting `SINDRI_CACHE_MAX_GB` overrides
  the budget for anyone who wants a specific size.

- **A saved `.sindri` file is now a container, and is much smaller.** Geometry
  used to be written into the document as text, which made files far bigger than
  the geometry in them and meant a part used twice was stored twice. A `.sindri`
  is now an archive holding the document and its geometry separately, with each
  distinct piece of geometry stored once. On the test documents the saved file is
  about a sixth of its former size.

  **Files you already have still open**, and are quietly upgraded to the new
  layout when you save them. The one thing to know before you update: a file
  saved by this build **cannot be opened by an older build of SindriCAD**. If you
  need to move a document back to an older version, keep a copy before saving it
  here.

- **"Each body separately" writes a folder.** Choosing to export each body to its
  own file used to scatter the files next to the name you picked, so choosing
  `parts.step` produced `parts-Body1.step`, `parts-Body2.step` and so on. The
  file the save dialog asked you to confirm overwriting was never actually
  written, which meant it was the only one that could not be overwritten: the
  files that were written replaced any existing ones of the same name without
  asking. The export now creates a folder named after your chosen file and puts
  the parts inside it, and if a folder of that name already exists it stops and
  says so rather than writing over what is in it.

  Body names that a filesystem cannot take are handled properly now too: very
  long names in non-Latin scripts are trimmed to fit, and names that Windows
  reserves, such as a body called "Con" or "Aux", no longer produce an
  unexplained failure on that platform.

- **STL and 3MF exports use one quality setting.** Untextured models took a
  different route out of SindriCAD from textured ones and were tessellated at a
  different setting. Both now use the same export quality. For most shapes the
  result is identical; for a strongly curved one, such as a torus, the exported
  mesh has roughly half as many triangles. The largest deviation from the true
  surface is 0.02 mm either way, which is far below what any printer can
  resolve, so this shows up as a smaller file rather than a visibly coarser part.

### Fixed

- **A drawn line ends where the cursor snapped, to the last digit.** A line's
  endpoint was rebuilt from its own length and angle when it was committed, even
  when neither had been typed, so every point the cursor caught on took a round
  trip out to polar and back, through a division by 180, a multiplication by pi
  and two trigonometric functions. It came back a few parts in a million out: a
  corner placed exactly on a grid intersection was stored as 5.999995816. The
  sketcher's exact reasoning all sits downstream of that. The lattice test
  allows a millionth and rejected it, so the grid half of the
  horizontal/vertical auto-constrain never fired on a drawn line at all and the
  three-degree guess had been carrying the whole feature on its own. Typed
  values are still reconstructed, because a number the user typed is the one
  that has to come true.

- **The last segment of a closed profile can carry a constraint now.** Closing a
  chain skipped the horizontal/vertical inference outright, on the good grounds
  that the closing segment's direction is not chosen, it is whatever is left
  between the two ends already placed, and guessing an intent from it invents
  one. Exactly on an axis is not a guess though, and the skip was the reason a
  closed thread profile came out of the sketcher with no constraint on it
  anywhere while its last segment stood perfectly vertical. It gets the exact
  rules and not the guess: on the lattice, or precisely on an axis, and nothing
  otherwise.

- **A point that lines up with a corner now lands on the grid too.** A guide
  answers one coordinate and the lattice answers either, and the two were never
  asked in the same breath: alignment returned as soon as it had anything to
  say, so the axis it had nothing to say about kept the raw cursor value even
  with a grid line a fraction of a pixel away. A thread profile drawn on a 1mm
  grid closed on a vertex at x = 20 exactly, up the first vertex's column, and
  y = 5.007223063281328, seven microns off a line that was on screen at the
  time and enough to leave the sketch reading 5.01. Both mechanisms were already
  per-axis; they compose now.

- **The snap ring stays the size of a snap ring.** It is a screen-sized marker
  held as world geometry, and its size was written only when the pointer moved,
  so any zoom that arrived without one, a wheel notch, the SpaceMouse, the
  ViewCube, left it at the millimetres it had. Wheeling in on the point it was
  standing on inflated it with everything else: fourteen notches took it from 6
  pixels across to 44, an orange disc sitting over the drawing. It follows the
  camera now, like the grid and the annotations around it. It also goes down
  when the pointer leaves the canvas, rather than staying where the cursor
  happened to exit.

- **No snap ring on empty grid while you are just looking.** With the select
  tool armed there is nothing to place, so a ring on a bare grid intersection
  or an alignment line was advertising a position that no click was going to
  put anything at. Under select it now marks only anchors on real geometry, an
  endpoint, a midpoint, a centre, which are the things a click there grabs.
  Every drawing tool still gets the whole lattice.

- **Sketch annotations are sized for where you are looking, not for the plane's
  origin.** A grid cell, an arrowhead, a dimension's stand-off are pixel
  quantities baked into world geometry, and the mm-per-pixel used to bake them
  was measured at the sketch plane's origin. Under an orthographic camera that
  is as good as anywhere; while a sketch is square to the screen the camera IS
  orthographic, which is why it never showed. Orbit out of the plane and the rig
  turns perspective, where mm-per-pixel falls off with distance, and a profile
  drawn 20mm out from its plane's origin was having its furniture sized for a
  point 20mm behind it, measured at better than 2x wrong on a mild orbit and
  worse the closer you get. It measures at the camera target now, which is what
  the model's own ground grid has always done.

- **Typing an angle at a climbing revolve now changes the revolve.** With the
  pitch arrow open, typing 600 into the angle box redrew the dashed helix and
  left the model as the 360 it was built as, so the number said one thing and the
  shape said another. A typed value now rebuilds the feature in place once the
  typing settles, so the thread on screen is the thread the boxes describe. The
  document is still only written when you press Enter, and dragging the arrow
  still previews with the dashed line rather than a rebuild per frame.

- **A Join that comes back smaller than it started now says what went wrong.**
  A union cannot remove material, so when the result is smaller than the body
  was, the boolean itself has failed, and the reason is almost always that the
  two shapes meet along a surface instead of crossing one another. That case was
  caught, but reported as "the profile is already inside the body", which is the
  one explanation a shrinking union cannot have. It now names the real cause and
  says to move the profile so it reaches into the body.

- **A slot cut into a face now removes material instead of nothing.** A closed
  sketch loop is pushed along the direction its own outline faces, and that
  direction comes from the direction the outline is drawn in. Slots are built
  right-hand side first, which makes them run the opposite way round from every
  other shape, so a slot was extruded out of the back of the plane it was drawn
  on. On a base plane through the origin the part is on both sides of the
  sketch, so the wrong direction still cut something and nothing looked amiss.
  On a face, where the material is on one side only, the same slot cut nothing
  at all and said so with "Cut removed nothing", which reads as a problem with
  the sketch rather than with its direction.

  A row of vent slots in the wall of a housing is the ordinary case, and it did
  not work. Any hand-drawn closed outline traced clockwise had the same
  problem, and now does not either: an outline is turned to face its own plane
  before anything is built from it.

- **An empty document now shows the grid and the origin instead of nothing.**
  With no geometry to frame, the view was pointed away from the scene entirely,
  so a new document looked like a black window with no way to tell what had
  gone wrong. It now settles on a hand-sized view of the origin, which puts the
  ground grid at a legible scale. This was never visible while SindriCAD opened
  on a built-in example part, and appeared as soon as it started empty.

- **Choosing a sketch plane from the Browser no longer disables every tool.**
  Answering "select a plane" by clicking the plane in the Browser tree, rather
  than in the 3D view, left the plane picker running underneath. From then on
  every tool that first checks whether another tool is busy, extrude, fillet,
  shell, press/pull, measure and section among them, did nothing at all when
  clicked, gave no message explaining why, and stayed that way until SindriCAD
  was restarted.

- **The Units dropdown is no longer white with grey text on the dark title
  bar.** Native controls, a dropdown and its popup list among them, are drawn
  by the browser engine rather than by SindriCAD, and they default to the light
  palette however dark the page around them is. The dropdowns are now told to
  use the dark palette, so the closed control, its list and its scrollbars all
  match the rest of the window.

- **The panels no longer paint over the timeline.** In a short window the
  browser, the 3D view and the inspector stretched to the height of whichever
  panel had the most content in it, ran past the bottom of the window, and
  covered the timeline underneath, hiding the buttons in the bottom-left corner
  with nothing to indicate they were still there. The panels are now bounded by
  the space they are given rather than by what is inside them.

- **Leaving a sketch clears its prompt.** The hint line kept telling you to
  click two corners and type a width long after the sketch had closed and the
  toolbar had switched back to solid tools, so the app was asking for something
  it had stopped listening for.

- **Starting a new document, or opening one, no longer leaves the old model on
  screen.** If a rebuild was still running, "New" emptied the document but left
  the previous model in the 3D view, said nothing about it, and hiding the body
  did not remove it, because there was no longer a body in the document to hide.
  On a large assembly the rebuild can run for minutes, and for all of that time
  the app looked broken. Replacing the document now clears the view and stops
  the build that belonged to the old one, so the new document appears straight
  away.

- **SindriCAD opens on an empty canvas.** It used to start by loading a built-in
  example part, so every launch began by building geometry you had not asked
  for, and "New" was the first thing most people pressed. Anything you were
  working on when SindriCAD last closed is still restored as before.


- **Exporting a large assembly now produces a file.** On an assembly of about
  3,000 parts, exporting to STEP wrote nothing at all. The export was working
  fine: it simply takes about a minute to write a file that size, and the
  watchdog that looks for a wedged geometry engine gives up after one minute. So
  the export was killed seconds before it finished, you were told the geometry
  engine had been restarted, and the file you asked for was never created.
  Export now gets a time budget scaled to the size of the document, the way
  import already did. The same assembly exports in about 48 seconds and writes a
  984 MB file.

- **Importing an OBJ file works.** OBJ was listed in both the Open and Import
  file pickers and failed every single time with a raw developer error, because
  the reader underneath only ever accepted STL and 3MF. OBJ files now import
  properly, including ones whose faces are quads or larger polygons.

- **A dense mesh no longer crashes the geometry engine.** Importing a detailed
  scanned or organic STL of around 150,000 triangles killed the geometry engine
  outright after about half a minute. Just below that size it did not crash, but
  it worked for two minutes before reporting that the model was not something
  SindriCAD can edit. Both cases are answered immediately now: the shape of the
  mesh is checked first, and a curved or organic surface that cannot become an
  editable model is refused in well under a second. Meshes that did import
  before are unaffected, including detailed prismatic parts with many holes.

- **A very large assembly now opens every time, and reopens in seconds.** The
  previous build could open a 356 MB assembly of about 3,000 parts, but only
  around two attempts in five. The others failed silently: the model never
  appeared, nothing was written to the log, and the app sat showing the previous
  document with no error to go on.

  The cause was the step that restores a previous build from the on-disk cache.
  On a document that size it took over two minutes, and it ran without reporting
  any progress, so the watchdog that looks for a stuck geometry engine assumed
  the worst and restarted it. That happened before the rebuild had printed
  anything at all, which is why there was never a message to find. The restore
  now reports progress as it works, and the identity check it spent almost all
  of that time on has been replaced with a far cheaper one, so the same step
  finishes in about two seconds.

  Reopening a document of that size went from roughly 48 seconds to under 11.
  Most of the rest of that saving is in the drawing data: on a large assembly it
  is now kept on disk between sessions, where before nearly all of it was thrown
  away and rebuilt from scratch on every open. Opening such a file for the first
  time is unchanged, and still takes a few minutes.

  Two other operations could fail the same silent way on an assembly of this
  size, checking for clashes and running a cut or join against thousands of
  bodies. Both now report progress instead of being mistaken for a hang.
- **The group names under the toolbar are no longer cut in half.** CREATE,
  MODIFY, CONSTRUCT and INSPECT were sitting in a toolbar of fixed height with
  slightly more content than would fit, so the bottom of the lettering was
  simply clipped. How much you lost depended on the font your system draws with,
  which is why it showed up on macOS and on Linux and was easy to miss
  elsewhere. Measured here at 7 pixels of a 13 pixel caption, so a little over
  half. The toolbar now takes the height its contents actually need, on every
  platform and at any window size, and still scrolls sideways when the window is
  too narrow for every tool. Reported from macOS and, separately, as
  [#10](https://github.com/MakerViking/sindricad/issues/10).

- **A circle diameter now takes a typed value even where the constraint solver
  will not start.** On a machine whose WebView2 refuses to run the sketch
  solver, typing a new diameter on a circle did nothing at all: no change, no
  message. Rectangles kept working, which made it look like a problem with
  circles specifically, and that is how it was reported. The cause is that a
  circle's diameter and a line's length are the only two dimensions applied by
  the solver rather than written straight to the shape, so they were the only
  two that vanished when it was missing.

  Both are now applied to the shape directly when there is no solver, and
  SindriCAD says once that it has done so. The dimension is still recorded, so
  it drives the geometry properly as soon as the solver is available, and a
  sketch made this way is no different from one made on a working machine.

  If you see the message about the solver not starting, updating the Microsoft
  Edge WebView2 Runtime is still the real fix: without it, dimensions do not
  hold when other geometry moves.

- **A long export is no longer cut off partway.** Exporting, checking for
  clashes, and projecting geometry each had two minutes to finish, whatever the
  document. A large assembly can legitimately need longer, and the failure fed
  itself: giving up restarted the geometry engine, which discarded the cached
  work, so every retry started from cold and hit the same wall. These now run
  for as long as they are making progress, and are only stopped if the geometry
  engine genuinely gets stuck, which is now noticed in one minute rather than two.

- **Running out of memory says so.** A file too large for the machine's memory
  ended with the operating system killing the geometry engine, which SindriCAD
  could only report as "the geometry kernel crashed". That sent people looking
  for a fault in their model when there was none. The cause is named now, before
  the work starts.

- **Stopping an export is no longer reported as a failure.** Pressing Stop
  produced an error dialog reading "Export failed: cancelled", which is your own
  action handed back to you as a problem. It now just stops.
- **The geometry engine starts on Windows machines whose font folder holds a file
  it cannot read.** Starting SindriCAD could fail outright with "the geometry
  engine could not start on this computer", and the message blamed your
  installation, which was wrong and left nothing to act on. The real cause was
  one file in `C:\Windows\Fonts`. The geometry library scans that folder the
  moment it loads, and a single font it cannot parse took the whole engine down
  with it: either a font collection saved under a plain `.ttf` name, or an old
  bitmap font that is not really a font file at all. Both are ordinary things to
  have on a Windows install, and neither has anything to do with your model. The
  scan now skips a file it cannot read instead of giving up, and names the
  skipped file in the engine log. Reported by four people across four builds.

- **An ordinary mouse is no longer mistaken for a 3D mouse.** SindriCAD looks for
  a 3Dconnexion SpaceMouse at startup, and 3Dconnexion's older devices share a
  manufacturer id with every Logitech mouse and keyboard ever made. On a machine
  where the system does not say what a device is for, SindriCAD trusted that id
  alone, opened whatever it found and fed the result to the camera, so moving an
  ordinary mouse could spin the model. It now asks the device itself what it is
  and ignores anything that does not declare itself a multi-axis controller. A
  real SpaceMouse is unaffected, including models not known by name.

  The list of what was found is also recorded reliably now. It was being gathered
  before the window existed and then thrown away, so a bug report about a 3D
  mouse arrived with no trace of any hardware in it.

- **The AppImage starts on distributions that ship a current WebKit.** It carried its
  own copy of WebKit and the GTK stack around it, and on a system whose own WebKit is
  newer, that bundled copy killed its rendering process the moment the app launched. The
  window opened and stayed blank, with nothing in the log to explain it
  ([#3](https://github.com/MakerViking/sindricad/issues/3)). The AppImage now uses the
  WebKit your distribution ships, the same as the `.deb` and `.rpm` always have, and it
  is about 100 MB smaller for it. **It is no longer fully self-contained:** a system
  without WebKitGTK 4.1 and libsoup 3 installed needs them added first. The
  [Requirements](https://github.com/MakerViking/sindricad#requirements) section of the
  README lists what each build needs, and now carries a confirmed NixOS recipe.

  Thanks to [@boustanihani](https://github.com/boustanihani) for reporting this and
  for sticking with it through several rounds of diagnostics. The detail that
  cracked it came from those reports: the `.deb` worked where the AppImage did
  not, on the same machine and the same build. The fix is confirmed on NixOS
  25.05, and the `appimage-run` configuration it needed came back with that
  confirmation, which is what the README recipe is built from.

- **A window that opens without its interface now says so.** If the app failed to
  load its own page, the result was a blank window and no explanation anywhere.
  The geometry engine logs happily right up to "LISTENING 8765" above it, so the
  log read like an engine fault when it was nothing of the kind, and a report of
  it took days to place ([#3](https://github.com/MakerViking/sindricad/issues/3)).
  The app now waits twelve seconds for the interface to start, and if it has not,
  writes that plainly to `sidecar.log` along with the fact that the geometry
  engine is not the problem. This changes nothing when the app starts normally.

- **SindriCAD starts on machines with Nvidia graphics.** On Linux with the Nvidia
  driver, the window process could crash inside the driver the moment the app
  launched, before anything was drawn, so SindriCAD quit with no window and no
  message at all ([#6](https://github.com/MakerViking/sindricad/issues/6)). The
  crash comes from one specific way WebKit hands rendered frames to the window,
  and that path is now switched off when an Nvidia driver is present. Other
  graphics drivers are unaffected and keep it. The 3D viewport is still drawn by
  the GPU, but frames take a slower route to the window without it, so a heavy
  model may not feel quite as smooth on Nvidia as it otherwise would. If your
  machine does not need the fix, starting SindriCAD with
  `SINDRICAD_NO_GPU_WORKAROUND=1` leaves the setting untouched.

- **A model too large for the geometry engine now says so, instead of looking
  like a broken connection.** Opening a very large file could produce a model
  bigger than the geometry engine accepts in one message. The engine responded by
  closing the connection, and because the oversized body stayed in the document,
  every following rebuild closed it again, so the app sat there reporting
  "geometry engine connection lost" with no hint that the file was the problem
  ([#4](https://github.com/MakerViking/sindricad/issues/4)). The size is now
  checked before anything is sent, and the message names both the size of the
  model and the limit. That limit is on a single message rather than on the file
  you opened, and it is a different one from the import size described above.
  Now that geometry no longer travels inside the document, a model is much less
  likely to reach it.

- **A second copy of SindriCAD no longer breaks the first one's geometry engine.**
  Opening the app twice started two engines, and the second could not take the
  port the first was already using, so it died and the app reported "The geometry
  engine crashed (exit code 1)" with nothing pointing at the real cause. Launching
  SindriCAD again now brings the window you already have to the front instead of
  starting a second copy. If the port is unavailable for any other reason, the
  message now names the port and says what to do about it rather than blaming the
  geometry engine.

- **The geometry engine starts on NixOS, and anywhere else PYTHONHOME is set.**
  Running the AppImage through `appimage-run` exports `PYTHONHOME` pointing at
  the AppDir, and the bundled interpreter inherited it, went looking for its
  standard library in the wrong place and died with "No module named 'encodings'"
  before running a line. The app then opened with a dead engine
  ([#3](https://github.com/MakerViking/sindricad/issues/3)). The sidecar is now
  started with `PYTHONHOME` cleared, since the bundled runtime works out its own
  location. Packages installed with `pip install --user` are also kept off its
  path now, so a mismatched numpy in a home directory can no longer shadow the
  bundled one.
- **An engine crash now says how it died.** The message read only "The geometry
  engine crashed", and the exit status went to standard error, which a packaged
  build discards. So it never reached `sidecar.log`, the file a bug report
  attaches, and a report of a crash could not distinguish a fault in the geometry
  kernel from the system killing the process for using too much memory. On Linux
  and macOS the status is `None` for every signal death, which is precisely those
  two cases. The crash and its signal are now written to `sidecar.log`, and the
  message names the cause ("killed by SIGSEGV (11) — geometry kernel fault"), so
  even a screenshot of it is enough to triage from.
- **A bug reported from inside the sketcher now carries the sketch.** An open
  sketch lives in the sketch session, not in the document, until you finish it,
  and the report attached the document. So a report filed while sketching
  carried a stale sketch, or an entirely empty document when the sketch was the
  first thing in the file, which is what happened to a dimension report on
  2026-08-02. Reports now include the sketch as it stands, and say that one was
  open, how much was in it, and whether it was new or an edit. That last part is
  recorded even when the document is not attached, since it tells you the repro
  starts by opening a sketch.

## 0.1.81 (2026-08-03)

### Changed

- **Waves is its own texture kind.** Faceted `waves` and `ribs` were producing
  byte-identical geometry: both height functions returned the same trapezoid, so
  a relief the UI names and stores separately drew exactly the other one. Faceted
  waves is now a sine polyline with eight joins per period, a rounded undulation
  against ribs' flat-topped prisms. **Existing waves documents rebuild and change
  shape.** Waves under the faceted profile takes no Land/Sharp parameter, and the
  texture panel hides that field rather than showing a control that does nothing.
- **README reorganized.** It read as Linux-only in three places and buried the
  installers two thirds of the way down. There is now a "Get it" section near the
  top, a section nav bar, per-platform install steps folded into collapsible
  blocks, and the architecture notes moved down with the other reference
  material. Offset Face, Thicken and BREP import were missing from the feature
  list and have been added.

### Added

- **Dimensions can be deleted.** Right-click a dimension for "Delete dimension",
  or select one and press Delete. Dimensional constraints draw as value badges
  rather than constraint glyphs, and the glyph click was the only delete path, so
  an unwanted or duplicated dimension used to be permanent unless you deleted the
  geometry under it. A circle's diameter badge is a property of the circle rather
  than a constraint, so it offers the action disabled instead of silently doing
  nothing.

### Fixed

- **A sketch made on a face now shares the model's grid.** The sketch plane was
  anchored on the face's own centroid, which is derived from the mesh and snaps
  to the nearest triangle centre, so it sat an arbitrary fraction of a millimetre
  off. Grid snapping rounds in plane-local coordinates, which gave every
  sketch-on-face a lattice of its own: draw one sketch snapped to the grid,
  extrude it, sketch on the new face, and the first sketch's centre was no longer
  on grid. The origin is now the global origin projected onto the face's plane,
  the same rule offset and datum planes already used, so every plane parallel to
  a base plane shares one grid. Existing documents are unaffected, since a
  sketch's plane is stored explicitly and never recomputed.
- **Dimensions can be edited without leaving the dimension tool.** The tool
  re-arms after every commit so you can dimension a whole sketch in one go, but
  labels and constraint glyphs only accepted clicks in the select tool. Anyone
  who finished dimensioning and tried to correct a value found every label inert,
  with no cursor change to explain why. Labels and glyphs are now live in the
  dimension tool as well, and dimensioning still wins the clicks it needs: a
  click that lands on geometry, or one made while a dimension is part-placed,
  goes to the tool rather than the label.
- **Double-clicking a dimension always opens its editor.** A label that sits on
  top of the geometry it measures used to lose every click to the pick
  underneath, which could leave it permanently uneditable.
- **"Open in OrcaSlicer" now works on Windows and macOS.** The default slicer
  path had no per-platform branching, so every install pointed at a Linux
  AppImage under the user's home directory. On Windows and macOS that file
  cannot exist, and since nothing in the UI writes a settings file, the default
  was the only value and the handoff was dead. SindriCAD now looks in the usual
  install locations per platform and picks the first that exists. Orca's preset
  directory was wrong in the same way and follows the same rule.
- User presets are recognised on Windows again. The check for "is this the
  user's own preset" matched the substring `/user/`, which no Windows path
  contains, so user presets were treated as system ones and lost their
  preference during preset selection.
- The texture documentation claimed every pattern closes on itself at any angle.
  Ribs and waves do; the 2D lattices (knurl, hexagon) close only at multiples of
  90 degrees, which is a property of the geometry rather than a bug.

### Security

- **postcss 8.5.15 to 8.5.25** ([GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849),
  high). A crafted `sourceMappingURL` comment could walk out of its directory and
  disclose the contents of any `.map` file on the machine running the build. This
  is a build-time dependency and the build parses no untrusted CSS, so shipped
  applications were never exposed.

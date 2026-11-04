# Accessibility smoke test

FundaCAD has to work with NVDA on Windows, VoiceOver on macOS and Orca on Linux. CI reads the page and each
platform's accessibility tree on every push (see [What CI checks](#what-ci-checks)), but no job can listen to a
screen reader. This page is the hand check a person runs before each release: about thirty six minutes per screen
reader, the same nineteen steps everywhere, and a results table that keeps what was heard.

## What CI checks

| Check | Where | Red when |
| --- | --- | --- |
| axe-core 4.10.2 (WCAG 2.0, 2.1 and 2.2, A and AA) over Home, the empty workspace, an open example, Sketch, Extrude, Settings, Render, Stress, the command palette and a confirm dialog | `e2e` job, step "Accessibility smoke (axe and aria snapshots)", `tools/harness/tests/browser/test_a11y.py` | a rule finds more nodes on a screen than `tools/harness/tests/browser/axe_baseline.json` allows, or a rule the baseline does not list for that screen finds any |
| Aria snapshots of the shell, Home, Settings and the command palette (`fil` typed and ArrowDown pressed: the combobox, its named listbox, Fillet with its group and key, and the active match selected) | the same step, partial templates in `tools/harness/tests/browser/aria/` | a landmark, role or name a template holds is gone or renamed |
| The Items tree and History by keys alone: Tab reaches one row or step, arrows walk them, Space selects, F2 renames, Shift+F10 opens the menu, Alt and an arrow move a step, the Rollback slider names the step it sits after | the same step, `tools/harness/tests/browser/test_items_tree_keys.py` and `test_history_keys.py` | a key stops working, focus leaves the row or step, or a role, name, level, state or value text the tests read changes |
| Drawing by keys: a 40 by 20 plate with a 10 mm hole from Items to Extrude with no pointer event, a closed slanted line chain by `@dx,dy` and a second document that starts clean, Tab to a midpoint, arrows moving the cursor in Rectangle and turning the view in Select and when the plane is edge-on, in both camera rigs | the same step, `tools/harness/tests/browser/test_sketch_keys.py` | a pointer event reaches the page, a point or snap is not spoken, a shape comes out different from the keys typed, Tab does not reach a profile with a hole, or an arrow turns the view in a draw tool or stops turning it elsewhere |
| The Geometry tab by keys alone: Tab reaches one row, arrows walk and turn pages, Enter, Space and the runs pick, `]` and `[` step on the 3D view, two edges take a fillet, a sketch starts on a face and on a plane, Section, Mirror, Press/Pull and a joint take a row while they wait, and axe walks the tab | the same step, `tools/harness/tests/browser/test_geometry_browser.py`, `test_geometry_commands.py`, `test_geometry_planes.py` and `test_geometry_row_pickers.py` | a key stops working, focus leaves the list, the selection differs from a click's, or a role, name or spoken word the tests read changes. None of this listens to a screen reader, see step 10 |
| The sketch palette's lists by keys alone: a length typed in its row under Dimensions drives the line and says the new freedom, the constraint it made is deleted from its Relations row with Delete and the app says so, entering a second sketch says nothing, no pointer event reaches the page | the same step, `tools/harness/tests/browser/test_sketch_lists.py` | a pointer event reaches the page, a row has no name or a Delete button is not named by its rule, a freedom change is not spoken or entry speaks one, or the palette has an axe violation above the `sketch` baseline |
| Pointer targets: at least 24 by 24 CSS px, about 32 with Larger click targets, with no layout change | the same step, `tools/harness/tests/browser/test_targets.py`; the token and hit area guard is `tests/ui/hitTargets.test.ts` in the `test` job | a control on a screen above hits under 24 px either way, a grown area takes another control's centre or the edge of its own box, Larger click targets leaves one under 32 px on the shell, Home, an example, Sketch, Settings, the palette or a confirm (bar the spacing exceptions the test names with their reason), or turning it on moves a control or changes a scroll size |
| Icon only controls have a name, and every number field a unit | `node scripts/check-ui-controls.mjs` in the `test` job, and `tests/ui/designSpec.test.ts` | an `IconButton` with no `tip`, a `RailButton` with no `label`, or an icon only `Segmented` option with no `label` or `tip`, and no `aria-label` or `aria-labelledby` either, or a `NumberField` with no `unit`, `caption` or `unitless` |
| Size and text: Interface size 150 and 200 percent, Comfortable text, the 11 px floor | `e2e` job, step "Agent harness smoke set", `tools/harness/tests/browser/test_size.py`, `test_reach.py`, `test_text_size.py` and `test_bottom_row.py`; the font size guard `node scripts/check-font-sizes.mjs` in the `test` job | a control is clipped, covered or out of the Tab walk at 150 percent in 1366 by 768, at 200 percent in 1280 by 800 or in 800 by 600, rendered text is under 11 px, Comfortable text cuts a base control's label, the frame rate chip overlaps the hint card or a rail card, or a font size is set outside the `--fs-*` tokens |
| Linux: the AppImage's AT-SPI tree, what Orca reads | `bundle` job, ubuntu-22.04 leg, step "Dump the AppImage accessibility tree over AT-SPI", `scripts/a11y/atspi_dump.py` | a showing push button, toggle button, menu button or menu item has no name, or the app has no web document |
| Windows: the exe's UI Automation tree, what NVDA and Narrator read | `bundle` job, windows-latest leg, step "Walk the exe window over UI Automation", `scripts/a11y/uia_walk.ps1` | an on screen Button, SplitButton or MenuItem has no name, there is no Document, or the Document holds no named Button after 120 s |
| macOS: the AX tree, what VoiceOver reads | nowhere, by hand only | the hosted macOS runners cannot grant a process the Accessibility permission, so no script can read another app's AX tree there |

Every run uploads what it read, so a red step can be read without a rerun: `a11y-smoke` (axe results and full aria
snapshots per screen, plus the harness logs), `atspi-dump` (every app on the bus with its tree) and `uia-walk`. The
checkers of the two OS walks have their own tests on fake trees in the `test` job: `tests/build/test_atspi_dump.py`
and `tests/build/test_uia_walk.ps1`.

### How the ratchets work

The checks start from what the app does today and may only get stricter.

- The axe baseline is a count per screen and rule. A count above the baseline, or a rule it does not list, fails. A
  count below it only prints a note, since Linux Chrome in CI can count lower than Windows Chrome, where the baseline
  was seeded. After a fix lowers a count, rewrite the baseline with
  `FUNDACAD_AXE_LOWER=1 python -m pytest tools/harness/tests -m a11y` and commit it with the fix. That mode lowers
  counts and drops rules that reached zero, it never raises a count or adds a rule.
- The aria templates are partial: they hold only stable landmarks, roles and names, and any other node may come and
  go. A change that means to rename a role or a landmark (the menu bar becoming a `menubar`, panel titles becoming
  headings) updates the template in the same commit.
- The UI guard counts every `IconButton:no-name`, `RailButton:no-name`, `Segmented:no-name` and
  `NumberField:no-unit` against `scripts/ui-controls-allow.json`. Only the last has entries today, the screw,
  extra parameter and printability plugin fields, so any other new one fails. Lower an entry with
  `node scripts/check-ui-controls.mjs --lower`, never raise one.
- The AT-SPI and UI Automation walks have no baseline: one nameless button fails them.

All of these steps start as `continue-on-error`, because the first runs on a real bus and a real WebView2 are also
the spike that shows what the trees hold. They become required once the first accessibility wave has landed (the
announcer, names on the base controls, dialogs that hide the page behind them and the Accessibility settings) and
each step has run green on dev: delete the `continue-on-error: true` line from the step, so its job goes red.

Run the browser part locally like the rest of the harness smoke set ([HARNESS.md](HARNESS.md)):

```sh
python -m pytest tools/harness/tests -m a11y -q
```

`FUNDACAD_A11Y_OUT` names the folder that gets `axe_<screen>.json` and `aria_<screen>.yml`.

## Before you start

- Test the build you are about to ship, installed the way users install it: the installer or portable exe on
  Windows, the `.dmg` on macOS, and on Linux the Flatpak, the `.deb` and the AppImage.
- Start the screen reader with its default settings, speech on, key echo on.
- Keep Home on at startup (the default) and start with no document open.
- Write down the versions the results table asks for before you begin, they are what a regression is traced to.
- On macOS read Ctrl as Cmd in every step below.

| Key | NVDA | VoiceOver | Orca |
| --- | --- | --- | --- |
| Start and stop | Ctrl+Alt+N | Cmd+F5 | Super+Alt+S on GNOME |
| Modifier | Insert or Caps Lock | VO is Control+Option | Insert or Caps Lock |
| Next landmark | D | VO+U, then the Landmarks rotor | M |
| Browse and focus | NVDA+Space | no modes | Orca+A |
| Read the focus | NVDA+Tab | VO+F3 | KP Enter, or Orca+Enter on a laptop |
| Activate | Enter or Space | VO+Space | Enter or Space |

### Linux

WebKitGTK 4.1 on GTK 3 is the least proven of the three webviews, so Linux gets the most care.

- Run the script in a Wayland session and in an X11 session. The Flatpak, the AppImage and the `.deb` run on
  native Wayland and fall back to X11 where the session has no Wayland, so Orca reads a different backend in each.
  Step 8 is there for that: check key echo and caret tracking in a text field on both sessions.
- Run it from the Flatpak and from the `.deb`, and from the AppImage when time allows. GNOME is the baseline desktop,
  KDE Plasma a second one.
- Find the versions with `orca --version`, `echo $XDG_SESSION_TYPE`, `dpkg -s libwebkit2gtk-4.1-0 | grep Version`
  (or `rpm -q webkit2gtk4.1` on Fedora) and `flatpak info dev.fundacad.app` for the Flatpak's runtime.
- If Orca says nothing at all, check that the accessibility bus is up
  (`gsettings get org.gnome.desktop.interface toolkit-accessibility` should say `true`) before calling it a FundaCAD
  bug, and attach the `atspi-dump` artifact of the same commit to the report.

## The script

Each step says what to do and what you should hear. Mark it in the results: **P** heard as described, **S** silent,
**W** wrong or confusing (write what was said), **n/a** could not be done.

1. **Start (1 min).** Start FundaCAD. You hear the window title, then the Home dialog by name ("Home, dialog"), with
   focus inside it. Tab walks Blank, each example with its caption, and "Show Home on startup, checkbox, checked".
   Fail: silence, an unnamed "document" or "frame", or focus left on the page behind the dialog.
2. **Open a file (1 min).** Tab to "Box with a lid" and press Enter. Home closes, focus lands on a named control in
   the workspace, and the window title now names the document. Press Ctrl+O: the system file dialog speaks as it
   does in any app, and Escape brings focus back where it was.
3. **Find your way (2 min).** Step through the landmarks. You hear a banner, a navigation with the menu bar (File,
   Edit, View, Help), a navigation named "Tools", a complementary region with Items, and a region named "History".
   Move to File and press Enter: the menu opens and arrow keys read each item with its shortcut. Escape closes it and
   focus is back on File.
4. **Add a feature (1 min).** Press Ctrl+K: you hear "Command palette, dialog". Type `primitive` and press Enter. The
   "Create primitive" list reads Box, Cylinder, Cone, Sphere and Torus with their hints. Press Enter on Box. You hear
   that a Box was added, or at least find it as the last entry in History.
5. **Hear the prompt (1 min).** Press F for Fillet. The prompt "Click an edge to fillet" is spoken without focus
   moving. Press Escape: the tool ends and focus returns to where it was.
6. **Hear the error (1 min).** Press Ctrl+K, type `parameters`, press Enter. Tab to the expression of innerWidth,
   type `nope` and press Enter. The field refuses it: you hear it marked invalid and hear the reason. Escape closes
   Parameters and focus returns. Then open an Extrude's properties, type `0` in Distance and press Enter: you hear
   the reason. Press Shift+Tab and Tab back: you hear the name, the value, millimetres, invalid and the reason. A
   selection row's button reads its label, its count and Edit, a file row's button its label and Choose.
7. **Settings and a confirm dialog (2 min).** Press Ctrl+, (comma): "Preferences, dialog". You hear the category
   navigation, the Theme combobox with its value and the Units radio group with "mm, checked". Done closes it. Press
   Ctrl+N: the app asks before it drops your unsaved Box. You hear the question and the focused button. Escape keeps
   the document and focus returns.
8. **Type in a field (1 min).** In the palette search (Ctrl+K), type `extrude`. Each letter is echoed, Left and Right
   read the character under the caret, and the list of matches is reachable and read. Escape closes the palette.
9. **Walk the Items tree (2 min).** With "Box with a lid" open, Tab from the Items filter: you hear "Items, tree" and
   a row with its name, state, level and position ("Origin, expanded, level 1" and "1 of" the count). Down and Up walk
   the rows, Right opens a folder, Left closes it or goes to its parent. Reach Body1: Space reads it selected. F2
   reads the rename field, type `Lid` and press Enter: focus is back on the row, now read as Lid. Shift+F10 opens its
   menu, Hide hides it, and the row now reads hidden. Escape from the menu returns to the row. Typing a letter jumps
   to the next row that starts with it. Fail: a row read without its level or position, a menu that leaves focus
   nowhere, or Space moving the view instead of selecting.
10. **Pick faces and edges by keys (3 min).** This step has not been run with NVDA, VoiceOver or Orca, so nothing here
    is known to work yet: write down what you hear, it is the first record. Bring Lid back from its row's menu
    (Shift+F10). Press Ctrl+K, type `browse` and press Enter: focus lands on a row of a list box named "Faces of Lid".
    NVDA and Orca should go to focus mode by themselves: write down whether they did. Each row is read with its type,
    size, facing, body and feature, such as "Flat face 1, 60 by 40 millimetres, 2400 square millimetres, facing up, at
    height 37 millimetres, Lid, from Extrude 1", and its place in the count. Down and Up walk the rows, Enter selects,
    Escape says "Nothing selected" and focus stays. Shift+Tab to What to list and choose Edges, Tab back to the list,
    press Enter on one edge and Space on another: you hear the second added and "2 selected". Press Ctrl+K, type
    `fillet`, press Enter, type `1` and press Enter: History gains a Fillet. Ctrl+Z takes it back. List the faces again,
    press Enter on a face read as facing up, press Ctrl+K, type `sketch` and press Enter: a sketch opens on that face.
    Leave it and press Ctrl+Z until History is as it was. Press F6 until you hear "3D view". Leave browse mode or focus
    mode as it is and press `]` then `[`: each is read as a row in the same words, and nothing is selected. Then
    switch modes and try again (VoiceOver has none): write down which mode lets the brackets through. Press Enter on a lit row: that row is
    selected, not whatever sits at the centre of the view. Space adds another, Escape says "Nothing selected". Fail: a
    row read without its type, size, facing or body, a bracket that speaks nothing in both modes, or Enter picking
    something other than the lit row.
11. **Walk History (2 min).** Tab to the Rollback slider in History: you hear "Rollback, slider" with the step it sits
    after ("after" the last step's name, "step 4 of 4"). Left arrow rolls back one step and reads the new step. Tab
    reaches the steps list: one step, read with its name, kind, place and state ("rolled back", "failed", "warning",
    "suppressed", "selected"), and "current step" on the one the model is rolled to. Left and Right walk the steps,
    Enter opens a step's values (Tab reaches them), Shift+F10 opens its menu, Alt+Left moves it before its neighbour
    and you hear where it went. Fail: steps read without a state, focus lost after a move, or the slider read as a
    bare number.
12. **Hear the count and the command (1 min).** Press Ctrl+K and type `fil`. After a short pause you hear how many
   commands match and the first of them, "4 commands. Fillet, Modify, F", once, not once per letter. Press
   ArrowDown: focus stays in the search field and you hear the second match with its group, "Vertical Edge Fillet,
   Print" (NVDA may add "2 of 4"). Press ArrowUp: "Fillet, Modify, F", the first match with its group and
   shortcut. Type more letters until nothing matches: "No matching command". Press Escape: the palette closes
   and no count follows. Fail: silence on an arrow, a count per letter, or a count after Escape. Orca follows
   the active match through `aria-activedescendant`, the weakest of the three readers here: write down whether
   every arrow was read.
13. **Pick from a list (1 min).** Press Ctrl+, (comma) and Tab to Theme. You hear its name and its value together,
    "Theme, FundaCAD Noir" (or the theme in use), as a combobox or pop up button, on VoiceOver and Orca as well
    as NVDA. ArrowDown opens the list, read as "Theme", and each arrow reads one theme. Enter picks it, the list
    closes and the trigger reads the new value. Escape closes Preferences.
14. **Pick a material and an environment (2 min).** Press Ctrl+K, type `materials` and press Enter: the Render
    dock opens. Tab into the material library: you hear "Material library, list box" and one tile by name and
    finish ("Gold, Satin, metallic"), and the next Tab leaves the grid. The arrows move from tile to tile in rows
    and columns without changing the model, and a letter jumps to the next tile starting with it. Space selects or
    deselects the focused tile, Ctrl+A selects them all, and Enter applies the focused tile as a double click
    does. Open the Environment tab: Studio is one Tab stop too ("Environment, list box", then "Studio, Neutral
    room, even light"), and Space or Enter puts the focused one in use. Fail: a Tab stop per tile, an arrow that
    also turns the view, or a tile read without its selected state.
15. **Change the size (2 min).** Press Ctrl+Plus twice (Cmd+Plus on a Mac): you hear "Interface size 110 percent",
    then "Interface size 125 percent", once per press, and focus stays where it was. Ctrl+0 says "Interface size 100
    percent". Press Ctrl+, (comma) and Tab to Interface size: you hear "Interface size, 100%" as a combobox or pop up
    button, and its hint naming the keys. Tab on: "Comfortable text, checkbox, not checked" with its hint, then the
    "Viewport labels" radio group with "Medium, checked". Pick 200% and press Escape. Shrink the window as far as
    it goes and Tab through the tool rail: each tool is read as it scrolls into view. Open File: its first rows read
    "Model Workspace" and "Render Workspace" as checkable menu items, one of them checked, and the window title still
    names the document. Quit and start FundaCAD again: it opens at 200 percent, with no frame at 100 first. Ctrl+0
    puts the size back. Fail: a size not spoken, or spoken twice per press, a control Tab reaches but nothing reads, a
    workspace row read without its checked state, or a restart that opens at 100 percent or shows it first.

16. **Draw by keys (3 min).** With a new document open, press F6 until you hear the Items panel, Tab to "Items, tree",
    arrow to "XY plane" and press Enter: you hear "Sketch mode". Press R, type `5`, Tab, `-7`, Enter: you hear "Point at
    5, minus 7". Type `40`, Tab, `20`, Enter: you hear "Rectangle 1, 40 by 20". Press C, type `25`, Tab, `3`, Enter, then
    `10` and Enter: you hear the point and "Circle 1, diameter 10". Press an arrow with Rectangle armed: you hear "Cursor
    at" and the view does not turn. Press E and Tab: you hear "Profile 1 of 2, area 721.59 mm squared, 1 hole". Enter,
    `8`, Enter: you hear "Built, 1 body". This is one way to draw among others. Fail: a point or shape that is not
    spoken, an arrow that turns the view while a draw tool is armed, or a Tab that skips a profile.

17. **Hear undo and a message (2 min).** Open "Box with a lid", select a step in the Items tree and press Delete: you
    hear "Deleted" and the step's name once, with an Undo button on the message. Press Ctrl+Z: you hear "Undid Delete"
    and the step's name. Press Ctrl+Y: you hear "Redid Delete" and the name. Press Ctrl+K, type `last message` and press
    Enter: the newest message is said again. In a new document press Ctrl+Z: you hear "Nothing to undo". Open
    Preferences, set Notification time to Until dismissed and delete a step again: the message stays past ten seconds
    until you dismiss it. Fail: a message that is not spoken or is spoken twice, an undo that says only "Undo", or a
    message that goes while the setting is Until dismissed.

18. **Read results (3 min).** This step has not been run with NVDA, VoiceOver or Orca, so nothing here is a heard
    fact yet. With "Box with a lid" open, press Ctrl+K, type `interference` and press Enter: when the check ends you
    hear a line like "Interference: no clashes". Then open a part that has an overhang, press Ctrl+K, type
    `printability`, press Enter, Tab to Check and press Enter. You hear the count and what it is made of, then the
    largest overhang with its area and face, for example "Printability: 3 things to look at. 2 overhangs, 1 thin wall.
    Largest overhang 132 mm squared on face 4". Tab to the first finding: you hear its words and its place ("Overhang,
    132 mm squared leaning 63 degrees, face 4, 16 mm above the bed") and its face lights on the model. Press Enter: the
    view turns to it. Fail: a check that ends in silence, a count with no area or face, a finding that is not
    reachable by Tab, or an Enter that does not turn the view.

19. **Sketch dimensions and relations (3 min).** Open a new sketch, draw one line with the Line tool and press Escape. Tab
    into the sketch palette: you hear "Sketch palette". Tab to the Shapes list and open it: the line is read with its
    freedom, such as "Line 1, free in X and Y". Tab to the Dimensions list: the row is read by its subject,
    "Length of Line 1", with its value in millimetres. Type `30` and press Enter: you hear the new freedom, such as "3
    degrees of freedom", once. Tab to the Relations list: you hear a row for the length, with its value and the line it
    holds, and a Delete button named by that rule. Press Delete on the row: you hear "Deleted" with the rule, then
    "Not constrained", and focus lands on the line above the list. Draw a rectangle and give it a width and a height, then
    constrain it until the line above the list says "Fully defined": it is spoken once, and the Shapes list now reads
    each shape as "fixed". Tab through the sketch canvas: the badges and glyphs on it are not read. Fail: silence on a
    change in freedom, a row read without its subject, a Delete button that reads only "Delete", a freedom spoken twice,
    or a badge or glyph read from the canvas.

    Then the colour check, with no screen reader. Turn on a protanopia simulation (a system colour filter, or in a browser build
    DevTools, Rendering, Emulate vision deficiencies, Protanopia) and open
    Preferences, pick the Colour-Blind Safe theme. Draw a line, a construction line (Construction at the foot of the rail) and project an edge
    from the model (P). Without the tint of any one colour, tell the three apart: the line is a solid stroke, the
    construction line has short dashes, the projected edge long dashes. Leave one line end touching nothing, and one
    meeting another curve with no rule: the first shows a ring, the second a dot. Do it again in FundaCAD Noir, where
    free and projected stay close in hue and the dashes alone have to tell them apart. Fail: two of the three that look the same,
    or an open end and an untied one that differ only in colour.

Some of these are expected to be silent today: tool prompts and the added feature are spoken once the
announcer lands. Record what you hear anyway. A step that was P and turns S or W is a regression and blocks the
release; one that was S and is still S is not.

### Bonus checks

When there is time left, or before a major release:

- Windows: the same script with Narrator, and with JAWS when a licence is at hand. Voice Access: "click Extrude".
- macOS: Voice Control "show numbers", Switch Control scanning, Full Keyboard Access on and off.
- Linux: until a voice tool is chosen, run the script with the keyboard alone and the screen reader off: every step
  has to be reachable and the focus always visible.
- Everywhere: the system high contrast or increased contrast setting and reduced motion, with the screen reader on.

## Results

Newest first. Write the steps as nineteen marks in order, like `P P P S S W P P P P P P P P P P P P P`, and put each W in the notes.

| Date | FundaCAD | OS and session | Package | Webview | Screen reader | Steps 1 to 19 | Tester | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| to record | next release | Ubuntu 24.04 GNOME, Wayland | Flatpak | WebKitGTK 4.1, GNOME 50 runtime | Orca |  |  | First run, the Orca on WebKitGTK 4.1 baseline. Note key echo and caret tracking under native Wayland. |
| to record | next release | Ubuntu 22.04 GNOME, X11 | `.deb` | WebKitGTK 4.1 (system) | Orca |  |  | First run, the X11 half of the baseline. |
| to record | next release | Windows 11 | installer | WebView2 | NVDA |  |  | First run. |
| to record | next release | macOS 14 or later | `.dmg` | WKWebView | VoiceOver |  |  | First run, the only check of the macOS tree. |

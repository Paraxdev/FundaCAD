# Accessibility smoke test

FundaCAD has to work with NVDA on Windows, VoiceOver on macOS and Orca on Linux. CI reads the page and each
platform's accessibility tree on every push (see [What CI checks](#what-ci-checks)), but no job can listen to a
screen reader. This page is the hand check a person runs before each release: about ten minutes per screen reader,
the same eight steps everywhere, and a results table that keeps what was heard.

## What CI checks

| Check | Where | Red when |
| --- | --- | --- |
| axe-core 4.10.2 (WCAG 2.0, 2.1 and 2.2, A and AA) over Home, the empty workspace, an open example, Sketch, Extrude, Settings, Render, Stress, the command palette and a confirm dialog | `e2e` job, step "Accessibility smoke (axe and aria snapshots)", `tools/harness/tests/browser/test_a11y.py` | a rule finds more nodes on a screen than `tools/harness/tests/browser/axe_baseline.json` allows, or a rule the baseline does not list for that screen finds any |
| Aria snapshots of the shell, Home and Settings | the same step, partial templates in `tools/harness/tests/browser/aria/` | a landmark, role or name a template holds is gone or renamed |
| Icon only controls have a name | `node scripts/check-ui-controls.mjs` in the `test` job, and `tests/ui/designSpec.test.ts` | an `IconButton` with no `tip`, a `RailButton` with no `label`, or an icon only `Segmented` option with no `label` or `tip`, and no `aria-label` or `aria-labelledby` either |
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
- The UI guard counts every `IconButton:no-name`, `RailButton:no-name` and `Segmented:no-name` against
  `scripts/ui-controls-allow.json`. Today there are none, so any new one fails. Lower an entry with
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

- Run the script in a Wayland session and in an X11 session. The Flatpak and the AppImage force `GDK_BACKEND=x11`
  (WebKitGTK under Tauri crashes on the Wayland backend, tauri-apps/tauri#8541), so on Wayland Orca reads an
  XWayland client. Step 8 is there for that: check key echo and caret tracking in a text field on both sessions.
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
   Parameters and focus returns.
7. **Settings and a confirm dialog (2 min).** Press Ctrl+, (comma): "Preferences, dialog". You hear the category
   navigation, the Theme combobox with its value and the Units radio group with "mm, checked". Done closes it. Press
   Ctrl+N: the app asks before it drops your unsaved Box. You hear the question and the focused button. Escape keeps
   the document and focus returns.
8. **Type in a field (1 min).** In the palette search (Ctrl+K), type `extrude`. Each letter is echoed, Left and Right
   read the character under the caret, and the list of matches is reachable and read. Escape closes the palette.

Some of these are expected to be silent today: tool prompts, the added feature and toasts are spoken once the
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

Newest first. Write the steps as eight marks in order, like `P P P S S W P P`, and put each W in the notes.

| Date | FundaCAD | OS and session | Package | Webview | Screen reader | Steps 1 to 8 | Tester | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| to record | next release | Ubuntu 24.04 GNOME, Wayland (XWayland) | Flatpak | WebKitGTK 4.1, GNOME 50 runtime | Orca |  |  | First run, the Orca on WebKitGTK 4.1 baseline. Note key echo and caret tracking under XWayland. |
| to record | next release | Ubuntu 22.04 GNOME, X11 | `.deb` | WebKitGTK 4.1 (system) | Orca |  |  | First run, the X11 half of the baseline. |
| to record | next release | Windows 11 | installer | WebView2 | NVDA |  |  | First run. |
| to record | next release | macOS 14 or later | `.dmg` | WKWebView | VoiceOver |  |  | First run, the only check of the macOS tree. |

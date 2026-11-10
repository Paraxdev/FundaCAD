# Accessibility

FundaCAD is made to be used with a keyboard alone, with a screen reader, with larger text and with more contrast. This page says what is checked and what is not yet, how to set it up and how to tell us when something does not work for you.

## What every build checks

Each change to FundaCAD runs these checks:

1. Home, the workspace, an open example, Sketch, Extrude, Preferences, Render, Stress, the command palette and a confirm dialog are scanned automatically against the WCAG 2.2 A and AA rules such a scan can test. A new problem on any of them turns the build red. A scan finds only part of what WCAG asks, so it is no claim that FundaCAD meets it.
2. The names and roles a screen reader hears on the main screens are compared with saved copies, so a renamed landmark or a lost name turns the build red.
3. The Items tree, History, the Geometry tab and the sketch lists are driven by keys alone, and a plate with a hole is drawn with no pointer at all.
4. On those screens every button, box and handle reacts over at least 24 by 24 pixels, and about 32 with Larger click targets.
5. At Interface size 150 and 200 percent and with Comfortable text, in the window sizes the checks use, no control is cut off or out of reach of Tab, and no text is smaller than 11 pixels.
6. Every button that shows only an icon has a name, and every number box a unit.
7. On Linux the AppImage's accessibility tree is read the way Orca reads it, and on Windows the window's tree the way NVDA and Narrator read it. A button with no name shows on the run. These two do not turn the build red yet.

macOS is not checked by a build: the Mac machines the builds run on cannot read another app's tree.

## What is still checked by hand

No build can listen to a screen reader, so a person runs the same twenty steps with each one before a release, the [screen reader smoke test](https://github.com/Paraxdev/fundacad/blob/main/docs/a11y-smoke.md). No run has been recorded yet, so nothing a screen reader says in FundaCAD has been confirmed by ear. These runs are planned:

| System | Package | Webview | Screen reader | Last run |
| --- | --- | --- | --- | --- |
| Ubuntu 24.04, GNOME on Wayland | Flatpak | WebKitGTK 4.1 | Orca | not run yet |
| Ubuntu 22.04, GNOME on X11 | `.deb` | WebKitGTK 4.1 | Orca | not run yet |
| Windows 11 | installer | WebView2 | NVDA | not run yet |
| macOS 14 or later | `.dmg` | WKWebView | VoiceOver | not run yet |

Also by hand:

1. GNOME on Wayland at 125 and 200 percent display scale: text and lines stay sharp.
2. Narrator and JAWS on Windows, Voice Control and Switch Control on macOS, when there is time.
3. The system's high contrast and reduced motion settings with a screen reader on.

## Settings

Edit, Preferences… (Ctrl+,), Accessibility holds these. Reset to defaults puts them all back, after it asks.

| Setting | What it does |
| --- | --- |
| Screen reader preset | Sets Announcements to Verbose and Notification time to Until dismissed, turns Single key shortcuts off and Solid panels on |
| Contrast | Standard, More or Maximum. Follow system takes More while the system's high contrast is on |
| Solid panels | Panels and menus draw opaque, so no model colour shows behind their text |
| Interface size | 80 to 200 percent, also with Ctrl+Plus, Ctrl+Minus and Ctrl+0 |
| Comfortable text | Spaces lines, letters and words further apart |
| Viewport labels | The size of dimensions, constraint marks, plane names and the view cube |
| Announcements | How much FundaCAD tells a screen reader: Off, Errors, Normal or Verbose |
| Units spoken in full | A field says millimetres instead of mm |
| Hover delay | How long the pointer rests before one face lights up instead of the whole part |
| Notification time | How long messages stay, up to Until dismissed |
| Single key shortcuts | Turn off when voice control or a screen reader's browse mode types letters |
| Larger click targets | Every control reacts over about 32 pixels, with nothing moving on screen |
| Animations | Off makes every move instant. Follow system takes the system's reduce motion setting |

Under Appearance, Theme has High Contrast Dark, High Contrast Light and Colour-Blind Safe among the others. See [Preferences](preferences.md) for the rest.

## Keyboard

1. F6 moves between the areas of the window, and Tab and the arrows move inside one.
2. Ctrl+K opens the command palette, which runs any command by its name.
3. ? lists every key, and any of them [can be changed](shortcuts.md#change-a-key).
4. Esc ends a tool, and Shift+F10 opens the menu of a row.
5. On a Mac, use Cmd for Ctrl.

These pages show the keys for each part of the work:

1. [Draw with keys](../sketch/keyboard.md)
2. [Pick with keys](../model/picking.md#pick-with-keys) and [the view as text](../model/picking.md#the-view-as-text)
3. [Keys in the Geometry tab](../model/items.md#keys-in-the-list)
4. [Shortcuts](shortcuts.md)

[Model without sight](../ai/without-sight.md) puts the routes that need no screen together.

## Screen readers

FundaCAD is made to work with NVDA and Narrator on Windows, VoiceOver on macOS and Orca on Linux. [The table above](#what-is-still-checked-by-hand) lists the runs planned, none made yet.

1. FundaCAD opens with Home, a dialog with Blank and the examples. Escape closes it.
2. Press Ctrl+, to open Preferences, move to its list of pages and press Down Arrow until you hear Accessibility. Tab then reaches Screen reader preset, the first button on that page. It turns Single key shortcuts off, so a letter typed in browse mode does not start a tool.
3. FundaCAD hands messages and tool prompts to the screen reader as they appear. Show Last Message, in the command palette (Ctrl+K), brings the newest one back.
4. In browse mode a screen reader may keep some keys for itself, such as the brackets of [Pick with keys](../model/picking.md#pick-with-keys). Switch to focus mode if a key does nothing.

## Linux

Orca finds FundaCAD through the accessibility bus, which the at-spi2-core package brings. GNOME and KDE Plasma start it for you. A minimal desktop, such as i3 or sway, or a container may not have it.

1. If Orca is silent, check that `/usr/share/dbus-1/services/org.a11y.Bus.service` exists. If not, install at-spi2-core from your distribution's packages. The AppImage checks this for you: started from a terminal, it prints the install command when the bus is missing.
2. `NO_AT_BRIDGE=1` in your environment keeps every GTK app, FundaCAD too, from a screen reader. FundaCAD says so when it starts, in the terminal it was started from or in its [log](../start/install.md). Start it without that variable.
3. On GNOME, Super+Alt+S turns Orca on and off. On other desktops, start `orca` from a terminal or your launcher.
4. The Flatpak reaches the bus through Flatpak itself, so only your system needs it.

## Report a problem

Open Report a Problem… from the command palette (Ctrl+K), or press F10 for the menu bar and find it under Help. It works as for any [problem](../start/report.md): the report goes to GitHub, which needs an account. In the description, say:

1. the screen reader or other tool, and its version;
2. the keys you pressed;
3. what you heard, and what you expected to hear.

On Linux the report adds an accessibility line, such as `accessibility: AT-SPI bus up · wayland`. It says whether the bus answered and what in your setup turns screen readers off.

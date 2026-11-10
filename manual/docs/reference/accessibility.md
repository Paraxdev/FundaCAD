# Accessibility

FundaCAD can be used with a keyboard alone, with a screen reader, with larger text and with more contrast. This page says what is checked, how to set it up and how to tell us when something does not work for you.

## What every build checks

Each change to FundaCAD runs these checks:

1. Home, the workspace, an open example, Sketch, Extrude, Preferences, Render, Stress, the command palette and a confirm dialog are scanned for the WCAG 2.2 A and AA rules. A new problem on any of them turns the build red.
2. The names and roles a screen reader hears on the main screens are compared with saved copies, so a renamed landmark or a lost name turns the build red.
3. The Items tree, History, the Geometry tab and the sketch lists are driven by keys alone, and a plate with a hole is drawn with no pointer at all.
4. Every button, box and handle reacts over at least 24 by 24 pixels, and about 32 with Larger click targets.
5. At Interface size 150 and 200 percent and with Comfortable text, no control is cut off or out of reach of Tab, and no text is smaller than 11 pixels.
6. Every button that shows only an icon has a name, and every number box a unit.
7. On Linux the AppImage's accessibility tree is read the way Orca reads it, and on Windows the window's tree the way NVDA and Narrator read it. A button with no name shows on the run. These two do not turn the build red yet.

macOS is not checked by a build: the Mac machines the builds run on cannot read another app's tree.

## What is still checked by hand

No build can listen to a screen reader, so before a release a person runs the same twenty steps with each one, the [screen reader smoke test](https://github.com/Paraxdev/fundacad/blob/main/docs/a11y-smoke.md). These runs are planned:

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

FundaCAD is made to work with NVDA and Narrator on Windows, VoiceOver on macOS and Orca on Linux. The table above says which runs have been made.

1. Press Screen reader preset under Accessibility once. It turns Single key shortcuts off, so a letter typed in browse mode does not start a tool.
2. FundaCAD hands messages and tool prompts to the screen reader as they appear. Show Last Message, in the command palette (Ctrl+K), brings the newest one back.

## Linux

Orca finds FundaCAD through the accessibility bus, which the at-spi2-core package brings. GNOME and KDE Plasma start it for you. A minimal desktop, such as i3 or sway, or a container may not have it.

1. If Orca is silent, start the AppImage from a terminal. With no bus it prints a line with the command that installs at-spi2-core on your distribution.
2. `NO_AT_BRIDGE=1` in your environment keeps every GTK app, FundaCAD too, from a screen reader. FundaCAD says so when it starts, in its log or in the terminal it was started from. Start it without that variable.
3. On GNOME, Super+Alt+S turns Orca on and off. `gsettings get org.gnome.desktop.a11y.applications screen-reader-enabled` says whether it is.
4. The Flatpak reaches the bus through Flatpak itself, so only your system needs it.

## Report a problem

Use Help, Report a Problem… as for any [problem](../start/report.md), and say:

1. the screen reader or other tool, and its version;
2. the keys you pressed;
3. what you heard, and what you expected to hear.

On Linux the report adds an accessibility line, such as `accessibility: AT-SPI bus up · wayland`. It says whether the bus answered and what in your setup turns screen readers off.

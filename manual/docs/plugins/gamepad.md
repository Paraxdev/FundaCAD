# Game controller

This plugin lets you move around the model with a game controller in place of a mouse. It is meant for a couch, a Steam Deck, or any time you want to look at a part without sitting at a desk. It is on by default and does nothing until a controller is connected.

Plug in a controller and press any button. FundaCAD only notices a controller after its first press, so one that looks dead usually needs a tap. Edit, Preferences, Game Controller shows which controller was found.

## What the buttons do

The left stick pans the view and the right stick rotates it. The right trigger zooms in and the left trigger zooms out. The other buttons are below, with the names of an Xbox style pad.

| Button | What it does |
| --- | --- |
| A | Enter, or a click while the cursor is on |
| B | Escape |
| X | Undo |
| RB | Redo |
| Y | Opens the command palette |
| LB | Turns the on-screen cursor on or off |
| D-pad | Top, Front, Isometric and Right views |
| Right stick click | Fit the view to the model |
| Left stick click | Switch between perspective and parallel views |
| View | Reset the camera |
| Menu | Save |

With the cursor on, the left stick moves a pointer around the screen and A clicks. That is enough to pick menu items, select faces and press buttons without touching the mouse.

## Changing it

The Game Controller page in Preferences has sliders for Pan speed, Rotate speed, Zoom speed, Cursor speed and Stick deadzone. Raise the deadzone if the view drifts while the sticks are at rest. Two Invert switches swap the direction of the right stick.

Under Buttons, every button except the triggers can be given any command from the command palette, a key press, the cursor switch, or Nothing. Reset to defaults puts it all back.

## Steam Deck

On a Steam Deck, add FundaCAD to Steam as a non-Steam game and start it from there, so that Steam presents the Deck to the app as a controller. With the "Gamepad with Mouse Trackpad" layout both trackpads keep working as a mouse, and you do not need the on-screen cursor at all.

If you start FundaCAD from the desktop, the Deck is in its mouse mode and the app sees no controller.

On other Linux systems, controller support depends on how the system's web view was built. If yours was built without it, FundaCAD sees no controller and the plugin does nothing.

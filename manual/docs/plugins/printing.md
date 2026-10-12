# Printer connection

This plugin shortens the trip from the model to the printer. It can open your part in the slicer, send the sliced file to a printer on your network, show how the print is going, and show a picture from the printer's camera. It is on by default.

It talks to printers that run Moonraker, the interface most Klipper printers use, and the slicer it knows about is OrcaSlicer. It only ever reaches printers on your local network, never the internet.

## From model to print

The plugin adds its tools under Print on the rail and a few lines at the bottom of the File menu. Both do the same things.

Print Project, called Export for Print (3MF) in the File menu, writes a 3MF project file for the slicer. It has one object for each body in your model, along with the filament slot you gave each one, so a multi-colour model arrives with its colours already assigned.

Open in OrcaSlicer does that export and then starts OrcaSlicer with the project loaded. FundaCAD looks for OrcaSlicer in the places it normally installs. If it can find OrcaSlicer's current printer preset, the project opens already set up for it. Slice the part there as usual.

Send to Printer takes the sliced result to the printer. It asks you for the `.gcode` file, reads which filaments are loaded in the printer, and shows a filament mapping window where you say which of your slots goes in which toolhead. Press Upload & Print and the job is sent and started.

If the printer is busy, cannot be reached, or has a different nozzle from the one the job was sliced for, you get a message that says so and nothing is sent.

## Watching the print

While a job runs, a small status line over the viewport shows its progress, and you are told when it finishes or fails. Click the status line to open the camera.

Camera in the File menu opens the same window, with a picture from the printer's camera that refreshes about once a second. It is for glancing at the print and not for watching it smoothly. If the camera does not answer, the window says so and has a Retry button.

## Your printers

FundaCAD starts with two printers in its list, a Snapmaker U1 and a Qidi X-Plus 4. The list is kept in a file called `printers.json` in the plugin's own data folder, and each entry has a name, an address on your network and a port.

## If you switch it off

The Print tools and the File menu lines go away, and nothing is deleted. Your slot assignments stay in the document. The [Multi-material](multicolor.md) plugin depends on this one for its palette, because only this plugin can ask the printer what is loaded.

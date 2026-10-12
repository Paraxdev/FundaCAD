# Printer connection

This plugin shortens the trip from model to printer. It works with Moonraker printers and OrcaSlicer, and only on your local network. It is on by default.

<!-- shot: printing-menu | Print group and filament mapping window -->

Print Project writes a 3MF with one object per body and their filament slots. Open in OrcaSlicer does that and opens the result. Send to Printer takes the sliced `.gcode`, asks which filament goes in which toolhead, and starts the job when you press Upload & Print.

A status line over the viewport shows progress, and Camera in the File menu shows the printer's camera. Your printers are listed in `printers.json` in the plugin data folder.

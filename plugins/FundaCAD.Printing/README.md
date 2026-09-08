# Printer connection

Sends jobs to a printer on your network, reads its status, and opens a model in
your slicer.

## Why these grants

`process.spawn` is not padding. Opening a model in a slicer starts another
program on the machine, and that is the single most consequential thing
anything in this app does on the user's behalf.

Not `network`. It reaches the printers configured in this app, over the local
network, and "connect to the internet" would be a worse description rather than
a more cautious one. `printer.control` is where that reach is declared, and it
says which machines it means.

`files.write` is the sliced job on its way to the machine.

# Multi-material

If your printer can print in several colours or materials, this plugin is how you say which part goes in which filament. You give each body a filament slot, and the slots line up with the toolheads of the printer.

It is off by default, because on a single-material machine it would only add controls with nothing to control. To use it, open Edit, Preferences, go to Plugins and switch on Multi-material.

## The palette

With the plugin on, a Palette section appears in the Items card. It lists your filament slots, each with a colour swatch, a name and, if known, the material. Click a swatch to change its colour, and double-click a name to rename it. Slot 1 is toolhead 1, and hovering a slot tells you which toolhead it belongs to.

The Palette only shows once you have at least one body and FundaCAD can reach your printer. That means the [Printer connection](printing.md) plugin has to be on and the printer switched on.

A coloured dot next to the title shows how things stand. Green means the printer answered and the slots match what is loaded. Yellow means the filaments in the printer have changed since you last synced, and red means the printer did not answer. Sync filaments from printer, the button beside the dot, copies the colours and materials the printer reports into your palette.

## Giving a body a slot

Right-click a body and open Color. The menu lists your filament slots with their colours, and None at the bottom takes the slot away.

When you import a coloured model, each colour is matched to the nearest slot you already have. FundaCAD does not add slots for you, because a slot stands for a filament that is physically loaded, and inventing one would claim a filament your printer does not have.

The slots come into play when you send a job. The Printer connection plugin reads the palette when it writes a print project, and shows a filament mapping window that matches your slots to the toolheads before it uploads. The Texture tool of the [Surface Texture](texture.md) plugin also gets a Print color list, so a pattern can be printed in a different slot from the body underneath.

## If you switch it off

Switching the plugin off hides the palette, the Color menu and the slot colours in the view. It deletes nothing. The slots and the assignments stay saved in the document, and a document with colours also opens and exports normally on a machine where this plugin is off.

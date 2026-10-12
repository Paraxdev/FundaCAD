# FundaCAD

FundaCAD is a free, open source CAD program for designing parts you want to 3D print. You draw a flat sketch, give it exact sizes, turn it into a solid, and export a file for your slicer. It runs on Windows, macOS and Linux, needs no account, and keeps your files on your own disk.

A part in FundaCAD is a list of steps. Every sketch, extrude and fillet stays in the History, so you can go back to any step, change a number, and the rest of the part rebuilds around it. That suits printed parts, where you often need the same bracket again, 2 mm wider.

![FundaCAD with an exploded planetary gearbox open, showing the Items card, the tool rail and the History card](img/ui-overview.png)

The tools sit on the rail down the left side of the window. The Items card lists what is in the document, and the History card lists the steps that built it. When you cannot find a tool, press Ctrl+K and type its name.

## Where to begin

If you have not installed it yet, start with [Install](start/install.md). It also explains the warnings your system shows on the first start, because the builds are not code signed.

Then follow [Your first part](start/first-part.md). It makes a small plate with a hole and exports it as an STL, and it touches most of what the rest of the manual explains in detail.

## What is in the manual

The sections are in the order you will probably need them.

- [Sketching](sketch/drawing.md) is about drawing shapes, pinning them down with constraints and repeating them in patterns.
- [Modelling](model/create.md) is about turning sketches into solids and changing them afterwards, plus the Items card, the History and parameters.
- [Inspect](inspect/measure-and-section.md) is about measuring, cutting a model open, checking that it will print, and testing how it bends.
- [Render](render/materials.md) is about materials and pictures of your model.
- [Files](files/import-export.md) is about importing, exporting and how documents are saved.
- [Plugins](plugins/index.md) lists the optional add-ons, from a screws library to support for a 3D mouse.
- [AI assistants](ai/connect.md) explains how to let an assistant build and check parts for you.
- The Reference section has the [shortcuts](reference/shortcuts.md), the [preferences](reference/preferences.md) and a [glossary](reference/glossary.md) for words you have not met before.

FundaCAD is a rolling beta and changes often. If a page does not match what you see on screen, the app is probably newer than the page. Problems can be reported through Help, Issue Tracker.

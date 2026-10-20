<p align="center">
  <img src="assets/brand/fundacad-mark.svg" width="96" alt="FundaCAD logo, a blue cube">
</p>

# FundaCAD

Free, open source parametric CAD for 3D printing. Sketch a shape, give it exact sizes,
turn it into a solid and export a file for your slicer. Windows, macOS and Linux.

<p align="center">
  <a href="https://github.com/Paraxdev/fundacad/releases/tag/beta"><img alt="Download the beta" src="https://img.shields.io/badge/download-beta-2f6fed"></a>
  <a href="https://github.com/Paraxdev/fundacad/releases/tag/development"><img alt="Download the development build" src="https://img.shields.io/badge/bleeding%20edge-development-8a8a8a"></a>
  <a href="https://paraxdev.github.io/FundaCAD/"><img alt="Read the manual" src="https://img.shields.io/badge/docs-manual-2f6fed"></a>
  <a href="LICENSE"><img alt="Licence AGPL-3.0" src="https://img.shields.io/badge/licence-AGPL--3.0-blue"></a>
  <img alt="Windows, macOS and Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey">
</p>

<p align="center">
  <img src="assets/readme/ui-overview.png" width="1000" alt="FundaCAD main window with an exploded planetary gearbox, the Items card, the tool rail and the History">
</p>

## Download

Get the build for your system from the [beta](https://github.com/Paraxdev/fundacad/releases/tag/beta).
It is the normal download, and somewhat stable. Testers who want every change
the day it lands can take the [development build](https://github.com/Paraxdev/fundacad/releases/tag/development)
instead. It is the bleeding edge and can be broken.
An install only ever updates to a newer build of the same kind. There is no account and no cloud, and your files stay on your disk. The builds are not code
signed, so Windows and macOS will warn you on the first start. The
[install page](https://paraxdev.github.io/FundaCAD/start/install/) shows how to get past that.

## What you can do

- Sketch with lines, arcs, splines and text, and pin the shape down with constraints and dimensions.
- Turn sketches into solids with extrude, revolve, loft and sweep, then change them with fillets, chamfers, holes and shells.
- Keep every step in the History, go back to any of them, and let the part rebuild.
- Drive a design from named parameters, so a bracket 2 mm wider is one number away.
- Check a part before printing: measure it, cut it open, look for overhangs and thin walls.
- Render it with materials, glass and glowing parts in the Render workspace.
- Add optional plugins, such as a screws library, texture tools and a printer connection.
- Let an AI assistant build and check parts through the built-in MCP connection. (can be turned off if you do not use any AI assistance or have no need for a separately running process)
- Export STL, 3MF, STEP and GLB, and import STEP and meshes.

## Documentation

The manual is at [paraxdev.github.io/FundaCAD](https://paraxdev.github.io/FundaCAD/). It starts
with a first part from sketch to exported file.

## For developers

Building from source, running the tests and fixing common build problems are in
[CONTRIBUTING.md](CONTRIBUTING.md). The first build compiles the Open CASCADE geometry kernel
and takes about twenty minutes. The technical notes are in `docs/`.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), how the processes fit together
- [`docs/ENGINE.md`](docs/ENGINE.md), the Funda Engine, its tests and the release channels
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md), the messages the frontend and the engine exchange
- [`docs/FUNDA-FORMAT.md`](docs/FUNDA-FORMAT.md), the `.funda` and `.fundab` file formats
- [`docs/PACKAGING.md`](docs/PACKAGING.md), how a desktop bundle and the kernel are built
- [`docs/MCP.md`](docs/MCP.md), how an AI assistant connects and what it can do
- [`docs/PLUGINS.md`](docs/PLUGINS.md), writing plugins and what they may reach

## About the code / AI Disclosure

Most of the code and tests here are written by AI. I decide what gets built, steer it, and use the app actively.

Im trying to apply real software engineering strategies and learnings to make sure the codebase and the features aren't a useless mess, and actively listening to any feedback that I get.


You may use AI for creating features and creating pull requests,
for those you are responsible for the AI output and ensure that it serves a usable quality.
you must write at least one test that, if the feature allows it, ensures it has one "known good" case

for creating issues and bug requests please read the AI output and ensure you can reproduce it, cheap incoherent bug reports may take a while to be understood and fixed.

due to the nature of AI im very open to any issues and bug requests that may arrive, and take the highest priority of having em fixed. the goal is a coherent program that actually
can show itself in daily use cases and be as flexible as an open source project can get.

## Licence

AGPL-3.0, see [LICENSE](LICENSE). FundaCAD started as a fork of
[SindriCAD](https://github.com/MakerViking/sindricad) and has moved a long way since, mainly in
the interface and a Rust backend.

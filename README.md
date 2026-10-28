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
An install only ever updates to a newer build of the same kind, and on Linux only the AppImage updates itself. There is no account and no cloud, and your files stay on your disk. The builds are not code
signed, so Windows and macOS will warn you on the first start. The
[install page](https://paraxdev.github.io/FundaCAD/start/install/) shows how to get past that.

## Build from source

The first build compiles the Open CASCADE kernel and takes about twenty minutes. The app
lands in `src-tauri/target/release/` and the installers in `src-tauri/target/release/bundle/`.
Details and troubleshooting are in [CONTRIBUTING.md](CONTRIBUTING.md#building-from-source).

```
# Windows (PowerShell), open a new terminal after the installs
winget install OpenJS.NodeJS.LTS Kitware.CMake Rustlang.Rustup Git.Git
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
git clone https://github.com/Paraxdev/fundacad.git C:\src\fundacad
cd C:\src\fundacad
npm ci
npm run tauri build

# macOS
xcode-select --install
brew install cmake node
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env"
git clone https://github.com/Paraxdev/fundacad.git && cd fundacad
npm ci
npm run tauri build

# Linux (Debian, Ubuntu)
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libudev-dev patchelf libfuse2 cmake git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env"
git clone https://github.com/Paraxdev/fundacad.git && cd fundacad
npm ci
npm run tauri build
```

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

## Reporting problems

In the app, Help > Report a Problem… copies a full report and opens a prefilled issue on GitHub. New issue offers two forms: a Problem report and an Idea. The Problem report asks what happened, the steps and your system, and has a box for the report the app copies for you. A security problem goes to the private reporting in [SECURITY.md](SECURITY.md).

## About the code / AI disclosure

FundaCAD is built with AI. Most of the code, the tests and the documentation are written by AI coding agents. I decide what gets built and in what order, steer the work, check what lands and use the app actively.

I apply real software engineering practice so the codebase and the features do not turn into a mess:

- Larger changes are built on their own branch and reviewed by a second AI agent whose job is to break them, then fixed until that review passes.
- Every change runs the checks: over 8,000 unit and component tests, end to end checks that drive the app in a browser like a user, and golden geometry checks that compare the engine's output with known good results. CI builds every change on Windows, macOS and Linux, and installs the Linux builds on Ubuntu, Debian and Fedora. The beta only publishes once they are all green.
- The interface follows a written design spec ([docs/DESIGN.md](docs/DESIGN.md)), and tests check the interface against it.
- Bugs come before new features.

AI does not decide what ships. Store submissions, such as the Flathub manifest and its review, are written and handled by me by hand.

AI can write code that looks right and is wrong. If something misbehaves, Help > Report a Problem (see above) gives me what I need to fix it. Because of how this is built I am very open to issues and bug reports, and fixing them has the highest priority. The goal is a coherent program that holds up in daily use and is as flexible as an open source project can be.

### Using AI to contribute

You may use AI to write features and pull requests. You are responsible for what it produces:

- read the change, understand it and make sure it works;
- write at least one test that checks a known good case, where the feature allows it;
- say in the pull request that AI wrote it.

If you use AI to write an issue or a bug report, read it first and make sure you can reproduce what it says. A vague or incoherent report takes much longer to understand and fix.

## Licence

AGPL-3.0, see [LICENSE](LICENSE). FundaCAD started as a fork of
[SindriCAD](https://github.com/MakerViking/sindricad) and has moved a long way since, mainly in
the interface and a Rust backend.

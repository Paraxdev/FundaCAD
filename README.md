<p align="center">
  <img src="assets/brand/fundacad-mark.svg" width="96" alt="FundaCAD logo, a blue cube">
</p>

# FundaCAD

Free, open source parametric CAD for 3D printing. Sketch a shape, give it exact sizes,
turn it into a solid and export a file for your slicer. Windows, macOS and Linux.

<p align="center">
  <a href="https://github.com/Paraxdev/fundacad/releases/tag/beta"><img alt="Download the beta" src="https://img.shields.io/badge/download-beta-2f6fed"></a>
  <a href="https://github.com/Paraxdev/fundacad/releases/tag/development"><img alt="Download the development build" src="https://img.shields.io/badge/bleeding%20edge-development-8a8a8a"></a>
  <a href="https://fundacad.dev/"><img alt="Read the manual" src="https://img.shields.io/badge/docs-manual-2f6fed"></a>
  <a href="LICENSE"><img alt="Licence AGPL-3.0" src="https://img.shields.io/badge/licence-AGPL--3.0-blue"></a>
  <img alt="Windows, macOS and Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey">
</p>

<p align="center">
  <img src="assets/readme/ui-overview.png" width="1000" alt="FundaCAD main window with an exploded planetary gearbox, the Items card, the tool rail and the History">
</p>

## Download

Get the build for your system from the [beta](https://github.com/Paraxdev/fundacad/releases/tag/beta).
It is the normal download, and somewhat stable.

The [development build](https://github.com/Paraxdev/fundacad/releases/tag/development) gets every
change the day it lands. It is the bleeding edge and can be broken.

1. There is no account and no cloud, your files stay on your disk.
2. An install only updates to a newer build of the same kind. On Linux only the AppImage updates itself.
3. The builds are not code signed, so Windows and macOS warn you on the first start.
   The [install page](https://fundacad.dev/start/install/) shows how to get past that.

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

1. Sketch with lines, arcs, splines and text, and pin the shape down with constraints and dimensions.
2. Turn sketches into solids with extrude, revolve, loft and sweep, then change them with fillets, chamfers, holes, shells and patterns.
3. Keep every step in the History, go back to any of them, and let the part rebuild.
4. Drive a design from named parameters, so a bracket 2 mm wider is one number away.
5. Check a part before printing: measure it, cut it open, look for overhangs and thin walls, and see where it bends under load with Stress.
6. Render it with materials, glass and glowing parts in the Render workspace.
7. Add optional plugins, such as fasteners, surface textures and a printer connection.
8. Let an AI assistant build and check parts through the built-in MCP server. It only runs when an assistant starts it.
9. Export STL, 3MF, STEP and GLB, or a sketch as DXF and SVG. Import STEP, IGES, DXF, SVG and most mesh files.

## Documentation

The manual is at [fundacad.dev](https://fundacad.dev/). It starts
with a first part from sketch to exported file.

## For developers

Building from source, running the tests and fixing common build problems are in
[CONTRIBUTING.md](CONTRIBUTING.md). The technical notes are in `docs/`.

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), how the processes fit together
2. [`docs/ENGINE.md`](docs/ENGINE.md), the Funda Engine, its tests and the release channels
3. [`docs/PROTOCOL.md`](docs/PROTOCOL.md), the messages the frontend and the engine exchange
4. [`docs/FUNDA-FORMAT.md`](docs/FUNDA-FORMAT.md), the `.funda` and `.fundab` file formats
5. [`docs/PACKAGING.md`](docs/PACKAGING.md), how a desktop bundle and the kernel are built
6. [`docs/MCP.md`](docs/MCP.md), how an AI assistant connects and what it can do
7. [`docs/PLUGINS.md`](docs/PLUGINS.md), writing plugins and what they may reach

## Reporting problems

1. In the app, open Help, Report a Problem… and write what happened.
2. Press Open on GitHub. It copies the full report and opens a prefilled Problem report.
3. Paste the report into its Report from the app box and submit.

Help, Suggest an Idea opens the Idea form. A security problem goes to the private reporting in [SECURITY.md](SECURITY.md).

## About the code / AI disclosure

FundaCAD is built with AI. Most of the code, the tests and the documentation are written by AI coding agents.
I decide what gets built and in what order, steer the work, check what lands and use the app actively.

I apply real software engineering practice so the codebase and the features do not turn into a mess:

1. Larger changes are built on their own branch and reviewed by a second AI agent whose job is to break them, then fixed until that review passes.
2. Every change runs over 8,000 unit and component tests, end to end checks that drive the app in a browser like a user, and golden geometry checks against known good results.
3. CI builds every change on Windows, macOS and Linux, and installs the Linux builds on Ubuntu, Debian and Fedora. The beta only publishes once they are all green.
4. The interface follows a written design spec ([docs/DESIGN.md](docs/DESIGN.md)), and tests check the interface against it.
5. Bugs come before new features.

AI does not decide what ships. Store submissions, such as the Flathub manifest and its review, are written and handled by me by hand.

AI can write code that looks right and is wrong. If something misbehaves, a report (see above) gives me what I need to fix it.
I am very open to issues and bug reports, and fixing them has the highest priority.

The goal is a coherent program that holds up in daily use and is as flexible as an open source project can be.

### Using AI to contribute

You may use AI to write features and pull requests. You are responsible for what it produces:

1. read the change, understand it and make sure it works;
2. write at least one test that checks a known good case, where the feature allows it;
3. say in the pull request that AI wrote it.

If you use AI to write an issue or a bug report, read it first and make sure you can reproduce what it says. A vague or incoherent report takes much longer to understand and fix.

## Licence

AGPL-3.0, see [LICENSE](LICENSE). FundaCAD started as a fork of
[SindriCAD](https://github.com/MakerViking/sindricad) and has moved a long way since, mainly in
the interface and a Rust backend.

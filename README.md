# FundaCAD

Free, open source parametric CAD for 3D printing. Sketch it, constrain it, model
it, and export STEP, STL or 3MF. Windows, macOS and Linux.

Built on the Open CASCADE geometry kernel through the Funda Engine (Rust),
with a [Tauri](https://tauri.app) shell and a Vue + three.js viewport. A part
is a timeline of features, so you can go back to any one of them, change it,
and the model rebuilds from there.


It started as a fork of [SindriCAD](https://github.com/MakerViking/sindricad) and
has diverged quite a lot since, under the same AGPL-3.0 licence.


## Disclosure  
This project heavily or exclusively uses AI to generate code and tests.
do NOT expect this software to be enterprise grade but it does allow very fast iteration.
you may use AI for feature requests or even forking and creating your own.
this code open to the public and free forever.

human input is made for decisions, guiding and real usage by me.
the goal is it to make this a personalized version of a CAD with features I like and would love to have.



<p align="center">
  <img src="assets/readme/ui-overview.png" width="1000">
</p>

<p align="center">
  <img src="assets/readme/sketch-on-face.png" width="900">
</p>

<p align="center">
  <img src="assets/readme/transform-gizmo.png" width="900">
</p>


<p align="center">
  <img src="assets/readme/area-select.png" width="900">
</p>

## Install

Prebuilt installers for Windows, macOS (Apple Silicon) and Linux are on the
[alpha release](https://github.com/Paraxdev/fundacad/releases/tag/alpha),
FundaCAD 1.0 on the Funda Engine, rebuilt from `main` on every green
build. It is less tested than the
[beta release](https://github.com/Paraxdev/fundacad/releases/tag/beta), the
beta built from the `legacy` branch and running the sidecar, so anything that
builds differently in the alpha is worth a report. Files open in both. These
builds do not update themselves, so come back to those pages for a newer one.

To let an AI assistant (Claude Code, Claude Desktop or any MCP host) build and
edit models in the app, open **Preferences, AI assistants (MCP)**: the MCP
server ships with the app, and that section gives the setup to paste.

On Windows there is also a **portable zip** (`…_x64_portable.zip`). Unzip it
anywhere and run `fundacad.exe`: no installer, no admin rights, and several builds
can sit side by side. It carries the same files the installer lays down,
the geometry engine included, so it needs nothing else beyond the
WebView2 runtime that Windows 11 and an up-to-date Windows 10 already have.
Portable means no installer rather than no traces: preferences still live in
your user profile.

The builds are **not code signed**, so each OS says so in its own way:

- **Windows**, SmartScreen shows "Windows protected your PC". Choose **More
  info**, then **Run anyway**. The portable build says it too, on first run.
- **macOS**, Gatekeeper may report the app as damaged. It is not; that is what
  an unsigned app looks like to a current macOS. Clear the quarantine flag once,
  after moving it to Applications:
  ```bash
  xattr -dr com.apple.quarantine /Applications/FundaCAD.app
  ```
- **Linux**, the AppImage needs `chmod +x` and nothing else, and is the one to
  reach for when the others give trouble: it carries its own WebKitGTK.

  The `.deb` and `.rpm` are built on Ubuntu 22.04, so they depend on the
  WebKitGTK that ships from there on: `libwebkit2gtk-4.1-0`. That means
  **Ubuntu 22.04 or newer, or Debian 12 or newer**. Install the `.deb` with apt
  and not with `dpkg -i`, because dpkg only *reports* a missing dependency
  while apt goes and fetches it:

  ```bash
  sudo apt install ./FundaCAD_0.1.38_amd64.deb
  ```

  Distributions carrying only the older `libwebkit2gtk-4.0-37`, or only the
  newer `libwebkitgtk-6.0-4`, cannot satisfy that dependency under the name the
  package asks for, and there the AppImage is the answer rather than installing
  WebKitGTK by hand.

## Build

Needs [Node](https://nodejs.org), [Rust](https://rustup.rs), cmake and a C++
toolchain: the Funda Engine compiles OpenCASCADE from source on the first
build, about twenty minutes, then it is cached (docs/PACKAGING.md). On Windows
use the MSVC toolchain.

```bash
git clone https://github.com/Paraxdev/fundacad.git
cd fundacad
npm install
```

Then:

```bash
npm run tauri dev      # run it, starts vite and the engine for you
npm run tauri build    # package a desktop build
npm test               # vitest
cargo test --workspace --features fundacad-engine/ws   # the engine
```

### Frontend only

Two terminals, if you are iterating on the UI in a browser:

```bash
cargo run --bin fundacad-engine -- --ws   # ws://127.0.0.1:8765
npm run dev                               # http://localhost:5173
```

The engine prints `TOKEN <t>` on its first line and refuses connections without
it, so open `http://localhost:5173/?token=<t>`. Without it the viewport connects,
is refused, and silently never builds anything. `FUNDACAD_ENGINE_TOKEN` and
`FUNDACAD_ENGINE_PORT` fix the token and the port instead.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), how the processes fit together
- [`docs/ENGINE.md`](docs/ENGINE.md), the Funda Engine: its target architecture, test strategy and golden files, the alpha rolling release, and its performance work
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md), the messages the frontend and the engine exchange
- [`docs/FUNDA-FORMAT.md`](docs/FUNDA-FORMAT.md), the readable `.funda` JSON document and the self-repairing binary `.fundab`
- [`docs/PACKAGING.md`](docs/PACKAGING.md), how a desktop bundle is built
- [`docs/MCP.md`](docs/MCP.md), MCP, built into the app: how an AI assistant builds, measures and looks at parts, and how to connect one
- [`docs/PLUGINS.md`](docs/PLUGINS.md), optional parts of the app, what they may reach, and how that is asked

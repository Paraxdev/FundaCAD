# Contributing to FundaCAD

Thanks for your interest in FundaCAD. A few ground rules keep the project healthy and its
licensing clean.

## Licence of your contributions

FundaCAD is released under **AGPL-3.0-only** (see [`LICENSE`](LICENSE)). By submitting a
contribution (a pull request, a patch, or any code or content), you agree that:

1. Your contribution is licensed to the project and its users under **AGPL-3.0-only**.
2. You grant the project maintainer (the copyright holder) a perpetual, irrevocable,
   worldwide, royalty-free right to **relicense your contribution under other terms**,
   including a commercial licence.

This is what lets FundaCAD stay open source under the AGPL while the maintainer can also
offer a commercial licence to organisations that cannot use AGPL software. It is the same
inbound-relicensable model used by projects like GitLab and Qt. You confirm you have the
right to grant this, meaning the work is yours or your employer has authorised it.

> This is a lightweight contributor agreement, not legal advice. A formal CLA or DCO
> document may replace it later.

## Before you open a pull request

- Branch from `dev` and open the pull request against `dev`. `dev` publishes the
  development build on every push, and `main`, the beta, only moves when a green `dev` is
  promoted or a hotfix lands (docs/ENGINE.md section 7).
- `npm run build` (TypeScript and Vite) must pass.
- Code is formatted, and CI fails on anything the formatters would change. `npx prettier --write .`
  formats TypeScript, Vue, JavaScript and SCSS. `cargo fmt` formats Rust: run it in the top folder,
  in `src-tauri` and in each `plugins/*/geometry-rs`, never `cargo fmt --all`, which rewrites the
  vendored `third_party/`.
- `npx vitest run` and `cargo test --workspace --features fundacad-engine/ws` must pass,
  and so must every golden check,
  `fundacad-engine golden-check tests/golden/<name>.golden.json`.
- Keep geometry in the engine (`crates/`). The frontend owns the document and the viewport.
- Refer to geometry through queryable selectors (axis, normal, nearest point), never through
  a topology index, so references survive edits that renumber the topology.

## Building from source

FundaCAD is a Vue frontend in a [Tauri](https://tauri.app) window. The Funda Engine (Rust)
and the Open CASCADE geometry kernel (C++) are compiled into the same executable. The first
build also compiles Open CASCADE, which takes about twenty minutes, and later builds reuse
it. How that kernel is built, where it lives and how to share it between checkouts is in
[`docs/PACKAGING.md`](docs/PACKAGING.md#the-opencascade-kernel).

### 1. Install the tools

**Windows** (10 or 11, x64):

1. **Node.js 22 LTS or newer** from [nodejs.org](https://nodejs.org), with the installer's
   defaults.
2. **Visual Studio 2022 Build Tools** from
   [visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
   Tick the **Desktop development with C++** workload. Visual Studio 2022 Community with
   the same workload works too.
3. **CMake 3.22 or newer** from [cmake.org/download](https://cmake.org/download/), with the
   option to add it to the PATH. CMake 4 is fine.
4. **Rust 1.89 or newer** through [rustup](https://rustup.rs). Run `rustup-init.exe` and take
   the defaults, which give you the stable `x86_64-pc-windows-msvc` toolchain. Install it
   after the Build Tools, and run `rustup update` if you already have it.
5. **Git** from [git-scm.com](https://git-scm.com).

The WebView2 runtime comes with Windows 10 and 11. If it was removed, get the Evergreen
runtime from [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/).

Open a new terminal so it sees the new PATH, and check:

```powershell
node --version     # v22 or newer
cmake --version    # 3.22 or newer
rustup show        # the active toolchain ends in -pc-windows-msvc, 1.89 or newer
where.exe cargo    # the first line is in C:\Users\<you>\.cargo\bin
```

Clone into a short path such as `C:\src\fundacad`. The Open CASCADE build nests deep folders
inside the checkout, and a long base path runs into the 260 character path limit of Windows.

**Linux** (Debian or Ubuntu 22.04 and newer). Other distributions need the same packages
under their own names, see [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).
The list below is the one CI installs, from
[`.github/actions/linux-deps/action.yml`](.github/actions/linux-deps/action.yml), plus cmake:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  libudev-dev patchelf libfuse2 cmake
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

You also need Node.js 22 or newer, from [nodejs.org](https://nodejs.org) or your package
manager.

**macOS**:

```bash
xcode-select --install
brew install cmake node
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 2. Run it

```bash
git clone https://github.com/Paraxdev/fundacad.git
cd fundacad
npm install
npm run tauri dev
```

This starts the Vite dev server, compiles the app and opens the window. Frontend edits show
up live, and a Rust edit recompiles and restarts the app. While cargo sits on
`Building [...] opencascade-sys(build)` it is compiling the kernel, which is normal.

### 3. Build an installer

```bash
npm run tauri build
```

The installers land in `src-tauri/target/release/bundle/`: an `.msi` and an NSIS `-setup.exe`
on Windows, a `.dmg` and `.app` on macOS, and an AppImage, `.deb` and `.rpm` on Linux. The
bare executable on Windows is `src-tauri/target/release/fundacad.exe`. The release build
compiles the Rust again with optimisations but reuses the kernel.

### 4. Run the tests

```bash
npm test                 # frontend unit tests (vitest)
npm run typecheck        # vue-tsc
cargo test --workspace --features fundacad-engine/ws   # the engine, from the top folder
cd src-tauri && cargo test --tests                     # the app shell, needs the dist/ that npm run build makes
```

Tests that use the app the way a person does go through the agent harness in `tools/harness`
([docs/HARNESS.md](docs/HARNESS.md)), not a new page script. It starts its own engine, vite and
Chrome, so it needs a built `fundacad-engine` and an installed Chrome. The smoke set CI runs:

```bash
pip install -e "tools/harness[test]"
python -m pytest tools/harness/tests -m smoke
```

### Frontend only

To iterate on the interface in a browser, run the engine and Vite in two terminals:

```bash
cargo run --bin fundacad-engine -- --ws   # ws://127.0.0.1:8765
npm run dev                               # http://localhost:5173
```

The engine prints `TOKEN <t>` on its first line and refuses connections without it, so open
`http://localhost:5173/?token=<t>`. Without the token the viewport connects, is refused, and
silently never builds anything. `FUNDACAD_ENGINE_TOKEN` and `FUNDACAD_ENGINE_PORT` fix the
token and the port instead.

### The user manual

The manual lives in `manual/` and is built with [Zensical](https://zensical.org). To preview
it, run `pip install zensical` and then `zensical serve` inside `manual/`. It is published to
GitHub Pages from `main`, so a manual change goes live with the next beta, when `dev` is
promoted to `main`.

The pages are in `manual/docs/` and the navigation is in `manual/zensical.toml`. Write for
someone who wants to print a part: short paragraphs of whole sentences, and only tool names,
menus and shortcuts you have checked in the source. A line like
`<!-- shot: name | what it shows -->` marks where a screenshot is still missing.

## Troubleshooting

- **`FundaCAD's kernel crashes when built with the MinGW (windows-gnu) toolchain`**, or cmake
  output mentioning `MinGW Makefiles`. The cargo that ran targets `windows-gnu` instead of
  `windows-msvc`. Either rustup's default toolchain is the GNU one, or a second Rust install
  (from a package manager, MSYS2 or similar) comes before rustup on the PATH.
  1. Run `rustup show`. If the default toolchain ends in `-windows-gnu`, run
     `rustup default stable-x86_64-pc-windows-msvc`.
  2. Run `where.exe cargo`. If the first line is not in `C:\Users\<you>\.cargo\bin`, another
     Rust is ahead of rustup. Uninstall it, or move `%USERPROFILE%\.cargo\bin` above it in the
     PATH, then open a new terminal. Windows reads the System Path before the User Path, so a
     Rust in the System Path needs `.cargo\bin` moved there too. To try a build without
     changing anything, put rustup first for the current PowerShell only:

     ```powershell
     $env:PATH = "$HOME\.cargo\bin;$env:PATH"
     npm run tauri dev
     ```
- **`rustup` is not recognized**, or `where.exe cargo` lists nothing in
  `C:\Users\<you>\.cargo\bin`. rustup is either not installed or its folder is not on the
  PATH. If `C:\Users\<you>\.cargo\bin\rustup.exe` exists, add that folder to the User Path and
  open a new terminal. Otherwise install rustup.
- **`exceeds the OS max path limit`**, or another MSBuild error about a path being too long.
  The checkout sits too deep for the nested Open CASCADE build folders. Clone it again into a
  short path such as `C:\src\fundacad`.
- **`use of unstable library feature`** inside `opencascade-sys`'s build script, or cargo
  saying the package requires a newer rustc. The toolchain is older than 1.89, run
  `rustup update`.
- **`include could not find requested file: .../OpenCASCADEFoundationClassesTargets.cmake`**
  followed by `Builtin OpenCASCADE library not found`. Older builds registered their Open
  CASCADE build folders in CMake's package registry, and CMake picked a broken one from there.
  The current build ignores that registry, so pull the latest `main`. On an older branch, clear
  the entries, which only ever point at build folders:

  ```powershell
  reg delete HKCU\Software\Kitware\CMake\Packages\OpenCASCADE /f
  ```

  On Linux and macOS: `rm -rf ~/.cmake/packages/OpenCASCADE`.
- **`This directory holds an OpenCASCADE kernel built by MinGW or GCC`** (or `by MSVC`, or
  `built for <another target>`). A kernel from the other Windows toolchain, or for another
  target, is in the folder the message names, often left by a build with the wrong cargo.
  Delete that folder and build again.
- **`FUNDACAD_OCCT_ROOT holds no OpenCASCADE install`** or **`FUNDACAD_OCCT_ROOT has to be an
  absolute path`**. The variable points somewhere without a kernel, or is relative. Remove it
  to use the checkout's own `target/OCCT`, or set it to the absolute path of a folder that has
  one. See [`docs/PACKAGING.md`](docs/PACKAGING.md#the-opencascade-kernel).
- **`Compatibility with CMake < 3.5 has been removed from CMake`**. CMake 4 refuses the
  minimum that Open CASCADE 7.8.1 declares. The checkout's `.cargo/config.toml` sets
  `CMAKE_POLICY_VERSION_MINIMUM=3.5`, which cargo only reads when run inside the checkout. Set
  that environment variable yourself when building from elsewhere.
- **`could not find any instance of Visual Studio`**. The Build Tools are missing the
  **Desktop development with C++** workload, add it from the Visual Studio Installer.

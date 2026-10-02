# Packaging FundaCAD

FundaCAD is a [Tauri 2](https://v2.tauri.app) desktop app with its geometry
engine compiled in:

- **Frontend**, TypeScript + Vite, built with `npm run build` (Node 22) into `dist/`.
- **App shell**, Rust (`src-tauri/`): the window, native dialogs, the document
  container, plugins, and the supervisor of the geometry engine.
- **Geometry engine**, the Funda Engine, Rust (`crates/`, docs/ENGINE.md) on OpenCASCADE, run as
  a worker process of the same executable (`fundacad --engine`), so a bundle
  carries one executable and no runtime beside it.
- **MCP server**, `fundacad-mcp`, linked into the app and started with
  `fundacad --mcp` (docs/MCP.md).

CI: [`.github/workflows/build.yml`](../.github/workflows/build.yml) builds
Linux x86_64, macOS arm64 and Windows x64 and publishes the rolling `beta`
release from `main`. The sidecar build on the `legacy` branch is retired and
publishes nothing; its last build is the `legacy-final` release.

## Building a bundle

```sh
npm ci
npx tauri build --config src-tauri/tauri.beta.conf.json
```

What the pieces are:

- **`tauri.conf.json`** is the whole app: the window, the Content-Security-Policy
  (no loopback origin, the engine is reached over Tauri IPC), the updater's
  feed (`beta/latest.json`) and the bundle targets. It declares no
  `resources`, so nothing but the executable and the MCP server is bundled.
- **`tauri.beta.conf.json`** adds what only a release bundle needs: updater
  artifacts and the rpm and NSIS compression settings. `fundacad-mcp` is a
  library dependency of the app, so every bundled `fundacad` also serves MCP
  over stdio when started with `--mcp`. Its private engine is the same app,
  `fundacad --engine --ws`, and its live mode attaches to the window through
  `session.json`.
- **OpenCASCADE 7.8.1 is compiled from source**, statically, by the `occt-sys`
  crate the vendored bindings (`third_party/opencascade-rs`) pull in. It needs
  cmake and a C++ toolchain and takes about twenty minutes cold. See
  [The OpenCASCADE kernel](#the-opencascade-kernel) below.
- **Plugin bundles** are packed by `scripts/build-plugins.py`, which builds each
  plugin's geometry component with `scripts/build-plugin-wasm.py` (the
  `wasm32-wasip2` target), and are published to the same release.

Linux needs the WebKitGTK stack Tauri documents, plus cmake:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf cmake
```

Bundles land under `src-tauri/target/release/bundle/`: `.AppImage`, `.deb` and
`.rpm` on Linux, `.app` and `.dmg` on macOS, `.msi` and NSIS `-setup.exe` on
Windows. CI also publishes `src-tauri/target/release/fundacad.exe` as the
portable Windows download.

## The OpenCASCADE kernel

The build script of `opencascade-sys` (`third_party/opencascade-rs/crates/opencascade-sys/build.rs`)
finds or builds the kernel like this:

- **Where it lives.** `FUNDACAD_OCCT_ROOT` names the install directory (its
  `cmake`, `include` and `lib`, or `lib/cmake/opencascade` on Linux and macOS).
  The root `.cargo/config.toml` sets it to `<repo>/target/OCCT`, relative to the
  checkout, and cargo reads that file from `src-tauri` too, so the root
  workspace and the app share one kernel per checkout. An environment variable
  of the same name overrides it, which is how several checkouts or worktrees
  share one kernel. It has to be an absolute path: a relative one would resolve
  against the build script's own directory, so the build script refuses it.
- **Cross builds.** A build for a target other than the host (`cargo build
  --target ...`, or a macOS universal build) uses `<parent>/<target triple>/OCCT`
  beside that directory instead, `target/<triple>/OCCT` by default, so each
  target gets its own kernel.
- **First build.** When that directory holds no complete install (every
  toolkit library in `OCCT_LIBS` and the cmake config files), the kernel is
  built into it (it has to be named `OCCT` for that, a quirk of `occt-sys`).
  The build script keeps its bookkeeping in `.fundacad` inside it: a lock file,
  so two cargo runs that both need the kernel take turns and building the
  workspace and the app at once compiles it once; an `installing` marker that
  is only removed once the install finished, so an interrupted build is
  resumed rather than linked; and a `target` stamp naming the target triple
  the kernel was built for.
- **No CMake package registry.** OCCT's own build used to register its build
  tree in the CMake user package registry (`HKCU\Software\Kitware\CMake\Packages\OpenCASCADE`
  on Windows, `~/.cmake/packages/OpenCASCADE` elsewhere), and `find_package`
  fell back to that registry whenever the expected install was missing, so a
  stale or half built tree from anywhere on the machine got picked up. The
  kernel build now writes nothing there (and removes an entry for its own
  build tree should one appear) and the find step reads neither registry, it
  is pointed at the exact install instead. Entries older builds left there are
  therefore harmless.
- **Wrong toolchain.** On Windows a kernel built by MinGW (`lib/libTK*.a`, or a
  `build` configured for `MinGW Makefiles`) cannot be linked by an MSVC build,
  nor the other way round. The build script stops with a message naming the
  directory to delete instead of failing later in cmake or the linker. Use the
  rustup MSVC toolchain; a `cargo` that defaults to `windows-gnu` (a GNU rustup
  default, or another Rust install earlier on PATH) builds that target, which the build script refuses because that
  kernel crashes in ordinary fillets.
- **CMake 4.** `CMAKE_POLICY_VERSION_MINIMUM=3.5` (set by the root
  `.cargo/config.toml`) lets CMake 4 configure OCCT 7.8.1, whose declared
  minimum it otherwise refuses.
- **CI** caches `target/OCCT` without its `build` directory, in `rust-geom`
  and `build-beta` under one key.
- **The old location.** Builds from before this layout installed the kernel
  in `src-tauri/target/OCCT`. Nothing reads it any more, so it can be deleted.

## Flatpak

`build-flatpak` repackages the Linux `.deb` with
`packaging/flatpak/dev.fundacad.app.yml` on the GNOME runtime (Flathub), which
carries WebKitGTK 4.1 and GTK 3, and checks that `ldd` resolves every library
the binary links inside it. It runs on X11 like the AppImage, reads a
SpaceMouse over hidraw (`--device=all`, the host still needs the udev rule),
and has no in-app updates, since the updater only replaces AppImages
(`src-tauri/src/lib.rs`). A failed Flatpak build leaves it out of the beta
release without holding the release back.

## Sizes

Measured on Windows, 2026-09-17, against a sidecar build from `legacy`:

| | sidecar (0.2.125) | Funda Engine |
|---|---|---|
| `.msi` | 162.7 MB | **23.3 MB** |
| `-setup.exe` (NSIS) | 157.3 MB | **23.1 MB** |
| `fundacad.exe` | small, plus an 800 MB sidecar runtime beside it | 62.4 MB, and nothing beside it |

MCP is linked into `fundacad.exe`, so the Windows portable download is that
single executable. It still requires the system WebView2 runtime.

## What CI checks about a bundle

- the bundle configs declare no `resources`;
- the built binary registers `engine_attach`, the IPC command the webview
  reaches the engine through, and contains the MCP stdio server;
- the AppImage carries no sidecar runtime;
- the AppImage carries a real `.DirIcon`, in place of the symlink Tauri's
  bundler leaves, and it is the same 256×256 app icon
  (`src-tauri/icons/128x128@2x.png`, generated from
  `assets/brand/fundacad-mark.svg` by `tauri icon`) as the root icon the desktop file's
  `Icon=` names and `usr/share/icons/hicolor/256x256/apps`;
- AppRun sources `packaging/appimage-deps-check.sh` first, which names any
  system library the binary cannot find and how to install it;
- every plugin that names a `geometryWasm` component has it in its bundle.

## Code signing & notarization

### macOS

Unsigned `.app`/`.dmg` are blocked by Gatekeeper on other machines (the release
notes give the `xattr` workaround). With an Apple Developer ID certificate, add
the `APPLE_*` secrets and `--config src-tauri/tauri.macos-sign.conf.json`, which
turns on the hardened runtime with `Entitlements.plist`: the plugin host
compiles WebAssembly at run time, which the hardened runtime otherwise refuses.
See the [Tauri macOS signing docs](https://v2.tauri.app/distribute/sign/macos/).
Not configured here.

### Windows

Signing avoids SmartScreen warnings but is not required to run. Needs an
Authenticode certificate, see
[Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/). Not
configured here.

### Linux

AppImage, `.deb` and `.rpm` are not code signed in the Apple or Windows sense.

### The updater

Tauri's updater verifies a release with the minisign key in `tauri.conf.json`,
which is still upstream's, so the release job withholds `latest.json` until a
key of this project's is generated (tests/security/updater.test.ts).

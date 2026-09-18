# Packaging FundaCAD

FundaCAD is a [Tauri 2](https://v2.tauri.app) desktop app with its geometry
engine compiled in:

- **Frontend**, TypeScript + Vite, built with `npm run build` (Node 22) into `dist/`.
- **App shell**, Rust (`src-tauri/`): the window, native dialogs, the document
  container, plugins, and the supervisor of the geometry engine.
- **Geometry engine**, Rust (`crates/`, docs/RUST-PIVOT.md) on OpenCASCADE, run as
  a worker process of the same executable (`fundacad --engine`), so a bundle
  carries one executable and no runtime beside it.
- **MCP server**, `fundacad-mcp`, shipped beside the app (docs/MCP.md).

CI: [`.github/workflows/build.yml`](../.github/workflows/build.yml) builds
Linux x86_64, macOS arm64 and Windows x64 and publishes the rolling `alpha`
release from `main`. The Python engine's beta is built from the `legacy`
branch by that branch's own copy of the workflow, and publishes the `beta`
release; the two never meet: separate branches, jobs, tags, update feeds and
artifact names.

## Building a bundle

```sh
npm ci
npx tauri build --config src-tauri/tauri.alpha.conf.json
```

What the pieces are:

- **`tauri.conf.json`** is the whole app: the window, the Content-Security-Policy
  (no loopback origin, the engine is reached over Tauri IPC), the updater's
  feed (`alpha/latest.json`) and the bundle targets. It declares no
  `resources`, so nothing but the executable and the MCP server is bundled.
- **`tauri.alpha.conf.json`** adds what only a release bundle needs: updater
  artifacts, the rpm and NSIS compression settings, and `externalBin`
  (`binaries/fundacad-mcp`), filled by its `beforeBuildCommand`, which runs
  `scripts/stage-mcp-server.mjs`: `cargo build --release -p fundacad-mcp` in
  the root workspace, copied to `src-tauri/binaries/fundacad-mcp-<triple>`.
  Tauri installs it next to `fundacad.exe` (in `Contents/MacOS` and `usr/bin`
  elsewhere), so the portable zip, unpacked from the `.msi`, has it too. Its
  private engine is the app itself, `fundacad --engine --ws`, and its live mode
  attaches to the window through `session.json`.
- **OpenCASCADE 7.8.1 is compiled from source**, statically, by the `occt-sys`
  crate the vendored bindings (`third_party/opencascade-rs`) pull in. It needs
  cmake and a C++ toolchain, it takes about twenty minutes cold, and it lands in
  `<target>/OCCT`, which is what CI caches. Several target directories can share
  one build: point `FUNDACAD_OCCT_ROOT` at an installed kernel (its `cmake`,
  `include` and `lib`) and the build script links it instead of building again.
  On Windows use the rustup MSVC toolchain, a MinGW `cargo` earlier on PATH
  picks the wrong cmake generator, and set `CMAKE_POLICY_VERSION_MINIMUM=3.5`
  (the root `.cargo/config.toml` does), because CMake 4 refuses OCCT 7.8.1's
  declared minimum.
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
Windows, plus CI's portable zip.

## Sizes

Measured on Windows, 2026-09-17, against the last Python beta:

| | beta (0.2.125) | alpha |
|---|---|---|
| `.msi` | 162.7 MB | **23.3 MB** |
| `-setup.exe` (NSIS) | 157.3 MB | **23.1 MB** |
| `fundacad.exe` | small, plus an 800 MB Python runtime beside it | 62.4 MB, and nothing beside it |

With `fundacad-mcp` beside it (2026-09-18): `.msi` 29.2 MB, `-setup.exe`
28.9 MB, portable zip 28.9 MB; the folder is `fundacad.exe` 76.6 MB and
`fundacad-mcp.exe` 4.2 MB, nothing else.

## What CI checks about a bundle

- the bundle configs declare no `resources`;
- the built binary registers `engine_attach`, the IPC command the webview
  reaches the engine through, and `fundacad-mcp` sits beside it;
- the AppImage and the portable zip carry no Python interpreter;
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

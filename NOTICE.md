# Third-Party Notices

FundaCAD incorporates the following third-party components. This file satisfies the
attribution and source-availability requirements of their licenses. Full license texts
are bundled under `LICENSES/` in distributed builds.

No dependency is under the GPL or AGPL; nothing here requires FundaCAD's own source to
be published. The copyleft components below are **weak-copyleft** (LGPL) and are used in a license-compatible way, which permits
distributing FundaCAD under its own terms.

## Geometry kernel

- **Open CASCADE Technology (OCCT)** 7.8.1, LGPL-2.1 **with the Open CASCADE Exception**.
  Source: https://github.com/Open-Cascade-SAS/OCCT (tag V7_8_1), carried by the
  `occt-sys` crate. Compiled from source and linked **statically** into the application.
  FundaCAD's complete source, including the build that links OCCT, is public, so users
  may rebuild it against a compatible modified OCCT. The Open CASCADE Exception
  additionally permits incorporating OCCT header material into the application.
- **opencascade-rs / opencascade-sys / occt-sys** (vendored fork,
  `third_party/opencascade-rs/`), LGPL-2.1. Upstream: https://github.com/bschwind/opencascade-rs.

## 2D constraint solver

- **PlaneGCS** (from FreeCAD), via **@salusoft89/planegcs**, LGPL-2.0-or-later.
  Source: https://github.com/FreeCAD/FreeCAD (src/Mod/Sketcher/App/PlaneGCS) and
  https://github.com/Salusoft89/planegcs. Used as a WebAssembly module.

## Permissively licensed components

- **three.js**, MIT, https://github.com/mrdoob/three.js
- **camera-controls**, MIT, https://github.com/yomotsu/camera-controls
- **Tauri** and official plugins (`tauri`, `tauri-plugin-fs`, `tauri-plugin-dialog`,
  `@tauri-apps/*`), MIT OR Apache-2.0, https://github.com/tauri-apps/tauri
- **hidapi** (Rust crate), MIT, https://github.com/ruabmbua/hidapi-rs
- **threemf** (Rust crate), 0BSD, https://crates.io/crates/threemf
- **wasmtime** (the plugin host), Apache-2.0 WITH LLVM-exception,
  https://github.com/bytecodealliance/wasmtime
- **serde / serde_json / glam / tungstenite**, MIT OR Apache-2.0

## Written offer (LGPL source availability)

For the LGPL components above (OCCT, opencascade-rs, PlaneGCS), the corresponding source
code is available at the URLs listed. For any distributed binary build, the complete
corresponding source of these libraries is also available from the project for a period of
at least three (3) years upon request. FundaCAD's own source, which links OCCT statically,
is public, so users may rebuild it with compatible modified versions of these libraries.

The beta, built from the `legacy` branch, carries its own notice for the
packages it bundles.

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
- **three-gpu-pathtracer** (Path traced), MIT, https://github.com/gkjohnson/three-gpu-pathtracer
- **oidn-web** (the Path traced denoise), MIT, https://github.com/pissang/oidn-web, with
  **@petamoriken/float16**, MIT
- **Open Image Denoise weights** (src/viewport/pathtrace/weights, `rt_hdr_calb_cnrm_small`
  and `rt_hdr_calb_cnrm_large`), Apache-2.0, https://github.com/RenderKit/oidn-weights
- **Tauri** and official plugins (`tauri`, `tauri-plugin-fs`, `tauri-plugin-dialog`,
  `@tauri-apps/*`), MIT OR Apache-2.0, https://github.com/tauri-apps/tauri
- **hidapi** (Rust crate), MIT, https://github.com/ruabmbua/hidapi-rs
- **threemf** (Rust crate), 0BSD, https://crates.io/crates/threemf
- **wasmtime** (the plugin host), Apache-2.0 WITH LLVM-exception,
  https://github.com/bytecodealliance/wasmtime
- **serde / serde_json / glam / tungstenite**, MIT OR Apache-2.0
- **wgpu** (the native path tracer, src-tauri/tracer), MIT OR Apache-2.0,
  https://github.com/gfx-rs/wgpu, with **wgpu-core**, **wgpu-hal**, **wgpu-types**,
  **naga**, **ash**, **gpu-allocator**, **range-alloc**, **glow**, **renderdoc-sys**,
  **codespan-reporting**, **half**, **bytemuck**, **ordered-float**, **parking_lot**,
  **objc2** and its Apple framework crates, **windows** and its sibling crates, all
  MIT OR Apache-2.0 (some also Zlib); **spirv**, Apache-2.0; **libloading**, ISC;
  **slotmap** and **foldhash**, Zlib
- **oidn** (Rust crate, the native tracer's denoise), MIT, https://github.com/Twinklebear/oidn-rs
- **Open Image Denoise** 2.5.1 (the native tracer's denoise, loaded at run time by a build
  with the `oidn` feature), Apache-2.0, https://github.com/RenderKit/oidn, with
  **oneTBB**, Apache-2.0, https://github.com/uxlfoundation/oneTBB
- **faer** (the stress analysis's sparse linear algebra), MIT,
  https://codeberg.org/sarah-quinones/faer, with its numeric crates
  **faer-traits**, **gemm**, **gemm-common**, **gemm-f32**, **gemm-f64**, **gemm-c32**,
  **gemm-c64**, **nano-gemm** (and its `-core`, `-codegen`, `-f32`, `-f64`, `-c32`, `-c64`
  crates), **private-gemm-x86**, **pulp**, **pulp-wasm-simd-flag**, **dyn-stack**,
  **dyn-stack-macros**, **qd**, **reborrow**, **equator** and **equator-macro**, all MIT,
  https://github.com/sarah-quinones; **num-complex**, **generativity**, **seq-macro**,
  **paste**, **num_cpus** and **enum-as-inner**, MIT OR Apache-2.0; **libm**, **raw-cpuid**,
  **interpol** and **sysctl**, MIT; **defer**, MIT OR Apache-2.0; **bytemuck**, Zlib OR
  Apache-2.0 OR MIT; **byteorder**, **walkdir** and **same-file**, Unlicense OR MIT
- **ufbx** (the FBX reader, Rust crate with the bundled ufbx.c), MIT OR Unlicense,
  https://github.com/ufbx/ufbx-rust
- **cadmpeg-codec-rhino** (the Rhino .3dm reader) with **cadmpeg-ir**, **cadmpeg-core** and
  **cadmpeg-container**, Apache-2.0, https://github.com/cadmpeg/cadmpeg; **zstd**, **zstd-safe**
  and **zstd-sys**, MIT OR Apache-2.0, bundling the zstd library, BSD-3-Clause,
  https://github.com/facebook/zstd; **zip**, **serde-value**, **ordered-float**, MIT;
  **roxmltree**, **typed-path**, **sha1**, **sha2**, **digest**, **hybrid-array**, **const-oid**,
  **block-buffer**, **crypto-common**, **jobserver** and **pkg-config**, MIT OR Apache-2.0
- **ifc-lite-core**, **ifc-lite-geometry** and **ifc-lite-processing** (the IFC reader),
  MPL-2.0, source at https://github.com/LTplus-AG/ifc-lite, and the test model
  tests/fixtures/ifc_revit_wall_openings.ifc, its issue_098_wall_V5C.ifc with the exporter
  comment and a user id removed, MPL-2.0; **nalgebra**, **simba** and
  **approx**, Apache-2.0; **earcutr**, ISC; **geometry-predicates**, **i_float**, **i_key_sort**,
  **i_shape**, **i_tree** and **nom**, MIT; **i_overlay**, **glam**, **bnum**, **fast-float2**,
  **jpeg-decoder**, **png**, **num-bigint**, **num-integer**, **num-rational**, **lexical-core**
  (and its `-parse-float`, `-parse-integer`, `-util`, `-write-float`, `-write-integer` crates),
  **minimal-lexical**, **matrixmultiply** and **rawpointer**, MIT OR Apache-2.0; **wide** and
  **safe_arch**, Zlib OR Apache-2.0 OR MIT

## Written offer (LGPL source availability)

For the LGPL components above (OCCT, opencascade-rs, PlaneGCS), the corresponding source
code is available at the URLs listed. For any distributed binary build, the complete
corresponding source of these libraries is also available from the project for a period of
at least three (3) years upon request. FundaCAD's own source, which links OCCT statically,
is public, so users may rebuild it with compatible modified versions of these libraries.

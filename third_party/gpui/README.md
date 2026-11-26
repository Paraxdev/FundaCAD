# GPUI fork for FundaCAD 2

The crates.io snapshots of Zed's GPUI at 0.3.14 (zed@f126950), Apache-2.0, with the changes below. `crates/fundacad-app`
pulls them in through `[patch.crates-io]`. The `examples` folder and its `[[example]]` entries were dropped from
`gpui-pre`.

| Crate | File | Change |
|---|---|---|
| gpui-pre | src/window.rs | `Window::paint_external_texture` paints an app rendered texture as a polychrome sprite, with clip, corner radii and opacity |
| gpui-pre-wgpu | Cargo.toml | the wgpu backends (Vulkan, GL, Metal) are enabled on Windows too |
| gpui-pre-wgpu | src/gpui_wgpu.rs | `register_external_texture`, `shared_context` and `shared_context_generation`: the app draws on GPUI's device into textures GPUI composites |
| gpui-pre-wgpu | src/wgpu_context.rs | each native context is published for `shared_context`; OpenGL 3.3 and GLES 3.0 adapters without storage buffers take the WebGL2 limits and the texture based instance data |
| gpui-pre-wgpu | src/wgpu_atlas.rs | `WgpuTextureInfo` is `Clone` |
| gpui-pre-wgpu | src/wgpu_renderer.rs | texture lookups fall back to the external textures; `mod readback` |
| gpui-pre-wgpu | src/wgpu_renderer/readback.rs | new: `WgpuRenderer::render_to_image` draws a scene offscreen and reads it back, behind `test-support` |
| gpui-pre-windows | Cargo.toml | depends on gpui-pre-wgpu; `test-support` turns on its readback |
| gpui-pre-windows | src/win_renderer.rs | new: windows draw through gpui-pre-wgpu, `FUNDA_GPUI_RENDERER=dx` keeps DirectX 11 |
| gpui-pre-windows | src/window.rs | uses `WinRenderer`; no `WS_EX_NOREDIRECTIONBITMAP` with wgpu, since Vulkan and GL cannot present without it |
| gpui-pre-windows | src/gpui_windows.rs | wires `win_renderer` in |

Each changed file says so on its first line (`Modified by FundaCAD:`), as Apache 2.0 section 4(b) asks.

Findings behind these: the spike notes in breadcrumb mcanqs62 (viewport) and fas3x9a9 (OpenGL).

To move to a newer GPUI, diff this folder against the 0.3.14 sources from crates.io to list the changes, then carry
them over to the new snapshots by hand.

# GPUI fork for FundaCAD 2

The crates.io snapshots of Zed's GPUI at 0.3.14 (zed@f126950), Apache-2.0, with the changes below. `crates/fundacad-app`
pulls them in through `[patch.crates-io]`. The `examples` folder and its `[[example]]` entries were dropped from
`gpui-pre`.

| Crate | File | Change |
|---|---|---|
| gpui-pre | src/window.rs | `Window::paint_external_texture` paints an app rendered texture as a polychrome sprite, with clip, corner radii and opacity; drop shadows pass the casting element's bounds and corner radii so the shader paints them only outside it |
| gpui-pre | src/window.rs | `Window::set_ui_zoom` scales the UI as a browser's page zoom: the scale factor is multiplied and the viewport, mouse position, mouse, scroll, pinch and file drop events and the IME position are divided or multiplied to match; touch gestures are not scaled |
| gpui-pre | src/scene.rs | `Shadow` carries `caster_bounds`, the element that casts the shadow |
| gpui-pre-wgpu | Cargo.toml | the wgpu backends (Vulkan, GL, Metal) are enabled on Windows too |
| gpui-pre-wgpu | src/gpui_wgpu.rs | `register_external_texture`, `shared_context` and `shared_context_generation`: the app draws on GPUI's device into textures GPUI composites |
| gpui-pre-wgpu | src/wgpu_context.rs | each native context is published for `shared_context`; OpenGL 3.3 and GLES 3.0 adapters without storage buffers take the WebGL2 limits and the texture based instance data |
| gpui-pre-wgpu | src/wgpu_atlas.rs | `WgpuTextureInfo` is `Clone` |
| gpui-pre-wgpu | src/wgpu_renderer.rs | texture lookups fall back to the external textures; `mod readback`; the record size test counts the larger `Shadow` |
| gpui-pre-wgpu | src/wgpu_renderer/readback.rs | new: `WgpuRenderer::render_to_image` draws a scene offscreen and reads it back, behind `test-support` |
| gpui-pre-wgpu | src/shaders.wgsl | drop shadows are clipped to outside the casting element, as in CSS; rounded corners are squircles (CSS `corner-shape: squircle`) unless the radius makes a pill or a circle; blurred and inset shadows and dashed border spacing still model circular corners, close enough at UI sizes; the DirectX path keeps circles |
| gpui-pre-wgpu | src/shaders_webgl.wgsl | the `Shadow` record read is 32 words, with `caster_bounds` |
| gpui-pre-windows | Cargo.toml | depends on gpui-pre-wgpu; `test-support` turns on its readback |
| gpui-pre-windows | src/win_renderer.rs | new: windows draw through gpui-pre-wgpu, `FUNDA_GPUI_RENDERER=dx` keeps DirectX 11 |
| gpui-pre-windows | src/window.rs | uses `WinRenderer`; no `WS_EX_NOREDIRECTIONBITMAP` with wgpu, since Vulkan and GL cannot present without it |
| gpui-pre-windows | src/gpui_windows.rs | wires `win_renderer` in |
| gpui-pre-windows | src/shaders.hlsl | drop shadows are clipped to outside the casting element, as in CSS |

Each changed file says so on its first line (`Modified by FundaCAD:`), as Apache 2.0 section 4(b) asks.

Findings behind these: the spike notes in breadcrumb mcanqs62 (viewport) and fas3x9a9 (OpenGL).

To move to a newer GPUI, diff this folder against the 0.3.14 sources from crates.io to list the changes, then carry
them over to the new snapshots by hand.

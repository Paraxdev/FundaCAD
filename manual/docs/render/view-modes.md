# View modes

The view mode switch picks how the model is shaded. Press Z to step through the modes.

Matcap is flat studio clay and the lightest on the computer. Realtime shows the real materials and lights. Path traced follows the light around the scene until the picture is clean, then stops.

## Where Path traced runs

Path traced runs either in FundaCAD itself, on the native tracer, or in the viewport's web view, on WebGPU. Preferences, Viewport, Path tracer picks one: Auto, Native or WebGPU. The Render workspace has the same choice under Tracer.

Auto uses the native tracer on Linux and on older macOS, where the web view has no WebGPU, and anywhere the graphics card traces with ray queries, which makes the native tracer many times faster. Otherwise it uses WebGPU. If the tracer you picked is missing, FundaCAD uses the other one.

Once the picture reaches its sample count it is denoised, the grain smoothed away. On WebGPU the web view does it. On the native tracer FundaCAD does it on the processor with an edge aware filter, which keeps edges and shading and only takes out grain it can measure.

For a cleaner picture, press High quality denoise (about 52 MB) under Denoise in the Render workspace or in Preferences, Viewport. FundaCAD downloads Intel Open Image Denoise once from its official release, checks every file against the copy it expects, and uses it straight away, no restart. Without a connection, or if the download fails, the filter stays and the row says why. The line under Denoise always names the denoiser in use. On macOS the download is not offered yet.

## When Path traced is greyed out

- Performance mode is on, or FundaCAD found the computer low powered. Hover the button to read why.
- Neither tracer works on this computer. Hover the button to read which case it is:
  - No graphics card was found.
  - The computer only offers software graphics, which is too slow to path trace.
  - The graphics card binds too few storage buffers. The tooltip names how many it has and that path tracing needs 12.
  - The graphics card drew the tracer's test scene wrong, so path tracing stays off on it.
- Path traced stopped twice after a graphics error. It stays off until FundaCAD restarts.

Path traced pauses while a section view, x-ray, wireframe or an open sketch is showing, and carries on when they close. After a minute in another mode it lets go of the graphics memory it used.

While you orbit, move a body or edit, Path traced shows the Realtime look and goes back to tracing once the view rests. Turn off Realtime while moving under Display to keep the traced picture up throughout, noisy and restarting with every move.

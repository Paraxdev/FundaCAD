# View modes

The view mode switch picks how the model is shaded. Press Z to step through the modes.

Matcap is flat studio clay and the lightest on the computer. Realtime shows the real materials and lights. Path traced follows the light around the scene until the picture is clean, then stops.

## Where Path traced runs

Path traced runs either in FundaCAD itself, on the native tracer, or in the viewport's web view, on WebGPU. Preferences, Viewport, Path tracer picks one: Auto, Native or WebGPU. The Render workspace has the same choice under Tracer.

Auto uses the native tracer on Linux and on older macOS, where the web view has no WebGPU. On Windows it uses WebGPU unless the native tracer is the faster of the two on that graphics card. If the tracer you picked is missing, FundaCAD uses the other one.

Once the picture reaches its sample count it is denoised, the grain smoothed away. On WebGPU the web view does it; on the native tracer FundaCAD does it on the processor, which takes about half a second at full screen. A copy of FundaCAD without the denoise libraries shows the native picture as it was traced.

## When Path traced is greyed out

- Performance mode is on, or FundaCAD found the computer low powered. Hover the button to read why.
- Neither tracer works on this computer.
- Path traced stopped twice after a graphics error. It stays off until FundaCAD restarts.

Path traced pauses while a section view, x-ray, wireframe or an open sketch is showing, and carries on when they close. After a minute in another mode it lets go of the graphics memory it used.

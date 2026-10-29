# View modes

The three view mode buttons on the viewport pick how the model is shaded. The same choice sits under Display, Shading.

| Mode | What it shows |
| --- | --- |
| Matcap | Flat studio clay, the lightest on the computer. Under Display pick its finish (studio, clay, metal or wax) and Tint with body colors. |
| Realtime | The real materials and lights, and the default. |
| Path traced | Follows the light around the scene until the picture is clean, then stops. |

Press Z for the next mode and Shift+Z for the one before. The Model and Render workspaces each keep their own mode.

## Where Path traced runs

Pick the tracer under Preferences, Viewport, Path tracer, or under Tracer in the Render workspace.

- **Native** traces in FundaCAD itself.
- **WebGPU** traces in the viewport's web view.
- **Auto** picks the faster one this computer has.

If the tracer you picked is missing, or hits a graphics error, FundaCAD uses the other one.

## Denoise

Once the picture reaches its sample count, the grain is smoothed away. Denoise in the Render workspace sets how: Off, Standard or High quality, which takes a few seconds longer.

On the native tracer an edge aware filter cleans the picture, keeping edges and shading. For a cleaner picture, download Intel Open Image Denoise:

1. Press High quality denoise under Denoise in the Render workspace, or in Preferences, Viewport. The button shows its size, about 52 MB.
2. FundaCAD downloads it once, checks every file and uses it straight away, with no restart.

The line under Denoise names the denoiser in use, and says why when a download fails. The download is not offered on macOS yet.

## When Path traced is greyed out

Hover the Path traced button to read why.

- Performance mode is on, or FundaCAD found the computer low powered. Click Path traced, then click it again while the warning shows, to trace anyway until FundaCAD restarts.
- No graphics card was found.
- The computer only offers software graphics, which is too slow to path trace.
- The graphics card binds too few storage buffers. The tooltip names how many it has, path tracing needs 12.
- The graphics card drew the tracer's test scene wrong.
- Path traced stopped twice after a graphics error. It stays off until FundaCAD restarts.

If FundaCAD closed while path tracing was starting, it opens in Realtime next time and says so.

A model over 3 million triangles is not traced, and a note says so. Raise the limit under Preferences, Experimental, Most triangles traced.

## When Path traced pauses

- Section View, X-Ray, Wireframe or an open sketch pauses it, and it carries on when they close. The button's tooltip names the pause.
- While you orbit, move a body or edit, it shows the Realtime look and traces again once the view rests. Turn off Realtime while moving under Display to keep the traced picture up, noisy and restarting with every move.
- After a minute in another mode it lets go of the graphics memory it used.

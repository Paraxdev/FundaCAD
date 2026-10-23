// Fails when a plugin's code reached the shipped bundle. Only the `import.meta.env.DEV` branch in src/plugins/activate.ts
// keeps it out, and a branch rollup cannot drop fails silently, so the built artifact is read.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "dist/assets";

// What each plugin does, never its id or name, which the offer list ships on purpose. At least one per plugin, so a
// marker that stops matching shows as a broken check rather than a cleaner bundle.
const MARKERS = [
  ["FundaCAD.SpaceMouse", "spacemouse_start"],
  ["FundaCAD.SpaceMouse", "getSpaceMouseConfig"],
  ["FundaCAD.Gamepad", "fundacad.gamepad.config"],
  ["FundaCAD.Gamepad", "Cursor on / off"],
  ["FundaCAD.Printing", "Send to printer, filament mapping"],
  ["FundaCAD.Printing", "print-status-pill"],
  ["FundaCAD.PrintLook", "Draws layer lines in the Realtime view only"],
  ["FundaCAD.MultiColor", "nearestPaletteSlot"],
  ["FundaCAD.MultiColor", "pal-swatch"],
  // String literals, because a minifier renames functions but leaves strings alone.
  ["FundaCAD.Texture", "Perlin noise"],
  ["FundaCAD.Texture", "Flat land on the crests"],
  ["FundaCAD.ExtraParameters", "Parameter Setup"],
  ["FundaCAD.ExtraParameters", "save the current values as"],
  ["FundaCAD.PrintToolbox", "select the flat floor of each counterbore"],
  ["FundaCAD.Screws", "Make a custom one from this"],
  ["FundaCAD.Navigation", "Middle orbits, Shift+middle pans"],
  ["FundaCAD.Navigation", "fundacad.navigation.plugin"],
  ["FundaCAD.ReferenceImages", "Click the first point on the image"],
  ["FundaCAD.ReferenceImages", "ri-file-input"],
];

if (!existsSync(dir)) {
  console.error(`no ${dir}: run \`npx vite build\` first`);
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
if (!files.length) {
  console.error(`no .js in ${dir}`);
  process.exit(2);
}

const bundle = files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
// A bundle this could not read would pass every marker.
if (bundle.length < 100_000) {
  console.error(`${dir} is only ${bundle.length} bytes, which is not an app`);
  process.exit(2);
}

const found = MARKERS.filter(([, marker]) => bundle.includes(marker));
for (const [id, marker] of MARKERS) {
  const hit = bundle.includes(marker);
  console.log(`${hit ? "FAIL" : "OK  "} ${id}: ${marker}`);
}

if (found.length) {
  console.error(
    `\n${found.length} plugin marker(s) in the shipped bundle. A plugin's code is ` +
      "compiled into the app, which is what the dev branch in src/plugins/activate.ts " +
      "exists to prevent.",
  );
  process.exit(1);
}
console.log(`\nOK ${files.length} chunks, ${bundle.length} bytes, no plugin code`);

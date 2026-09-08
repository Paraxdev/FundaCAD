// Does the shipped bundle contain any plugin's code?
//
// The claim this checks is the whole of "we do not ship the plugins": a built
// app carries the loader and nothing to load. It is worth checking rather than
// remembering because the mechanism that makes it true is one expression —
// `import.meta.env.DEV` in src/plugins/activate.ts, which vite replaces with
// `false` so rollup drops the branch, the dynamic import inside it, and
// src/plugins/devPlugins.ts with its glob of every plugin directory.
//
// Nothing fails loudly if that branch is written a way rollup cannot drop. The
// app keeps working, the plugins keep running from the bundle, and the switch
// quietly becomes a claim rather than a fact. So the artifact is read.
//
// Usage:  node scripts/check-no-plugin-code.mjs [dist/assets]

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "dist/assets";

/** Strings that appear in a plugin's code and in no core module.
 *
 *  Chosen to be things the plugin DOES rather than things it is called: an id
 *  or a display name could legitimately reach the app (the offer list reads
 *  every manifest, which is a few hundred bytes and is meant to be there). A
 *  Rust command name, a CSS class only that plugin's markup uses, and an
 *  exported function name are none of them explicable any other way.
 *
 *  One per plugin at least, so a check that stopped finding anything is a
 *  check that stopped working rather than a bundle that got cleaner. */
const MARKERS = [
  ["FundaCAD.SpaceMouse", "spacemouse_start"],
  ["FundaCAD.SpaceMouse", "getSpaceMouseConfig"],
  ["FundaCAD.Printing", "printerCameraStart"],
  ["FundaCAD.Printing", "print-status-pill"],
  ["FundaCAD.MultiColor", "nearestPaletteSlot"],
  ["FundaCAD.MultiColor", "pal-swatch"],
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
// The control on the reading itself. A bundle this check could not read would
// pass every marker below without looking at anything.
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

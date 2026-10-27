// Refuses raw buttons, inputs, selects and the like outside src/components/ui, past the counts in
// scripts/ui-controls-allow.json. The scan is scripts/uiControls.mjs, which tests/ui/uiControls.test.ts runs too.
//
//   node scripts/check-ui-controls.mjs                  check
//   node scripts/check-ui-controls.mjs --lower          lower the allowlist to what is found, then check
//   node scripts/check-ui-controls.mjs --legacy-classes also refuse the old class names (on from wave 4)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAllowlist, formatAllowlist, isScanned, lowerAllowlist, scanControls } from "./uiControls.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowPath = path.join(root, "scripts", "ui-controls-allow.json");
const args = new Set(process.argv.slice(2));

function walk(dir, out) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "target", "dist"].includes(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (isScanned(rel)) out[rel] = readFileSync(path.join(root, rel), "utf8");
  }
  return out;
}

const files = walk("plugins", walk("src", {}));
const findings = scanControls(files, { legacyClasses: args.has("--legacy-classes") });
let allow = JSON.parse(readFileSync(allowPath, "utf8"));

if (args.has("--lower")) {
  allow = lowerAllowlist(findings, allow);
  writeFileSync(allowPath, formatAllowlist(allow));
}

const problems = checkAllowlist(findings, allow);
if (problems.length) {
  console.error(`ui controls: ${problems.length} problem(s) against scripts/ui-controls-allow.json\n`);
  for (const p of problems) console.error(p);
  console.error("\nUse the base component named above. A migration lowers its entry, --lower does that for you.");
  process.exit(1);
}
const inFiles = new Set(findings.map((f) => f.path)).size;
console.log(`ui controls: ${findings.length} allowlisted raw controls in ${inFiles} files, nothing new`);

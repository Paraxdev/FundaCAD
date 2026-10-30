// Refuses font sizes outside the --fs-* tokens past the counts in scripts/font-size-allow.json.
//   --lower   lowers the allowlist to what is found, never raises it, then checks

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAllowlist, formatAllowlist, isScanned, lowerAllowlist, scanFontSizes } from "./fontSizes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowPath = path.join(root, "scripts", "font-size-allow.json");
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

const findings = scanFontSizes(walk("plugins", walk("src", {})));
let allow = JSON.parse(readFileSync(allowPath, "utf8"));

if (args.has("--lower")) {
  allow = lowerAllowlist(findings, allow);
  writeFileSync(allowPath, formatAllowlist(allow));
}

const problems = checkAllowlist(findings, allow);
if (problems.length) {
  console.error(`font sizes: ${problems.length} problem(s) against scripts/font-size-allow.json\n`);
  for (const p of problems) console.error(p);
  console.error(
    "\nSize text with var(--fs-micro), --fs-small, --fs-body, --fs-title or --fs-display. A move to tokens",
  );
  console.error("lowers its entry, --lower does that for you.");
  process.exit(1);
}
const inFiles = new Set(findings.map((f) => f.path)).size;
console.log(`font sizes: ${findings.length} allowlisted sizes outside the tokens in ${inFiles} files, nothing new`);

// Refuses raw UI text outside t() past the counts in scripts/ui-strings-allow.json.
//   --lower   lowers the allowlist to what is found, never raises it, then checks

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAllowlist, formatAllowlist, isScanned, lowerAllowlist, scanStrings } from "./uiStrings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowPath = path.join(root, "scripts", "ui-strings-allow.json");
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

const findings = scanStrings(walk("plugins", walk("src", {})));
let allow = JSON.parse(readFileSync(allowPath, "utf8"));

if (args.has("--lower")) {
  allow = lowerAllowlist(findings, allow);
  writeFileSync(allowPath, formatAllowlist(allow));
}

const problems = checkAllowlist(findings, allow);
if (problems.length) {
  console.error(`ui strings: ${problems.length} problem(s) against scripts/ui-strings-allow.json\n`);
  for (const p of problems) console.error(p);
  console.error("\nAdd the text to src/i18n/locales/en.json and show it with t(). A conversion lowers its entry,");
  console.error("--lower does that for you.");
  process.exit(1);
}
const inFiles = new Set(findings.map((f) => f.path)).size;
console.log(`ui strings: ${findings.length} allowlisted raw strings in ${inFiles} files, nothing new`);

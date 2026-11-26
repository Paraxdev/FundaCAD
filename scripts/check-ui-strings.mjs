// Refuses raw UI text outside t() past the counts in scripts/ui-strings-allow.json, and a thrown English sentence
// not listed in scripts/thrown-allow.json.
//   --lower   lowers the allowlist to what is found, never raises it, then checks

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkAllowlist,
  checkThrown,
  formatAllowlist,
  isScanned,
  isThrownScanned,
  lowerAllowlist,
  scanStrings,
  scanThrown,
} from "./uiStrings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowPath = path.join(root, "scripts", "ui-strings-allow.json");
const thrownPath = path.join(root, "scripts", "thrown-allow.json");
const args = new Set(process.argv.slice(2));

function walk(dir, out) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "target", "dist"].includes(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (isScanned(rel) || isThrownScanned(rel)) out[rel] = readFileSync(path.join(root, rel), "utf8");
  }
  return out;
}

const files = walk("plugins", walk("src", {}));
const findings = scanStrings(files);
const thrown = scanThrown(files);
const thrownProblems = checkThrown(thrown, JSON.parse(readFileSync(thrownPath, "utf8")));
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
if (thrownProblems.length) {
  console.error(`thrown sentences: ${thrownProblems.length} problem(s) against scripts/thrown-allow.json
`);
  for (const p of thrownProblems) console.error(p);
  process.exit(1);
}
const inFiles = new Set(findings.map((f) => f.path)).size;
console.log(`ui strings: ${findings.length} allowlisted raw strings in ${inFiles} files, nothing new`);
const thrownFiles = new Set(thrown.map((f) => f.path)).size;
console.log(`thrown sentences: ${thrown.length} kept English in ${thrownFiles} files, nothing new`);

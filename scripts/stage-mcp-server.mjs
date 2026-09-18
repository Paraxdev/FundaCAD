#!/usr/bin/env node
// Build fundacad-mcp in release and stage it where the pre-alpha bundle config
// (src-tauri/tauri.prealpha.conf.json, `externalBin`) picks it up:
// src-tauri/binaries/fundacad-mcp-<host triple>[.exe]. Tauri strips the triple
// and installs it beside the app executable, in the installer, the .msi the
// portable zip is unpacked from, the AppImage and the .app.
//
// Run by the pre-alpha config's beforeBuildCommand, so a plain
// `npx tauri build --config src-tauri/tauri.prealpha.conf.json --features rust-engine`
// ships it. `--no-build` stages a binary built earlier.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cargo = process.env.CARGO || "cargo";
const exe = process.platform === "win32" ? ".exe" : "";

const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split("\n")
  .find((l) => l.startsWith("host: "))
  ?.slice(6)
  .trim();
if (!host) throw new Error("rustc -vV named no host triple");

if (!process.argv.includes("--no-build")) {
  execFileSync(cargo, ["build", "--release", "--locked", "--package", "fundacad-mcp"], {
    cwd: repo,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(repo, "target");
const built = join(targetDir, "release", `fundacad-mcp${exe}`);
if (!existsSync(built)) throw new Error(`${built} is not there, build it with cargo build --release -p fundacad-mcp`);

const out = join(repo, "src-tauri", "binaries");
mkdirSync(out, { recursive: true });
const staged = join(out, `fundacad-mcp-${host}${exe}`);
copyFileSync(built, staged);
console.error(`staged ${built} as ${staged}`);

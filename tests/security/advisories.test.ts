// The shipped crates that had advisories, and the first release outside each range. A lockfile that resolves one of
// them below it ships the advisory again, whichever crate pulled it in.

import { describe, expect, it } from "vitest";

import engineLockRaw from "../../Cargo.lock?raw";
import appLockRaw from "../../src-tauri/Cargo.lock?raw";
import betaRaw from "../../src-tauri/tauri.beta.conf.json?raw";
import stableRaw from "../../src-tauri/tauri.stable.conf.json?raw";
import devRaw from "../../src-tauri/tauri.dev.conf.json?raw";

const FIXED_IN: Record<string, string> = {
  zip: "9.0.5",
  wasmtime: "48.0.7",
  "wasmtime-wasi": "48.0.7",
  rustls: "0.23.46",
};

function locked(lock: string, name: string): string[] {
  return lock.split("[[package]]").flatMap((block) => {
    const n = /^name = "(.+)"$/m.exec(block)?.[1];
    const v = /^version = "(.+)"$/m.exec(block)?.[1];
    return n === name && v !== undefined ? [v] : [];
  });
}

function isBelow(version: string, fixed: string): boolean {
  const a = version.split(/[.+-]/).slice(0, 3).map(Number);
  const b = fixed.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function inAdvisoryRange(lock: string): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(FIXED_IN).map(([name, fixed]) => [name, locked(lock, name).filter((v) => isBelow(v, fixed))]),
  );
}

const none = { zip: [], wasmtime: [], "wasmtime-wasi": [], rustls: [] };

describe("dependency advisories", () => {
  it("reads every zip the lockfiles resolve", () => {
    expect([locked(engineLockRaw, "zip").length > 0, locked(appLockRaw, "zip").length > 0]).toEqual([true, true]);
  });

  it("the engine lockfile resolves nothing inside an advisory range", () => {
    expect(inAdvisoryRange(engineLockRaw)).toEqual(none);
  });

  it("the app lockfile resolves nothing inside an advisory range", () => {
    expect(inAdvisoryRange(appLockRaw)).toEqual(none);
  });

  // The updater's zip feature only unpacks v1 compatible bundles (.zip on Windows, .tar.gz on Linux), so it is built
  // without it, and that holds only while every release makes v2 bundles.
  it("every release config makes the v2 updater bundles", () => {
    const made = [betaRaw, stableRaw, devRaw].map(
      (raw) => (JSON.parse(raw) as { bundle: { createUpdaterArtifacts: unknown } }).bundle.createUpdaterArtifacts,
    );
    expect(made).toEqual([true, true, true]);
  });
});

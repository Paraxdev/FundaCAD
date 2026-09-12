// Every Tauri fs call the app makes needs its own permission in the capability
// file, and a missing one only shows up in the packaged app, as a dialog, at the
// moment the user tries to save. Saving a rendered image called writeFile while
// only the TEXT variants were allowed, so "Save image" failed for everyone. This
// reads the source for fs plugin calls and the capability for their permissions.
//
// Sources come from import.meta.glob, as in vHtmlPolicy.test.ts: no @types/node.

import { describe, expect, it } from "vitest";

const sources = import.meta.glob(["../../src/**/*.ts", "../../src/**/*.vue"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const capabilityText = Object.values(import.meta.glob("../../src-tauri/capabilities/default.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>)[0]!;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe("Tauri fs permissions", () => {
  const calls = new Set<string>();
  for (const text of Object.values(sources)) {
    for (const m of text.matchAll(/import\("@tauri-apps\/plugin-fs"\)\)\.(\w+)\(/g)) calls.add(m[1]!);
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@tauri-apps\/plugin-fs["']/g)) {
      for (const name of m[1]!.split(",")) if (name.trim()) calls.add(name.trim().split(/\s+as\s+/)[0]!);
    }
  }
  const capability = JSON.parse(capabilityText) as { permissions: (string | { identifier: string })[] };
  const granted = new Set(capability.permissions.map((p) => (typeof p === "string" ? p : p.identifier)));

  it("finds the fs calls, so the check is not vacuous", () => {
    expect([...calls]).toEqual(expect.arrayContaining(["readTextFile", "writeTextFile", "writeFile"]));
  });

  it("grants a permission for every fs call", () => {
    const missing = [...calls].map((c) => `fs:allow-${kebab(c)}`).filter((p) => !granted.has(p));
    expect(missing).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// WebKit before 16.4 (the macOS 11 system WebKit, WebKitGTK before 2.40 on .deb and .rpm) rejects a regex
// lookbehind when it parses the file, so one in a statically imported module leaves the window blank.
const LOOKBEHIND = /\(\?<[!=]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return sources(path);
    return /\.(ts|vue)$/.test(d.name) ? [path] : [];
  });
}

describe("syntax older WebKit parses", () => {
  it("finds a lookbehind, either kind, and leaves a named group alone", () => {
    expect(["/(?<!a)b/", "/(?<=x)y/", "/(?<name>z)/", "/a(?!b)/"].map((s) => LOOKBEHIND.test(s))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("has no regex lookbehind in src or plugins", () => {
    const root = join(__dirname, "..", "..");
    const found = [...sources(join(root, "src")), ...sources(join(root, "plugins"))]
      .filter((f) => LOOKBEHIND.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).replace(/\\/g, "/"));
    expect(found).toEqual([]);
  });
});

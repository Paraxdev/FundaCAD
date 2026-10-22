import { describe, expect, it } from "vitest";

// WebKit before 16.4 (the macOS 11 system WebKit, WebKitGTK before 2.40 on .deb and .rpm) rejects a regex
// lookbehind when it parses the file, so one in a statically imported module leaves the window blank.
const LOOKBEHIND = /\(\?<[!=]/;

const sources = {
  ...(import.meta.glob("../../src/**/*.{ts,vue}", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >),
  ...(import.meta.glob("../../plugins/**/*.{ts,vue}", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >),
};

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
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    const found = Object.entries(sources)
      .filter(([, text]) => LOOKBEHIND.test(text))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });
});

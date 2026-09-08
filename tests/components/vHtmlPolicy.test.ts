// v-html is the one way to reintroduce the XSS surface this migration exists to
// remove. The app runs in a privileged Tauri webview, and the imperative UI
// needed ~37 hand-placed esc() calls to stay safe; interpolation now does that
// automatically EXCEPT inside v-html.
//
// Exactly one component may use it: Icon.vue, over icons.ts's compile-time
// constant path table. This test is the enforcement.
//
// Sources come from import.meta.glob rather than node:fs so the check needs no
// @types/node and no __dirname, it is Vite reading the same files it builds.
// The glob is EVERY .vue in src, not just components/: a policy that skips a
// directory is a policy with a hole in it.

import { describe, it, expect } from "vitest";

const sources = import.meta.glob("../../src/**/*.vue", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ALLOWED = ["Icon.vue"];

describe("v-html policy", () => {
  it("finds the components to check", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it("is used only by Icon.vue", () => {
    const offenders = Object.entries(sources)
      .filter(([, src]) => /\bv-html\b/.test(src))
      .map(([path]) => path.split("/").pop()!)
      .filter((name) => !ALLOWED.includes(name));

    // If this fails: use {{ }} or a :attr binding instead. If the content is
    // genuinely trusted markup, it belongs in a component, not a string.
    expect(offenders).toEqual([]);
  });
});

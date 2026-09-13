// Every mark in the UI is an SVG file (src/assets/icons). A character standing
// in for an icon, a × close button, a ⋯ overflow, a ∠ field label, renders in
// whatever font the platform falls back to, at a weight and baseline of its own.

import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Arrows, math operators, technical, box drawing, geometric shapes, misc symbols,
// dingbats, emoji, and the Latin-1 multiplication sign.
const SYMBOL = /[×←-⇿∀-⋿⌀-⏿─-➿⬀-⯿\u{1f300}-\u{1faff}]/u;

/** Not icons: characters a parser reads, each with the reason. */
const ALLOWED: { file: string; text: string; why: string }[] = [
  { file: "src/ui/measure.ts", text: "×", why: "typed input, 10×20 is multiplication" },
];

const allowed = (file: string, text: string) =>
  ALLOWED.some((a) => file.endsWith(a.file) && a.text === text);

describe("no text icons", () => {
  it("finds the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
  });

  it("no string literal is only a symbol", () => {
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/(["'`])([^"'`\w\s]{1,3})\1/g)) {
        const text = m[2]!;
        if (SYMBOL.test(text) && !allowed(file, text)) offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no template text node is only a symbol or an entity", () => {
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      if (!file.endsWith(".vue")) continue;
      const template = src.slice(src.indexOf("<template"));
      for (const m of template.matchAll(/>\s*([^<>{}\w\s]{1,3}|&(?:#\d+|#x[\da-f]+|times|hellip|larr|rarr|uarr|darr|harr|check|cross);)\s*</gi)) {
        const text = m[1]!;
        if (text.startsWith("&") || SYMBOL.test(text)) offenders.push(`${file}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

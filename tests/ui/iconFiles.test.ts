// The icon files are markup that reaches the DOM through Icon.vue's v-html, so
// what may be in them is a security rule, not a style note.

import { describe, expect, it } from "vitest";
import { FORGE_PACK, ANVIL_PACK, innerSvg } from "../../src/ui/icons";

const files = import.meta.glob<string>("../../src/assets/icons/*/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

const sources = import.meta.glob<string>("../../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("icon files", () => {
  it("finds the packs", () => {
    expect(Object.keys(FORGE_PACK.paths).length).toBeGreaterThan(100);
    expect(Object.keys(ANVIL_PACK.paths).length).toBeGreaterThan(0);
  });

  it("each is one 24x24 svg with nothing that runs or loads", () => {
    for (const [path, raw] of Object.entries(files)) {
      const src = raw.trim();
      expect(src, path).toMatch(/^<svg\b[^>]*\bviewBox="0 0 24 24"[^>]*>[\s\S]*<\/svg>$/);
      expect(src, path).not.toMatch(/<script|<foreignObject|<style|<image|<use\b/i);
      expect(src, path).not.toMatch(/\son\w+\s*=/i);
      expect(src, path).not.toMatch(/(xlink:)?href\s*=|url\(|javascript:/i);
      expect(innerSvg(src), path).not.toBe("");
    }
  });

  it("paints only with the text colour", () => {
    for (const [path, raw] of Object.entries(files)) {
      for (const m of raw.matchAll(/\b(fill|stroke|color|stop-color)="([^"]*)"/g)) {
        expect(["currentColor", "none"], `${path}: ${m[0]}`).toContain(m[2]);
      }
    }
  });

  it("every icon every other pack draws also exists in the default pack", () => {
    for (const name of Object.keys(ANVIL_PACK.paths)) {
      expect(FORGE_PACK.paths[name], name).toBeTruthy();
    }
  });

  it("every icon named in the app's source has a file", () => {
    const named = new Set<string>();
    const patterns = [
      /<Icon\b[^>]*?\sname="([\w-]+)"/g,
      /\biconName:\s*"([\w-]+)"/g,
      /\bicon:\s*"([\w-]+)"/g,
      /\biconElement\("([\w-]+)"/g,
    ];
    for (const src of Object.values(sources)) {
      for (const re of patterns) for (const m of src.matchAll(re)) named.add(m[1]!);
    }
    expect(named.size).toBeGreaterThan(50);
    const missing = [...named].filter((n) => !FORGE_PACK.paths[n]);
    expect(missing).toEqual([]);
  });
});

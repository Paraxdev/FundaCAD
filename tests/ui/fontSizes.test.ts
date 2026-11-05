import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";
import {
  checkAllowlist,
  formatAllowlist,
  isScanned,
  isTokened,
  lowerAllowlist,
  scanFontSizes,
  shorthandSize,
} from "../../scripts/fontSizes.mjs";
import allowText from "../../scripts/font-size-allow.json?raw";

const glob = {
  ...import.meta.glob("../../src/**/*.{scss,css,vue,ts}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../plugins/**/*.{scss,css,vue,ts}", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

const sources = Object.fromEntries(
  Object.entries(glob)
    .map(([k, v]) => [k.replace(/^(\.\.\/)+/, ""), v] as const)
    .filter(([k]) => isScanned(k)),
);

const found = (files: Record<string, string>) => scanFontSizes(files).map((f) => `${f.path}:${f.line} ${f.decl}`);
const vue = (template: string, style: string, script = "") =>
  `<script setup lang="ts">\n${script}\n</script>\n\n<template>\n${template}\n</template>\n\n<style scoped lang="scss">\n${style}\n</style>\n`;

describe("the sources as they are", () => {
  it("finds the stylesheets and components to check", () => {
    expect(Object.keys(sources).some((p) => p.endsWith(".scss"))).toBe(true);
    expect(Object.keys(sources).some((p) => p.startsWith("plugins/"))).toBe(true);
  });

  it("matches the allowlist exactly", () => {
    // Above the list: size the text with a --fs-* token. Below it: run node scripts/check-font-sizes.mjs --lower.
    expect(checkAllowlist(scanFontSizes(sources), JSON.parse(allowText))).toEqual([]);
  });

  it("keeps the allowlist in its own format", () => {
    expect(formatAllowlist(JSON.parse(allowText))).toBe(allowText.replace(/\r\n/g, "\n"));
  });

  it("runs in CI before the dependencies install", () => {
    const at = workflow.indexOf("run: node scripts/check-font-sizes.mjs");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(workflow.indexOf("npm ci"));
  });
});

describe("sizes in a stylesheet", () => {
  it("reports px and em sizes and the size in a font shorthand, on their lines", () => {
    const scss = [
      ".a { font-size: 10px; }",
      ".b {",
      "  font: 700 9px/14px var(--ui);",
      "  font:",
      "    11px/1.4 ui-monospace,",
      '    "SF Mono";',
      "  font-size: 0.9em !important;",
      "}",
    ].join("\n");
    expect(found({ "src/styles/_x.scss": scss })).toEqual([
      "src/styles/_x.scss:1 font-size: 10px",
      "src/styles/_x.scss:3 font: 700 9px/14px var(--ui)",
      'src/styles/_x.scss:4 font: 11px/1.4 ui-monospace, "SF Mono"',
      "src/styles/_x.scss:7 font-size: 0.9em !important",
    ]);
  });

  it("passes the tokens, a scaled token, a token with a fallback and the global keywords", () => {
    const scss = [
      ".a { font-size: var(--fs-micro); }",
      ".b { font: 500 var(--fs-small)/20px var(--ui); }",
      ".c { font-size: calc(var(--fs-body) * var(--vp-label-scale)); }",
      ".d { font-size: var(--fs-title, 15px); font: inherit; font-size: inherit; }",
      ".e { --fs-micro: 0.6875rem; --chip-font-size: 10px; font-family: var(--mono); }",
    ].join("\n");
    expect(found({ "src/styles/_x.scss": scss })).toEqual([]);
  });

  it("skips comments and selectors that only look like the property", () => {
    const scss = ["// font-size: 10px", "/* font: 9px/1 x; */", ".font:hover { color: red; }", ".font-size:hover {}"];
    expect(found({ "src/styles/_x.scss": scss.join("\n") })).toEqual([]);
  });

  it("reports a token with a raw length added", () => {
    expect(isTokened("calc(var(--fs-body) + 2px)")).toBe(false);
    expect(isTokened("var(--size)")).toBe(false);
    expect(isTokened("smaller")).toBe(false);
  });
});

describe("sizes in a component", () => {
  it("reads the style block, inline styles and style objects, and skips the rest", () => {
    const src = vue(
      [
        `<span style="opacity: 0.6; font-size: 11px">a</span>`,
        `<span :style="{ color: 'red', fontSize: '12px' }">b</span>`,
        `<span :style="{ fontSize: 'var(--fs-micro)' }">c</span>`,
        `<!-- <span style="font-size: 9px"> -->`,
      ].join("\n"),
      ".x { font-size: 13px; }\n.y { font-size: var(--fs-body); }",
      `const box = { font: "12px system-ui, sans-serif" };\nconst field = { font: "inherit" };\nlet font: string;`,
    );
    expect(found({ "plugins/P/A.vue": src })).toEqual([
      "plugins/P/A.vue:2 font: 12px system-ui, sans-serif",
      "plugins/P/A.vue:8 font-size: 11px",
      "plugins/P/A.vue:9 fontSize: 12px",
      "plugins/P/A.vue:15 font-size: 13px",
    ]);
  });

  it("leaves canvas fonts in TS alone", () => {
    expect(found({ "src/viewport/x.ts": `ctx.font = "600 56px Inter, system-ui";` })).toEqual([]);
    expect(found({ "src/x.ts": `el.style.cssText = "font-size: 10px";` })).toEqual(["src/x.ts:1 font-size: 10px"]);
  });

  it("only looks at src and plugins", () => {
    expect(isScanned("src/styles/_x.scss")).toBe(true);
    expect(isScanned("plugins/P/A.vue")).toBe(true);
    expect(isScanned("tests/ui/x.spec.ts")).toBe(false);
    expect(isScanned("src/node_modules/x/a.css")).toBe(false);
  });
});

describe("the shorthand size", () => {
  it("is the token before the line height, or else the first size like token", () => {
    expect(shorthandSize("600 var(--fs-small)/26px var(--ui)")).toBe("var(--fs-small)");
    expect(shorthandSize("italic small-caps 600 12px system-ui, sans-serif")).toBe("12px");
    expect(shorthandSize("string")).toBeNull();
  });
});

describe("the allowlist ratchet", () => {
  const entry = (count: number, path = "src/a.scss") => ({ path, count, reason: "before the tokens" });
  const hits = (n: number, path = "src/a.scss") =>
    Array.from({ length: n }, (_, i) => ({ path, line: i + 1, decl: "font-size: 10px" }));

  it("fails a new size, a size past its count and a count left too high", () => {
    expect(checkAllowlist(hits(1, "src/b.scss"), [])[0]).toMatch(
      /^src\/b\.scss: 1 font sizes .* allows 0\n {2}src\/b\.scss:1 font-size: 10px, use a var\(--fs-\*\) token$/,
    );
    expect(checkAllowlist(hits(3), [entry(2)])[0]).toMatch(/3 font sizes outside the tokens, the allowlist allows 2/);
    expect(checkAllowlist(hits(1), [entry(2)])).toEqual([
      "src/a.scss: 1 font sizes outside the tokens, the allowlist allows 2, lower its count to 1",
    ]);
    expect(checkAllowlist([], [entry(2)])[0]).toMatch(/remove the entry$/);
    expect(checkAllowlist(hits(2), [entry(2)])).toEqual([]);
  });

  it("refuses a bad or twice listed entry", () => {
    expect(checkAllowlist([], [{ path: "src/a.scss", count: 0, reason: "" }])[0]).toMatch(/needs a path/);
    expect(checkAllowlist(hits(1), [entry(1), entry(1)])[0]).toMatch(/listed twice/);
  });

  it("lowers counts and drops spent entries, never raising one", () => {
    const allow = [entry(3), entry(1, "src/gone.scss")];
    expect(lowerAllowlist(hits(2), allow)).toEqual([entry(2)]);
    expect(lowerAllowlist(hits(5), [entry(1)])).toEqual([entry(1)]);
  });
});

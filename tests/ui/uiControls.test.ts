import { describe, expect, it } from "vitest";

import {
  checkAllowlist,
  formatAllowlist,
  isScanned,
  lowerAllowlist,
  scanControls,
  useInstead,
} from "../../scripts/uiControls.mjs";
import allowText from "../../scripts/ui-controls-allow.json?raw";

const glob = {
  ...import.meta.glob("../../src/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../plugins/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

const sources = Object.fromEntries(
  Object.entries(glob)
    .map(([k, v]) => [k.replace(/^(\.\.\/)+/, ""), v] as const)
    .filter(([k]) => isScanned(k)),
);

const kinds = (files: Record<string, string>, opts?: { legacyClasses?: boolean }) =>
  scanControls(files, opts).map((f) => `${f.path}:${f.line} ${f.kind}`);

const vue = (template: string, script = "") =>
  `<script setup lang="ts">\n${script}\n</script>\n\n<template>\n${template}\n</template>\n`;

describe("the sources as they are", () => {
  it("finds the files to check", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(300);
    expect(Object.keys(sources).some((p) => p.startsWith("plugins/"))).toBe(true);
  });

  it("matches the allowlist exactly", () => {
    // Above the list: use the base component the message names. Below it: lower the count, or run
    // node scripts/check-ui-controls.mjs --lower.
    expect(checkAllowlist(scanControls(sources), JSON.parse(allowText))).toEqual([]);
  });

  it("keeps the allowlist in its own format", () => {
    expect(formatAllowlist(JSON.parse(allowText))).toBe(allowText.replace(/\r\n/g, "\n"));
  });
});

describe("raw control tags in a .vue template", () => {
  it("reports each tag by kind, on its line", () => {
    const src = vue(
      [
        `<div>`,
        `  <button class="x" @click="a > b">Go</button>`,
        `  <input`,
        `    type="checkbox"`,
        `  />`,
        `  <input v-model="t">`,
        `  <input :type="kind">`,
        `  <select v-model="s"></select>`,
        `  <textarea />`,
        `</div>`,
      ].join("\n"),
    );
    expect(kinds({ "src/components/A.vue": src })).toEqual([
      "src/components/A.vue:7 button",
      "src/components/A.vue:8 input[type=checkbox]",
      "src/components/A.vue:11 input[type=text]",
      "src/components/A.vue:12 input",
      "src/components/A.vue:13 select",
      "src/components/A.vue:14 textarea",
    ]);
  });

  it("is case sensitive, so a base component is not a raw tag", () => {
    expect(kinds({ "src/components/A.vue": vue(`<Button /><Select /><buttons /><TextField />`) })).toEqual([]);
  });

  it("skips comments and the script block", () => {
    const src = vue(`<!-- a <button> once lived here -->\n<span />`, `const s = pick<select>(a);`);
    expect(kinds({ "src/components/A.vue": src })).toEqual([]);
  });

  it("reports a control role on a plain element, not on a component", () => {
    const src = vue(
      [
        `<div role="button" />`,
        `<span role="switch" />`,
        `<li role="tab" />`,
        `<div role="menuitem" />`,
        `<i role="radio" />`,
        `<div role="dialog" />`,
        `<Chip role="button" />`,
      ].join("\n"),
    );
    expect(kinds({ "src/components/A.vue": src })).toEqual([
      "src/components/A.vue:6 role=button",
      "src/components/A.vue:7 role=switch",
      "src/components/A.vue:8 role=tab",
      "src/components/A.vue:9 role=menuitem",
      "src/components/A.vue:10 role=radio",
    ]);
  });

  it("checks plugins too", () => {
    expect(kinds({ "plugins/FundaCAD.X/Panel.vue": vue(`<button />`) })).toEqual([
      "plugins/FundaCAD.X/Panel.vue:6 button",
    ]);
  });
});

describe("controls built in TS", () => {
  it("reports createElement of a control tag", () => {
    const src = [
      `const b = document.createElement("button");`,
      `const i = document.createElement('input');`,
      `const d = document.createElement("div");`,
    ].join("\n");
    expect(kinds({ "src/sketch/x.ts": src })).toEqual([
      "src/sketch/x.ts:1 createElement:button",
      "src/sketch/x.ts:2 createElement:input",
    ]);
  });

  it("reports control tags in strings and template strings", () => {
    const src = [
      "el.innerHTML = `<div>${a ? `<button>x</button>` : ''}</div>`;",
      `const h = "<select id=s>";`,
      `const ok = a < input;`,
    ].join("\n");
    expect(kinds({ "src/sketch/x.ts": src })).toEqual([
      "src/sketch/x.ts:1 html:button",
      "src/sketch/x.ts:2 html:select",
    ]);
  });

  it("skips comments, regex literals and code", () => {
    const src = [
      `// makes a <button> once`,
      `/* document.createElement("input") */`,
      `const re = /<button/;`,
      `const u = "https://example.com"; // then <input>`,
      "type T = Array<input>;",
    ].join("\n");
    expect(kinds({ "src/sketch/x.ts": src })).toEqual([]);
  });

  it("checks a .vue script block too", () => {
    const src = vue(`<div />`, `const b = document.createElement("button");`);
    expect(kinds({ "src/components/A.vue": src })).toEqual(["src/components/A.vue:2 createElement:button"]);
  });
});

describe("inline styles", () => {
  it("reports a style attribute with a colour, a border or a font", () => {
    const src = vue(
      [
        `<div style="color: #ff9a5c" />`,
        `<div :style="{ border: '1px solid' }" />`,
        `<div style="font: 12px system-ui" />`,
        `<div style="flex: 1" />`,
        `<div :style="{ background: m.color }" />`,
        `<div :style="{ '--key': cssHex(k) }" />`,
      ].join("\n"),
    );
    expect(kinds({ "src/components/A.vue": src })).toEqual([
      "src/components/A.vue:6 style:inline",
      "src/components/A.vue:7 style:inline",
      "src/components/A.vue:8 style:inline",
    ]);
  });

  it("reports a CSSProperties object with a colour, a border or a font", () => {
    const script = [
      `const root: CSSProperties = {`,
      `  background: "#161a20",`,
      `};`,
      `const row: CSSProperties = { display: "flex", gap: "6px" };`,
      `const bad: CSSProperties = { borderColor: "var(--error)" };`,
      `const f: CSSProperties = { fontFamily: "system-ui" };`,
    ].join("\n");
    expect(kinds({ "src/components/A.vue": vue(`<div />`, script) })).toEqual([
      "src/components/A.vue:2 style:inline",
      "src/components/A.vue:6 style:inline",
      "src/components/A.vue:7 style:inline",
    ]);
  });
});

describe("icon only controls without a name", () => {
  it("reports an IconButton with no tip, aria-label or aria-labelledby", () => {
    const src = vue(
      [
        `<IconButton icon="x" title="Close" />`,
        `<IconButton icon="x" tip="Close" />`,
        `<IconButton icon="x" :tip="t" />`,
        `<icon-button icon="x" />`,
        `<IconButton icon="x" v-bind="b" />`,
        `<IconButton icon="x" tip="  " />`,
        `<IconButton icon="x" :tip="''" />`,
        `<IconButton icon="x" aria-label="Close" />`,
        `<IconButton icon="x" :aria-labelledby="id" />`,
        `<IconButton icon="x" tip />`,
      ].join("\n"),
    );
    expect(kinds({ "src/components/A.vue": src })).toEqual([
      "src/components/A.vue:6 IconButton:no-name",
      "src/components/A.vue:9 IconButton:no-name",
      "src/components/A.vue:11 IconButton:no-name",
      "src/components/A.vue:12 IconButton:no-name",
      "src/components/A.vue:15 IconButton:no-name",
    ]);
  });

  it("reports a RailButton with no label, since its tip is only a title", () => {
    const src = vue(
      [
        `<RailButton icon="x" label="Sketch" />`,
        `<RailButton icon="x" tip="Sketch" />`,
        `<rail-button icon="x" :label="l" />`,
        `<RailButton icon="x" :label="\`\`" />`,
        `<RailButton icon="x" aria-labelledby="h" />`,
      ].join("\n"),
    );
    expect(kinds({ "src/components/A.vue": src })).toEqual([
      "src/components/A.vue:7 RailButton:no-name",
      "src/components/A.vue:9 RailButton:no-name",
    ]);
  });

  it("reports each Segmented option that shows only an icon with no label or tip", () => {
    const script = [
      `const plain = [{ value: "a", icon: "x" }, { value: "b", icon: "y", tip: "B" }, { value: "c", label: "C" }];`,
      `const views = computed(() => modes.map((m) => ({ value: m, attrs: { "data-m": m } })));`,
      `function named() { return [{ value: 1, icon: "x", attrs: { "aria-label": "One" } }, { ...base, value: 2 }]; }`,
    ].join("\n");
    const src = vue(
      [
        `<Segmented v-model="a" :options="plain" />`,
        `<Segmented v-model="a" :options="views" icon-only />`,
        `<Segmented v-model="a" :options="views" />`,
        `<Segmented v-model="a" :options="named()" icon-only />`,
        `<Segmented v-model="a" :options="[{ value: 'z', icon: 'z' }, { value: 'w', label: 'W' }]" icon-only />`,
        `<Segmented v-model="a" :options="SHARED" />`,
        `<Segmented v-model="a" :options="elsewhere" icon-only />`,
      ].join("\n"),
      script,
    );
    const shared = `export const SHARED = [{ value: "s", icon: "s" }, { value: "t", icon: "t", label: "T" }];\n`;
    expect(kinds({ "src/components/A.vue": src, "src/ui/shared.ts": shared })).toEqual([
      "src/components/A.vue:8 Segmented:no-name",
      "src/components/A.vue:9 Segmented:no-name",
      "src/components/A.vue:12 Segmented:no-name",
      "src/components/A.vue:13 Segmented:no-name",
    ]);
  });

  it("counts a name bound to null, undefined or false as no name", () => {
    const src = vue(
      [
        `<IconButton icon="x" :tip="null" />`,
        `<IconButton icon="x" :tip=" undefined " />`,
        `<RailButton icon="x" :label="false" />`,
        `<IconButton icon="x" :aria-label="null" tip="" />`,
        `<IconButton icon="x" :tip="nullable" />`,
        `<IconButton icon="x" :tip="undefinedTip ?? 'Close'" />`,
      ].join("\n"),
    );
    expect(kinds({ "src/components/A.vue": src })).toEqual([
      "src/components/A.vue:6 IconButton:no-name",
      "src/components/A.vue:7 IconButton:no-name",
      "src/components/A.vue:8 RailButton:no-name",
      "src/components/A.vue:9 IconButton:no-name",
    ]);
  });

  it("follows both branches of a Segmented options ternary", () => {
    const script = [
      `const wide = [{ value: "a", icon: "x" }, { value: "b", icon: "y" }];`,
      `const narrow = [{ value: "a", icon: "x", tip: "A" }, { value: "c", icon: "z" }];`,
    ].join("\n");
    const src = vue(
      [
        `<Segmented v-model="a" :options="roomy ? wide : narrow" />`,
        `<Segmented v-model="a" :options="roomy ? narrow : SHARED" />`,
      ].join("\n"),
      script,
    );
    const shared = `export const SHARED = [{ value: "s", icon: "s" }, { value: "t", icon: "t", label: "T" }];\n`;
    expect(kinds({ "src/components/A.vue": src, "src/ui/shared.ts": shared })).toEqual([
      "src/components/A.vue:7 Segmented:no-name",
      "src/components/A.vue:7 Segmented:no-name",
      "src/components/A.vue:7 Segmented:no-name",
      "src/components/A.vue:8 Segmented:no-name",
      "src/components/A.vue:8 Segmented:no-name",
    ]);
  });
});

describe("legacy classes", () => {
  const src = vue(`<a class="btn btn-primary" /><span class="row check" /><a class="ft-switch-x" />`);

  it("is off by default", () => {
    expect(kinds({ "src/components/A.vue": src })).toEqual([]);
  });

  it("reports each legacy class once its flag is on", () => {
    expect(kinds({ "src/components/A.vue": src }, { legacyClasses: true })).toEqual([
      "src/components/A.vue:6 class:btn",
      "src/components/A.vue:6 class:btn",
      "src/components/A.vue:6 class:check",
    ]);
  });
});

describe("what is scanned", () => {
  it("exempts the base components and dom.ts, and reads only app and plugin sources", () => {
    expect(
      [
        "src/components/ui/Button.vue",
        "src/components/ui/dom.ts",
        "src/components/shell/Rail.vue",
        "src/io/files.ts",
        "plugins/FundaCAD.Screws/main.ts",
        "tests/ui/x.test.ts",
        "plugins/FundaCAD.X/node_modules/y/index.ts",
        "src/styles/main.scss",
      ].map((p) => [p, isScanned(p)]),
    ).toEqual([
      ["src/components/ui/Button.vue", false],
      ["src/components/ui/dom.ts", false],
      ["src/components/shell/Rail.vue", true],
      ["src/io/files.ts", true],
      ["plugins/FundaCAD.Screws/main.ts", true],
      ["tests/ui/x.test.ts", false],
      ["plugins/FundaCAD.X/node_modules/y/index.ts", false],
      ["src/styles/main.scss", false],
    ]);
  });

  it("ignores an exempt file handed to the scan", () => {
    expect(kinds({ "src/components/ui/Tabs.vue": vue(`<button />`) })).toEqual([]);
  });
});

describe("the allowlist ratchet", () => {
  const files = { "src/A.vue": vue(`<button />\n<button />`) };
  const found = scanControls(files);
  const entry = (count: number, reason = "old") => ({ path: "src/A.vue", kind: "button", count, reason });

  it("passes on the exact count", () => {
    expect(checkAllowlist(found, [entry(2)])).toEqual([]);
  });

  it("fails above the count, naming each line and what to use", () => {
    const problems = checkAllowlist(found, [entry(1)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src/A.vue: 2 button, the allowlist allows 1");
    expect(problems[0]).toContain("src/A.vue:6 button");
    expect(problems[0]).toContain(`use ${useInstead("button")}`);
  });

  it("fails on a raw control with no entry", () => {
    expect(checkAllowlist(found, [])[0]).toContain("the allowlist allows 0");
  });

  it("fails below the count, so a migration lowers it", () => {
    expect(checkAllowlist(found, [entry(3)])).toEqual([
      "src/A.vue: 2 button, the allowlist allows 3, lower its count to 2",
    ]);
    expect(checkAllowlist([], [entry(2)])).toEqual(["src/A.vue: 0 button, the allowlist allows 2, remove the entry"]);
  });

  it("refuses a malformed or doubled entry", () => {
    expect(checkAllowlist(found, [entry(2, " "), entry(2)])).toEqual([
      "entry 1 (src/A.vue button): needs a path, a kind, a whole count above 0 and a reason",
      "entry 2 (src/A.vue button): listed twice",
    ]);
  });

  it("lowers counts and drops spent entries but never raises one", () => {
    const allow = [entry(5, "keep"), { path: "src/B.vue", kind: "select", count: 1, reason: "gone" }];
    expect(lowerAllowlist(found, allow)).toEqual([entry(2, "keep")]);
    expect(lowerAllowlist(found, [entry(1)])).toEqual([entry(1)]);
  });

  it("names a base component for every kind it reports", () => {
    for (const k of ["button", "input[type=range]", "select", "role=tab", "createElement:input", "style:inline"]) {
      expect(useInstead(k)).toMatch(/\w/);
    }
  });
});

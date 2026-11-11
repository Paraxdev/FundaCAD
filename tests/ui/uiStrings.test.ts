import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";
import {
  checkAllowlist,
  formatAllowlist,
  isScanned,
  lowerAllowlist,
  scanStrings,
  usedKeys,
  type StringAllowEntry,
} from "../../scripts/uiStrings.mjs";
import allowText from "../../scripts/ui-strings-allow.json?raw";

const glob = {
  ...import.meta.glob("../../src/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../plugins/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

const sources = Object.fromEntries(
  Object.entries(glob)
    .map(([k, v]) => [k.replace(/^(\.\.\/)+/, ""), v] as const)
    .filter(([k]) => isScanned(k)),
);

const found = (files: Record<string, string>) =>
  scanStrings(files).map((f) => `${f.path}:${f.line} ${f.kind} ${f.detail} ${f.text}`);
const ts = (code: string) => found({ "src/ui/panel.ts": code });
// The template's first line is line 6.
const vue = (template: string, script = "") =>
  `<script setup lang="ts">\n${script}\n</script>\n\n<template>\n${template}\n</template>\n`;
const tpl = (template: string) => found({ "src/components/A.vue": vue(template) });

describe("the sources as they are", () => {
  it("finds the files to check, base components included", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(300);
    expect(Object.keys(sources).some((p) => p.startsWith("plugins/"))).toBe(true);
    expect(Object.keys(sources).some((p) => p.startsWith("src/components/ui/"))).toBe(true);
  });

  it("matches the allowlist exactly", () => {
    // Above the list: show the text with t() and a line in en.json. Below it: run
    // node scripts/check-ui-strings.mjs --lower.
    expect(checkAllowlist(scanStrings(sources), JSON.parse(allowText))).toEqual([]);
  });

  it("keeps the allowlist in its own format", () => {
    expect(formatAllowlist(JSON.parse(allowText))).toBe(allowText.replace(/\r\n/g, "\n"));
  });

  it("runs in CI after the dependencies install, beside the type check", () => {
    const install = workflow.indexOf("run: npm ci");
    const guard = workflow.indexOf("run: node scripts/check-ui-strings.mjs");
    const types = workflow.indexOf("run: npm run typecheck");
    expect(install).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(install);
    expect(types).toBeGreaterThan(install);
    expect(workflow.indexOf("run: npx vitest run")).toBeGreaterThan(types);
  });
});

describe("which files are scanned", () => {
  it("takes .vue and .ts under src and plugins, base components included", () => {
    const yes = ["src/ui/stress.ts", "plugins/FundaCAD.Screws/LibraryPanel.vue", "src/components/ui/Dialog.vue"];
    const no = [
      "src/harness/driver.ts",
      "src/i18n/catalog.ts",
      "src/vite-env.d.ts",
      "tests/ui/stress.test.ts",
      "src/styles/_stress.scss",
      "plugins/FundaCAD.Screws/node_modules/x/index.ts",
      "plugins/FundaCAD.Screws/dist/a.ts",
    ];
    expect(yes.map(isScanned)).toEqual([true, true, true]);
    expect(no.map(isScanned)).toEqual([false, false, false, false, false, false, false]);
  });

  it("skips only the harness and i18n folders of src, not names that start alike", () => {
    expect(["src/i18nTools/a.ts", "src/harnessed/a.ts", "plugins/FundaCAD.X/harness/a.ts"].map(isScanned)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("finds nothing in a skipped file even when it holds text", () => {
    const text = 'toast("Saved the part.");\n';
    const files = { "src/harness/driver.ts": text, "src/i18n/index.ts": text, "src/types.d.ts": text };
    expect(found(files)).toEqual([]);
    expect(found({ ...files, "src/components/ui/Chip.ts": text })).toEqual([
      "src/components/ui/Chip.ts:1 script toast() Saved the part.",
    ]);
  });
});

describe("text in a template", () => {
  it("finds nothing in a template without text", () => {
    expect(tpl(`<div class="row"><span>{{ value }}</span> · <b>( 3 )</b>\n  ·\n</div>`)).toEqual([]);
  });

  it("finds one text node on the line its words start", () => {
    expect(tpl(`<div>\n\n    Pick a face\n</div>`)).toEqual(["src/components/A.vue:8 template text Pick a face"]);
  });

  it("finds many text nodes, on one line each, nested and in slots", () => {
    const src = [
      `<Panel>`,
      `  <template #head>Stress   check</template>`,
      `  <p>Fixed faces <b>hold</b> still.</p>`,
      `</Panel>`,
    ].join("\n");
    expect(tpl(src)).toEqual([
      "src/components/A.vue:7 template text Stress check",
      "src/components/A.vue:8 template text Fixed faces",
      "src/components/A.vue:8 template text hold",
      "src/components/A.vue:8 template text still.",
    ]);
  });

  it("needs two letters, so a lone letter or a product word is quiet", () => {
    expect(tpl(`<i>x</i><i>FundaCAD</i><i>WebGPU, STEP / STL 3MF</i>`)).toEqual([]);
    expect(tpl(`<i>Ok</i><i>FundaCAD help</i>`)).toEqual([
      "src/components/A.vue:6 template text Ok",
      "src/components/A.vue:6 template text FundaCAD help",
    ]);
  });

  it("finds literals shown by an interpolation, not those compared or passed to a helper", () => {
    const src = [
      `<span>{{ ok ? "Ready" : "Busy now" }}</span>`,
      `<span>{{ mode === "Fixed corner" ? n : fmt("Some words") }}</span>`,
      `<span>{{ t("stress.load.force") }}{{ "" }}{{ " · " }}{{ map["Big key"] }}</span>`,
    ].join("\n");
    expect(tpl(src)).toEqual([
      "src/components/A.vue:6 template {{ }} Ready",
      "src/components/A.vue:6 template {{ }} Busy now",
    ]);
  });

  it("finds static and bound text attributes, and only text attributes", () => {
    const src = [
      `<FieldRow title="Radius" label="Wall thickness"`,
      `  :tip="'Radius'" :aria-label="busy ? 'Saving the part' : name"`,
      `  :disabled-reason="t('stress.reason')" class="Big Row" data-x="Some words" :value="'Some words'" />`,
    ].join("\n");
    expect(tpl(src)).toEqual([
      "src/components/A.vue:6 template title= Radius",
      "src/components/A.vue:6 template label= Wall thickness",
      "src/components/A.vue:7 template :tip= Radius",
      "src/components/A.vue:7 template :aria-label= Saving the part",
    ]);
  });

  it("reads a template literal in a bound attribute with its holes as an ellipsis", () => {
    expect(tpl('<i :title="`Face ${n} of ${count}`" :alt="`${a}.${b}`" />')).toEqual([
      "src/components/A.vue:6 template :title= Face … of …",
    ]);
  });
});

describe("text in a script", () => {
  it("finds nothing in code without UI text", () => {
    const code = [
      `import { t } from "../i18n";`,
      `const mode = "fixed";`,
      `const kind = "Fixed";`,
      `const key = "stress.load.force";`,
      `el.setAttribute("data-hint", "Some words here");`,
      `console.warn("The mesh came back empty");`,
      `if (state === "Not ready yet") go(t("stress.load.force"));`,
      `type Word = "Two words";`,
      `const css = \`translate(\${x}px, \${y}px)\`;`,
      `const path = \`stress.\${kind}.label\`;`,
      `function f() { throw new Error("The engine refused the build"); }`,
      `const blank = "   ", dots = "…";`,
    ].join("\n");
    expect(ts(code)).toEqual([]);
  });

  it("finds one string passed to a UI sink, a single word included", () => {
    expect(ts(`\n\ntoast("Saved.");`)).toEqual(["src/ui/panel.ts:3 script toast() Saved."]);
  });

  it("finds many: sinks, template literals, text properties and sentences", () => {
    const code = [
      `setStatus(\`Picked \${n} faces\`);`,
      `engine.setPrompt(busy ? "Wait" : "Pick an edge");`,
      `const support = { value: "fixed", label: "Fixed", hint: "Holds the face still" };`,
      `const note = "Stress there grows as the mesh gets finer";`,
      `const sum = \`\${a} faces picked, \${b} left\`;`,
    ].join("\n");
    expect(ts(code)).toEqual([
      "src/ui/panel.ts:1 script setStatus() Picked … faces",
      "src/ui/panel.ts:2 script engine.setPrompt() Wait",
      "src/ui/panel.ts:2 script engine.setPrompt() Pick an edge",
      "src/ui/panel.ts:3 script label: Fixed",
      "src/ui/panel.ts:3 script hint: Holds the face still",
      "src/ui/panel.ts:4 script sentence Stress there grows as the mesh gets finer",
    ]);
  });

  it("guards a thrown message only when it reaches a sink", () => {
    expect(ts(`function f() { throw new Error("The engine refused the build"); }`)).toEqual([]);
    expect(ts(`function f() { throw fail("The engine refused the build"); }`)).toEqual([
      "src/ui/panel.ts:1 script fail() The engine refused the build",
    ]);
  });

  it("places a .vue script string on its line in the file", () => {
    const src = vue(`<div />`, `const a = 1;\nannounce("Part saved");`);
    expect(found({ "src/components/A.vue": src })).toEqual(["src/components/A.vue:3 script announce() Part saved"]);
  });

  it("scans the same source under two paths as two files", () => {
    const src = vue(`<p>Wall thickness</p>`);
    expect(found({ "src/components/B.vue": src, "plugins/FundaCAD.Screws/A.vue": src })).toEqual([
      "plugins/FundaCAD.Screws/A.vue:6 template text Wall thickness",
      "src/components/B.vue:6 template text Wall thickness",
    ]);
  });
});

describe("message keys in use", () => {
  it("is empty without files or calls", () => {
    expect([...usedKeys({})]).toEqual([]);
    expect([...usedKeys({ "src/a.ts": `toast("Saved.");` })]).toEqual([]);
  });

  it("collects literal first arguments of t in scripts and template expressions", () => {
    const code = [
      `t("prefs.language.system", { name });`,
      "t(`stress.load.force`);",
      `t(key);`,
      `i18n.t("not.this");`,
      `toast(t("toast.saved"));`,
    ].join("\n");
    const template = `<p :title="t('panel.title')" @click="say(t('panel.click'))">{{ t("panel.body", { n: 3 }) }}</p>`;
    const keys = usedKeys({ "src/a.ts": code, "src/B.vue": vue(template, `const h = t("panel.head");`) });
    expect([...keys].sort()).toEqual([
      "panel.body",
      "panel.click",
      "panel.head",
      "panel.title",
      "prefs.language.system",
      "stress.load.force",
      "toast.saved",
    ]);
  });
});

describe("the allowlist", () => {
  const files = { "src/ui/A.ts": `\ntoast("Saved the part.");\nsay("Pick a face");\n` };
  const findings = scanStrings(files);
  const entry = (count: number, reason = "before localisation"): StringAllowEntry => ({
    path: "src/ui/A.ts",
    kind: "script",
    count,
    reason,
  });

  it("is quiet at the exact count", () => {
    expect(checkAllowlist(findings, [entry(2)])).toEqual([]);
  });

  it("fails above the count, naming each line and its text", () => {
    expect(checkAllowlist(findings, [entry(1)])).toEqual([
      expect.stringMatching(
        /^src\/ui\/A\.ts: 2 .*allows 1\n {2}src\/ui\/A\.ts:2 toast\(\) "Saved the part\.".*t\(\)\n {2}src\/ui\/A\.ts:3 say\(\) "Pick a face"/,
      ),
    ]);
    expect(checkAllowlist(findings, [])).toEqual([expect.stringMatching(/^src\/ui\/A\.ts: 2 .*allows 0\n/)]);
  });

  it("points a plugin's raw text at that plugin's own language file, core text at the core's", () => {
    const code = (path: string) => scanStrings({ [path]: `toast("Saved the part.");` });
    const plugin = checkAllowlist(code("plugins/Acme.Tool/main.ts"), []);
    expect(plugin).toHaveLength(1);
    expect(plugin[0]).toContain("plugins/Acme.Tool/locales/en.json");
    expect(plugin[0]).toContain("plugin's t()");
    const core = checkAllowlist(code("src/ui/B.ts"), []);
    expect(core[0]).not.toContain("locales");
    expect(core[0]).toMatch(/show it with t\(\)$/);
  });

  it("fails below the count, so a conversion lowers it", () => {
    expect(checkAllowlist(findings, [entry(3)])).toEqual([expect.stringMatching(/allows 3, lower its count to 2$/)]);
    expect(checkAllowlist([], [entry(2)])).toEqual([expect.stringMatching(/: 0 .*allows 2, remove the entry$/)]);
  });

  it("counts template and script apart in one file", () => {
    const src = vue(`<p>Wall thickness</p>`, `toast("Saved the part.");`);
    const both = scanStrings({ "src/B.vue": src });
    const allow = [
      { path: "src/B.vue", kind: "script", count: 1, reason: "r" },
      { path: "src/B.vue", kind: "template", count: 1, reason: "r" },
    ];
    expect(checkAllowlist(both, allow)).toEqual([]);
    expect(checkAllowlist(both, allow.slice(0, 1))).toEqual([expect.stringMatching(/^src\/B\.vue: 1 raw template/)]);
  });

  it("refuses a doubled entry, a missing reason and an unknown kind", () => {
    const bad = [
      entry(2, " "),
      entry(2),
      { ...entry(2), kind: "style" },
      { ...entry(2), count: 1.5, kind: "template" },
    ];
    expect(checkAllowlist(findings, bad)).toEqual([
      expect.stringMatching(/^entry 1 \(src\/ui\/A\.ts script\): needs/),
      expect.stringMatching(/^entry 2 \(src\/ui\/A\.ts script\): listed twice$/),
      expect.stringMatching(/^entry 3 \(src\/ui\/A\.ts style\): needs/),
      expect.stringMatching(/^entry 4 \(src\/ui\/A\.ts template\): needs/),
    ]);
  });

  it("lowers counts and drops spent entries but never raises one", () => {
    const gone = { path: "src/ui/B.ts", kind: "template", count: 4, reason: "gone" };
    expect(lowerAllowlist(findings, [entry(7, "keep"), gone])).toEqual([entry(2, "keep")]);
    expect(lowerAllowlist(findings, [entry(1)])).toEqual([entry(1)]);
    expect(lowerAllowlist([], [entry(3)])).toEqual([]);
  });

  it("writes one entry per line", () => {
    expect(formatAllowlist([])).toBe("[]\n");
    expect(formatAllowlist([entry(2), { ...entry(5), kind: "template" }])).toBe(
      [
        "[",
        '  { "path": "src/ui/A.ts", "kind": "script", "count": 2, "reason": "before localisation" },',
        '  { "path": "src/ui/A.ts", "kind": "template", "count": 5, "reason": "before localisation" }',
        "]",
        "",
      ].join("\n"),
    );
  });
});

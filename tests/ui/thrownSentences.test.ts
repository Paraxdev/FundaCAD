import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";
import checkScript from "../../scripts/check-ui-strings.mjs?raw";
import { checkThrown, isThrownScanned, scanThrown, type ThrownAllowEntry } from "../../scripts/uiStrings.mjs";
import allowText from "../../scripts/thrown-allow.json?raw";

const glob = {
  ...import.meta.glob("../../src/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../plugins/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

const sources = Object.fromEntries(
  Object.entries(glob)
    .map(([k, v]) => [k.replace(/^(\.\.\/)+/, ""), v] as const)
    .filter(([k]) => isThrownScanned(k)),
);

const found = (code: string, path = "src/geometry/a.ts") =>
  scanThrown({ [path]: code }).map((f) => `${f.path}:${f.line} ${f.name} ${f.text}`);

describe("a thrown English sentence", () => {
  it("is flagged as a string, a template or a refusal, with t() at the throw too", () => {
    expect(
      found(
        [
          'throw new Error("the engine did not store the bytes");',
          "throw new Error(`no body ${id} on screen`);",
          'throw new MeasureRefusal("that is not a number");',
          'throw new Error("the plugin " + id + " did not load");',
          'throw new Error(t("engine.blobNotStored"));',
        ].join("\n"),
      ),
    ).toEqual([
      "src/geometry/a.ts:1 Error the engine did not store the bytes",
      "src/geometry/a.ts:2 Error no body … on screen",
      "src/geometry/a.ts:3 MeasureRefusal that is not a number",
      "src/geometry/a.ts:4 Error the plugin",
      'src/geometry/a.ts:5 Error t() at the throw: t("engine.blobNotStored")',
    ]);
  });

  it("is found in a component's script", () => {
    const vue = '<script setup lang="ts">\nfunction f() {\n  throw new Error("pick a face first");\n}\n</script>\n';
    expect(found(vue, "src/components/A.vue")).toEqual(["src/components/A.vue:3 Error pick a face first"]);
  });

  it("leaves a key, a rethrow, a single word and a test alone", () => {
    expect(
      found(
        [
          'throw new WordedError("render.trace.selfCheckWrong", { path });',
          "throw new Error(message);",
          "throw err;",
          'throw new Error("timeout");',
          'throw new ExprRefusal("expr.unexpected", { token }, pos);',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(found('throw new Error("the engine did not store the bytes");', "src/geometry/a.test.ts")).toEqual([]);
    expect(isThrownScanned("tests/ui/a.ts")).toBe(false);
  });
});

describe("the thrown allowlist", () => {
  const findings = scanThrown({
    "src/harness/a.ts":
      'throw new HarnessError(`no control "${ref}" on screen`);\nthrow new Error("pick a face first");',
  });

  it("lets a listed sentence through by file and message prefix, and names the rest", () => {
    const allow: ThrownAllowEntry[] = [{ path: "src/harness/a.ts", prefix: "no control", reason: "harness only" }];
    expect(checkThrown(findings, allow)).toEqual([
      expect.stringMatching(/^src\/harness\/a\.ts:2 new Error\("pick a face first"\) throws an English sentence/),
    ]);
  });

  it("reports an entry nothing matches, and one with no reason", () => {
    const allow: ThrownAllowEntry[] = [
      { path: "src/harness/a.ts", prefix: "no control", reason: "harness only" },
      { path: "src/harness/a.ts", prefix: "pick a face", reason: "harness only" },
      { path: "src/harness/a.ts", prefix: "gone", reason: "harness only" },
    ];
    expect(checkThrown(findings, allow)).toEqual([
      'src/harness/a.ts: no thrown sentence starts "gone", remove the entry',
    ]);
    expect(checkThrown(findings, [{ path: "src/harness/a.ts", prefix: "no", reason: " " }])).toEqual([
      "entry 1 (src/harness/a.ts): needs a path, a message prefix and a reason",
    ]);
  });
});

describe("the sources as they are", () => {
  it("throw no English sentence the allowlist does not name", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(300);
    expect(checkThrown(scanThrown(sources), JSON.parse(allowText) as ThrownAllowEntry[])).toEqual([]);
  });

  it("are checked in CI by the UI strings step", () => {
    expect(workflow).toContain("run: node scripts/check-ui-strings.mjs");
    expect(checkScript).toContain("checkThrown(");
  });
});

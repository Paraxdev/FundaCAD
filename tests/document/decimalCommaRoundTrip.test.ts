// A document edited in German, with every expression typed through the UI edges, is saved with points only, loads
// the same in English, and a second, older document loaded after it carries nothing over.

import { afterEach, describe, expect, it, vi } from "vitest";
import { captureConfiguration } from "../../src/params/extras";
import { storedExpr } from "../../src/ui/measure";
import { setLanguage } from "../../src/i18n";
import type { DocumentStore } from "../../src/document/store";
import type { ParamTarget } from "../../src/types";
import { box, freshStore } from "./storeKit";

vi.stubGlobal("window", globalThis);
afterEach(() => setLanguage("system"));

const settle = () =>
  new Promise<void>((res) => {
    let i = 0;
    const tick = () => (++i > 10 ? res() : void setTimeout(tick, 0));
    tick();
  });

const target: ParamTarget = { kind: "feature", feature: "f1", field: "length" };
const typed = (s: DocumentStore, name: string, text: string) => s.addParam(name, storedExpr(text), "mm");

async function germanDocument(): Promise<DocumentStore> {
  await setLanguage("de");
  const s = freshStore();
  s.load(JSON.stringify({ parameters: {}, features: [box("f1", 10.5)] }));
  for (const [name, text] of [
    ["width", "40,5"],
    ["wall", "2,5 + 0,25"],
    ["rib", "max(1,5; width/8)"],
  ] as const) {
    expect(typed(s, name, text)).toBeNull();
    await settle();
  }
  expect(s.setTargetExpr(target, storedExpr("width*1,5 - 0,25"), "length")).toBeNull();
  await settle();
  s.updateParamExtras((x) => {
    x.checks = [{ id: "k1", expr: storedExpr("wall > 1,5"), message: "thin", level: "warning" }];
    x.configurations = [captureConfiguration(s.document, "c1", "Slim")];
  });
  expect(s.saveVersion("first")).not.toBeNull();
  return s;
}

/** Every expression string a document holds, wherever it sits. */
function expressions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => expressions(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "expr" && typeof v === "string") out.push(v);
      else if (k === "values" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const e of Object.values(v)) if (typeof e === "string") out.push(e);
      } else expressions(v, out);
    }
  }
  return out;
}

const OLD = {
  parameters: {},
  features: [box("g1", 3.5)],
  paramDefs: { depth: { expr: "12.5*0.5", value: 6.25, unit: "mm" } },
  paramExtras: { checks: [{ id: "k9", expr: "depth < 7.25", message: "deep", level: "error" }] },
};

describe("a document edited in German", () => {
  it("is saved with points and no comma in any expression", async () => {
    const json = (await germanDocument()).toJSON();
    const copy = JSON.parse(json) as { paramDefs: Record<string, { expr: string }> };
    const all = expressions(copy);
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.filter((e) => e.includes(","))).toEqual([]);
    expect(Object.fromEntries(Object.entries(copy.paramDefs).map(([n, d]) => [n, d.expr]))).toMatchObject({
      width: "40.5",
      wall: "2.5 + 0.25",
      rib: "max(1.5; width/8)",
    });
  });

  it("loads in English with the same expressions and values, and saves them unchanged", async () => {
    const german = await germanDocument();
    const json = german.toJSON();
    const copy = JSON.parse(json) as object;
    await setLanguage("en");
    const english = freshStore();
    english.load(JSON.stringify(copy));
    expect(english.document.paramDefs).toEqual(german.document.paramDefs);
    expect(english.document.paramExtras).toEqual(german.document.paramExtras);
    expect(english.document.paramDefs!["rib"]!.value).toBe(5.0625);
    const resaved = english.toJSON();
    expect(JSON.parse(resaved)).toEqual(copy);
    expect(expressions(JSON.parse(resaved))).toEqual(expressions(copy));
    const again = freshStore();
    again.load(resaved);
    expect(again.toJSON()).toBe(resaved);
  });

  it("leaves nothing behind when an older document loads after it", async () => {
    const german = await germanDocument();
    await setLanguage("en");
    const store = freshStore();
    store.load(german.toJSON());
    store.load(JSON.stringify(OLD));
    expect(Object.keys(store.document.paramDefs!)).toEqual(["depth"]);
    expect(store.document.paramExtras).toEqual(OLD.paramExtras);
    const out = JSON.parse(store.toJSON()) as Record<string, unknown>;
    expect(expressions(out)).toEqual(["12.5*0.5", "depth < 7.25"]);
    expect("versions" in out).toBe(false);
    expect(store.document.features).toEqual(OLD.features);
  });
});

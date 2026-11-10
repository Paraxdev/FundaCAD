// The Parameters panel: names, expressions and comments commit on Enter or blur through the store's own check, and
// the store's refusal keeps the typed text.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ref } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ParamsDialog from "../../../src/components/overlays/ParamsDialog.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";
import type { CadDocument } from "../../../src/types";
import { setLanguage } from "../../../src/i18n";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => setLanguage("system"));

function makeEngine() {
  const docVersion = ref(0);
  const doc = {
    parameters: {},
    features: [],
    paramDefs: { w: { expr: "40", value: 40, unit: "mm" } },
  } as unknown as CadDocument;
  const calls: string[][] = [];
  let answer: string | null = null;
  const store = {
    get document() {
      return doc;
    },
    paramIssues: {},
    renameParam: (from: string, to: string) => (calls.push(["rename", from, to]), answer),
    setParamExpr: (name: string, expr: string) => (calls.push(["expr", name, expr]), answer),
    setParamComment: (name: string, c: string) => void calls.push(["comment", name, c]),
    addParam: (name: string, expr: string, unit: string) => (calls.push(["add", name, expr, unit]), answer),
    deleteParam: (name: string) => (calls.push(["delete", name]), answer),
  };
  const engine = { store, bridge: { docVersion, buildVersion: ref(0), editPreviewVersion: ref(0) } };
  return {
    calls,
    doc,
    docVersion,
    refuse: (m: string | null) => (answer = m),
    engine: engine as unknown as Engine,
  };
}

async function open(fake: ReturnType<typeof makeEngine>) {
  mount(ParamsDialog, { global: { provide: { [ENGINE as symbol]: fake.engine } }, attachTo: document.body });
  usePanelsStore().params = true;
  await flushPromises();
}

const inputs = () => [...document.body.querySelectorAll<HTMLInputElement>(".params-dialog input")];

async function type(el: HTMLInputElement, text: string) {
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input"));
  await flushPromises();
}
async function enter(el: HTMLInputElement) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flushPromises();
}

describe("ParamsDialog", () => {
  it("commits an expression on Enter, not while typing, trimmed", async () => {
    const fake = makeEngine();
    await open(fake);
    const expr = inputs()[1]!;
    expect(expr.value).toBe("40");
    await type(expr, " w0*2 ");
    expect(fake.calls).toEqual([]);
    await enter(expr);
    expect(fake.calls).toEqual([["expr", "w", "w0*2"]]);
  });

  it("keeps a refused expression with the store's reason", async () => {
    const fake = makeEngine();
    fake.refuse('unknown parameter "q"');
    await open(fake);
    const expr = inputs()[1]!;
    await type(expr, "q*2");
    await enter(expr);
    expect([expr.value, expr.getAttribute("aria-invalid"), expr.title]).toEqual([
      "q*2",
      "true",
      'unknown parameter "q"',
    ]);
  });

  it("follows the queued commit once it lands, still focused", async () => {
    const fake = makeEngine();
    await open(fake);
    const expr = inputs()[1]!;
    await type(expr, "50");
    await enter(expr);
    fake.doc.paramDefs!.w = { expr: "50", value: 50, unit: "mm" } as never;
    fake.docVersion.value++;
    await flushPromises();
    expect([expr.value, document.activeElement]).toEqual(["50", expr]);
  });

  it("renames on blur and leaves an unchanged name alone", async () => {
    const fake = makeEngine();
    await open(fake);
    const name = inputs()[0]!;
    await type(name, "w");
    name.dispatchEvent(new Event("blur"));
    await type(name, "width");
    name.dispatchEvent(new Event("blur"));
    await flushPromises();
    expect(fake.calls).toEqual([["rename", "w", "width"]]);
  });

  it("adds a parameter on Enter in the expression box, with the picked unit", async () => {
    const fake = makeEngine();
    await open(fake);
    const [, , , newName, newExpr] = inputs();
    await type(newName!, "h");
    await type(newExpr!, "12");
    await enter(newExpr!);
    expect(fake.calls).toEqual([["add", "h", "12", "mm"]]);
    expect([newName!.value, newExpr!.value]).toEqual(["", ""]);
  });

  it("says on the button why an add or a delete was refused", async () => {
    const fake = makeEngine();
    fake.refuse("used by Extrude e1");
    await open(fake);
    const del = document.body.querySelector<HTMLButtonElement>(".params-del")!;
    expect(del.getAttribute("aria-label")).toBe("Delete w");
    del.click();
    await flushPromises();
    expect([del.title, del.classList.contains("is-error")]).toEqual(["used by Extrude e1", true]);
    const [, , , newName, newExpr] = inputs();
    await type(newName!, "w");
    await type(newExpr!, "1");
    const add = [...document.body.querySelectorAll<HTMLButtonElement>(".params-add .btn")].at(-1)!;
    add.click();
    await flushPromises();
    expect([add.title, add.classList.contains("btn-danger")]).toEqual(["used by Extrude e1", true]);
  });

  it("tells under the table that function arguments take a semicolon", async () => {
    await open(makeEngine());
    const hint = document.body.querySelector(".params-dialog .measure-hint")!.textContent!;
    expect([hint.includes("max(a; b)"), /semicolon/.test(hint)]).toEqual([true, true]);
  });

  it("shows the Value column with the language's decimal mark, for a length, an angle and a count", async () => {
    const fake = makeEngine();
    Object.assign(fake.doc.paramDefs!, {
      gap: { expr: "w/3.2", value: 12.375, unit: "mm" },
      tilt: { expr: "22.5", value: 22.5, unit: "deg" },
      ribs: { expr: "7", value: 7, unit: "" },
      ratio: { expr: "0.35", value: 0.35, unit: "" },
    });
    await open(fake);
    const values = () => [...document.body.querySelectorAll(".params-body .params-value")].map((v) => v.textContent);
    expect(values()).toEqual(["40 mm", "12.375 mm", "22.5°", "7", "0.35"]);
    await setLanguage("de");
    await flushPromises();
    expect(values()).toEqual(["40 mm", "12,375 mm", "22,5°", "7", "0,35"]);
    await setLanguage("system");
    await flushPromises();
    expect(values()).toEqual(["40 mm", "12.375 mm", "22.5°", "7", "0.35"]);
  });

  describe("a saved expression", () => {
    const exprs = () =>
      inputs()
        .filter((el) => el.getAttribute("aria-label")?.startsWith("Expression of"))
        .map((el) => el.value);

    it("shows with a decimal comma in German, commits nothing on a blur, and goes back to a point in English", async () => {
      const fake = makeEngine();
      Object.assign(fake.doc.paramDefs!, {
        gap: { expr: "max(w*1.5;2.25)", value: 60, unit: "mm" },
        tilt: { expr: "22.5 + 0.75", value: 23.25, unit: "deg" },
        ribs: { expr: "7", value: 7, unit: "" },
      });
      await open(fake);
      expect(exprs()).toEqual(["40", "max(w*1.5;2.25)", "22.5 + 0.75", "7"]);
      await setLanguage("de");
      await flushPromises();
      expect(exprs()).toEqual(["40", "max(w*1,5;2,25)", "22,5 + 0,75", "7"]);

      const gap = inputs()[4]!;
      gap.focus();
      gap.blur();
      await flushPromises();
      expect(fake.calls).toEqual([]);

      await type(gap, "max(w*1,5;2,5)");
      await enter(gap);
      expect(fake.calls).toEqual([["expr", "gap", "max(w*1.5;2.5)"]]);

      await setLanguage("system");
      await flushPromises();
      expect(exprs()).toEqual(["40", "max(w*1.5;2.25)", "22.5 + 0.75", "7"]);
    });

    it("shows text that does not read as it is saved", async () => {
      const fake = makeEngine();
      Object.assign(fake.doc.paramDefs!, { odd: { expr: "1,5 + a.b", value: 0, unit: "mm" } });
      await setLanguage("de");
      await open(fake);
      expect(exprs()).toEqual(["40", "1,5 + a.b"]);
    });
  });

  describe("a typed decimal comma", () => {
    it("is stored with a point in German, in the add row and the Expression box", async () => {
      await setLanguage("de");
      const fake = makeEngine();
      await open(fake);
      const [, , , newName, newExpr] = inputs();
      await type(newName!, "wall");
      await type(newExpr!, "2,5 + 0,25");
      await enter(newExpr!);
      await type(inputs()[1]!, " max(w*1,5; 2,25) ");
      await enter(inputs()[1]!);
      expect(fake.calls).toEqual([
        ["add", "wall", "2.5 + 0.25", "mm"],
        ["expr", "w", "max(w*1.5; 2.25)"],
      ]);
    });

    it("refuses 1.500 in German as ambiguous, in the add row and the Expression box, and stores nothing", async () => {
      await setLanguage("de");
      const fake = makeEngine();
      await open(fake);
      const [, , , newName, newExpr] = inputs();
      await type(newName!, "wall");
      await type(newExpr!, "1.500");
      const add = [...document.body.querySelectorAll<HTMLButtonElement>(".params-add .btn")].at(-1)!;
      add.click();
      await flushPromises();
      const expr = inputs()[1]!;
      await type(expr, "w * 0.250");
      await enter(expr);
      const why = (n: string) => `"${n}" is ambiguous, write a comma for decimals or leave the point out`;
      expect({ calls: fake.calls, add: add.title, expr: [expr.value, expr.title] }).toEqual({
        calls: [],
        add: why("1.500"),
        expr: ["w * 0.250", why("0.250")],
      });
    });

    it("is passed on untouched in English, where the store refuses it", async () => {
      const fake = makeEngine();
      await open(fake);
      await type(inputs()[1]!, "w*1,5");
      await enter(inputs()[1]!);
      expect(fake.calls).toEqual([["expr", "w", "w*1,5"]]);
    });
  });
});

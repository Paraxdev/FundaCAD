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

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

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
});

// The Parameters group is the main way to drive a parametric model, so a screen reader has to hear each knob's name,
// value and unit, the group has to be a real group, and a check that starts failing has to be said out loud.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import ParametersSection from "../../plugins/FundaCAD.ExtraParameters/ParametersSection.vue";
import { setupOpen } from "../../plugins/FundaCAD.ExtraParameters/state";
import { ENGINE } from "../../src/app/engineKey";
import { DocumentStore } from "../../src/document/store";
import { announce } from "../../src/ui/announce";
import type { Engine } from "../../src/app/engine";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

vi.mock("../../src/ui/announce", async (original) => ({
  ...(await original<typeof import("../../src/ui/announce")>()),
  announce: vi.fn(),
}));

enableAutoUnmount(afterEach);
beforeEach(() => vi.mocked(announce).mockClear());
afterEach(() => {
  setupOpen.value = false;
  document.body.innerHTML = "";
});

const backend = {
  async rebuild() {
    return new Promise<never>(() => {});
  },
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
  async cancel() {
    return true;
  },
} as unknown as GeometryBackend;

function doc(): CadDocument {
  return {
    parameters: {},
    paramDefs: {
      solidCore: { expr: "1", value: 1, unit: "count", group: "g1", control: { kind: "toggle" } },
      rings: { expr: "2", value: 2, unit: "count", group: "g1", control: { kind: "slider", min: 0, max: 22, step: 1 } },
      lip: { expr: "4", value: 4, unit: "mm", control: { kind: "slider", min: 0, max: 10, step: 0.5 } },
      gap: { expr: "0.5", value: 0.5, unit: "mm", control: { kind: "number", min: 0.3, step: 0.1 } },
      tilt: { expr: "15", value: 15, unit: "deg" },
      size: {
        expr: "10",
        value: 10,
        unit: "mm",
        control: {
          kind: "choice",
          choices: [
            { label: "Small", value: 10 },
            { label: "Large", value: 30 },
          ],
        },
      },
      pitch: { expr: "gap * 2", value: 1, unit: "mm" },
    },
    paramExtras: {
      groups: [{ id: "g1", name: "Core" }],
      configurations: [{ id: "c1", name: "Classic", values: { solidCore: "0" } }],
      checks: [
        { id: "k1", expr: "gap >= 0.3", message: "gap below 0.3 mm fuses", level: "warning" },
        { id: "k2", expr: "lip < 9", message: "lip too tall to print", level: "error" },
      ],
    },
    features: [],
  };
}

async function render() {
  setActivePinia(createPinia());
  const store = new DocumentStore(backend, doc());
  const docVersion = ref(0);
  store.onDocChange(() => {
    docVersion.value++;
  });
  const engine = { store, bridge: { docVersion, buildVersion: ref(0), metaVersion: ref(0) } } as unknown as Engine;
  const w = mount(ParametersSection, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await nextTick();
  return { w, store, root: w.element.parentElement as HTMLElement };
}

const settle = async () => {
  await flushPromises();
  await nextTick();
};

const textOf = (ids: string | null) =>
  (ids ?? "")
    .split(/\s+/)
    .map((id) => (id ? (document.getElementById(id)?.textContent?.trim() ?? "") : ""))
    .join(" ")
    .trim();

function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const by = textOf(el.getAttribute("aria-labelledby"));
  if (by) return by;
  if (el.id) {
    const text = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim();
    if (text) return text;
  }
  return el.tagName === "BUTTON" ? (el.textContent?.trim() ?? "") : "";
}

const CONTROLS = "input, select, textarea, button, [role=combobox]";
const row = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-param="${name}"]`)!;
const control = (root: HTMLElement, name: string) => row(root, name).querySelector<HTMLElement>(CONTROLS)!;

describe("the Parameters group, for a screen reader", () => {
  it("names every control, and draws no raw select or range", async () => {
    const { root } = await render();
    const controls = [...root.querySelectorAll(CONTROLS)];
    expect(controls.length).toBeGreaterThan(6);
    expect(controls.filter((c) => !nameOf(c)).map((c) => c.outerHTML.slice(0, 80))).toEqual([]);
    expect(root.querySelectorAll("select")).toHaveLength(0);
    expect(root.querySelectorAll('input[type="range"]:not(.ui-slider-input)')).toHaveLength(0);
    expect(root.querySelectorAll('input[type="checkbox"]:not(.ui-checkbox-input)')).toHaveLength(0);
  });

  it("names each knob by its parameter", async () => {
    const { root } = await render();
    for (const name of ["gap", "tilt", "lip", "rings", "solidCore"]) expect(nameOf(control(root, name))).toBe(name);
    expect(nameOf(control(root, "size"))).toMatch(/^size/);
    expect(nameOf(root.querySelector("[role=combobox]")!)).toMatch(/^Configuration/);
  });

  it("says the unit with the value: millimetres, degrees, and none for a count", async () => {
    const { root } = await render();
    const gap = control(root, "gap");
    expect(textOf(gap.getAttribute("aria-describedby"))).toMatch(/mm|millimet/);
    expect(textOf(control(root, "tilt").getAttribute("aria-describedby"))).toMatch(/deg|°/);
    expect(control(root, "lip").getAttribute("aria-valuetext")).toMatch(/^4 (mm|millimetres)$/);
    expect(control(root, "rings").getAttribute("aria-valuetext") ?? "2").toBe("2");
  });

  it("reads a formula as its name, value, unit and what it is calculated from", async () => {
    const { root } = await render();
    expect(row(root, "pitch").textContent).toMatch(/pitch/);
    expect(row(root, "pitch").textContent).toMatch(/calculated from gap \* 2/);
  });

  it("is a real group: no roleless element carries aria-expanded, and each group is named", async () => {
    const { root } = await render();
    const expanding = [...root.querySelectorAll("[aria-expanded]:not([role=combobox]):not([aria-haspopup])")];
    expect(expanding.length).toBeGreaterThan(0);
    expect(
      [...root.querySelectorAll("[aria-expanded]")].filter((el) => el.tagName !== "BUTTON" && !el.getAttribute("role")),
    ).toEqual([]);
    expect(expanding.map(nameOf)).toEqual(["Collapse Parameters", "Collapse Core"]);
    const groups = [...root.querySelectorAll("[role=group]")].map(nameOf);
    expect(groups).toEqual(["Parameters", "Core"]);
    // The section sits in one row of the host's tree, which reads its rows' places from its own list.
    expect(root.querySelectorAll("[data-tree-item], [role=treeitem]")).toHaveLength(0);
  });

  it("opens the setup from a button named for it", async () => {
    const { root } = await render();
    const setup = [...root.querySelectorAll("button")].find((b) => nameOf(b) === "Parameter setup")!;
    expect(setup).toBeTruthy();
    setup.click();
    expect(setupOpen.value).toBe(true);
  });
});

describe("a failing check", () => {
  it("is an alert row that says its level in words, not only in colour", async () => {
    const { root, store } = await render();
    expect(root.querySelectorAll("[role=alert]")).toHaveLength(0);
    store.setParamExpr("lip", "9.5");
    await settle();
    const alerts = [...root.querySelectorAll("[role=alert]")].map((a) => a.textContent?.replace(/\s+/g, " ").trim());
    expect(alerts).toEqual(["Error: lip too tall to print"]);
  });

  it("is announced while the group is folded, where no alert row is drawn", async () => {
    const { root, store } = await render();
    const head = [...root.querySelectorAll("button")].find((b) => nameOf(b) === "Collapse Parameters")!;
    head.click();
    await settle();
    store.setParamExpr("gap", "0.2");
    await settle();
    expect(announce).toHaveBeenCalledWith("Check failed, warning: gap below 0.3 mm fuses", "polite");
    store.setParamExpr("lip", "9.5");
    await settle();
    expect(announce).toHaveBeenLastCalledWith("Check failed, error: lip too tall to print", "assertive");
  });

  it("is not announced on first draw, only when it starts failing", async () => {
    const { store } = await render();
    store.setParamExpr("gap", "0.4");
    await settle();
    expect(announce).not.toHaveBeenCalled();
  });
});

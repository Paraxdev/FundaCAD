// The Print toolbox's Printability panel and custom bed dialog draw with the base controls: every control is named,
// the numbers say their unit, the findings sit in labelled lists and groups, and a problem says its level in words. The
// check's own announce speaks the outcome, so a problem is plain text, not an alert, or it would be heard twice.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { shallowRef } from "vue";
import CustomBedDialog from "../../plugins/FundaCAD.PrintToolbox/CustomBedDialog.vue";
import CustomBedHost from "../../plugins/FundaCAD.PrintToolbox/CustomBedHost.vue";
import PrintabilityPanel from "../../plugins/FundaCAD.PrintToolbox/PrintabilityPanel.vue";
import { customBedReq, type CustomBedRequest } from "../../plugins/FundaCAD.PrintToolbox/customBedDialog";
import { formatPrintabilityResult } from "../../plugins/FundaCAD.PrintToolbox/printability";
import {
  printabilityPanel,
  type PrintabilityPanel as Controller,
} from "../../plugins/FundaCAD.PrintToolbox/printabilityPanel";
import { createPrintabilityState } from "../../plugins/FundaCAD.PrintToolbox/printabilityState";
import type { PrintabilityReply } from "fundacad";
import { byName, describedBy, nameOf, rawControls, stubResizeObserver, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  setActivePinia(createPinia());
  stubResizeObserver(vi.stubGlobal);
});
afterEach(() => {
  printabilityPanel.value = null;
  customBedReq.value = null;
  vi.unstubAllGlobals();
});

// The dialog frame's own close button is the app's, named Close.
const raw = (root: Element) => rawControls(root).filter((r) => r !== "button.modal-close");

const reply: PrintabilityReply = {
  header: "+Z up as modelled, bed at z = 0",
  report: "",
  settings: { nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z", layFlat: false },
  bodies: [
    { id: "body1", name: "Bracket", up: [0, 0, 1], bed: 0, bedFace: 1, openEdges: 0, solids: 1, insideOut: false },
    { id: "body2", name: "Lid", up: [0, 0, 1], bed: 0, bedFace: 1, openEdges: 4, solids: 1, insideOut: false },
  ],
  findings: [
    {
      kind: "overhang",
      body: "body1",
      face: 3,
      other: null,
      value: 90,
      limit: 0,
      area: 132,
      low: 5,
      at: [0, 0, 5],
      extent: 6,
      note: "",
    },
    {
      kind: "bridge",
      body: "body1",
      face: 4,
      other: null,
      value: 14,
      limit: 10,
      area: 40,
      low: 0,
      at: [0, 0, 8],
      extent: 14,
      note: "",
    },
  ],
  errors: [{ feature_id: "f3", message: "fillet failed" }],
};

async function printability() {
  const state = createPrintabilityState();
  const ctl = {
    state,
    data: state.data,
    bodies: shallowRef([
      { id: "body1", name: "Bracket" },
      { id: "body2", name: "Lid" },
    ]),
    run: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
    hover: vi.fn(),
    pick: vi.fn(),
  };
  printabilityPanel.value = ctl as unknown as Controller;
  mount(PrintabilityPanel, { attachTo: document.body });
  state.show();
  await flushPromises();
  return { root: document.querySelector(".printability-panel")!, state, ctl };
}

const alerts = (root: Element) => [...root.querySelectorAll("[role=alert]")].map((a) => a.textContent?.trim());
const texts = (root: Element, sel: string) => [...root.querySelectorAll(sel)].map((a) => a.textContent?.trim());
const field = (root: Element, name: string) =>
  [...root.querySelectorAll<HTMLInputElement>(".ui-number-field input")].find((el) => nameOf(el) === name)!;

describe("the Printability panel, for a screen reader", () => {
  it("names every control and draws no raw one", async () => {
    const { root, state } = await printability();
    expect(raw(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
    state.finished({ result: formatPrintabilityResult(reply) });
    await flushPromises();
    expect(raw(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
  });

  it("is a named region", async () => {
    const { root } = await printability();
    expect(nameOf(root.closest("[role=region]")!)).toBe("Printability");
  });

  it("names the five numbers by their row label and says millimetres or degrees", async () => {
    const { root } = await printability();
    const names = ["Nozzle", "Layer", "Overhang angle", "Smallest gap", "Longest bridge"];
    expect([...root.querySelectorAll(".ui-number-field input")].map((i) => nameOf(i))).toEqual(names);
    for (const name of names) {
      const input = field(root, name);
      expect(root.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent, name).toBe(name);
    }
    for (const name of ["Nozzle", "Layer", "Smallest gap", "Longest bridge"]) {
      expect(describedBy(field(root, name)), name).toMatch(/mm|millimet/i);
    }
    expect(describedBy(field(root, "Overhang angle"))).toMatch(/deg|°/i);
  });

  it("draws the up direction as a named select that a laid flat body turns off", async () => {
    const { root, state } = await printability();
    const up = root.querySelector<HTMLElement>("[role=combobox].printability-up")!;
    expect(nameOf(up)).toMatch(/^Up/);
    expect(up.textContent).toContain("+Z, as modelled");
    expect(up.getAttribute("aria-disabled")).toBeNull();
    byName<HTMLInputElement>(root, "input[type=checkbox]", "Lay flat on the largest flat face")!.click();
    await flushPromises();
    expect(state.data.value!.setup.layFlat).toBe(true);
    expect(up.getAttribute("aria-disabled")).toBe("true");
  });

  it("offers the checks as one named group of named checkboxes", async () => {
    const { root, state } = await printability();
    const group = byName<HTMLElement>(root, "[role=group]", "Checks to run")!;
    expect(group).toBeDefined();
    const boxes = [...group.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.map((b) => nameOf(b))).toEqual(["Overhangs", "Thin walls", "Gaps", "Bridges", "Open shells"]);
    boxes[1]!.click();
    await flushPromises();
    expect(state.data.value!.setup.checks.wall).toBe(false);
  });

  it("names Check, and Cancel while it runs, with the reason Check is off", async () => {
    const { root, state, ctl } = await printability();
    const run = byName<HTMLElement>(root, "button", "Check")!;
    run.click();
    expect(ctl.run).toHaveBeenCalledOnce();
    state.started();
    await flushPromises();
    const busy = byName<HTMLElement>(root, "button", "Checking…")!;
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.title).toBe("A check is running");
    expect(byName(root, "button", "Cancel")).toBeDefined();
    expect(byName(root, "button", "Close")).toBeUndefined();
  });

  it("puts each body's findings in a named group, a labelled list of named buttons", async () => {
    const { root, state } = await printability();
    state.finished({ result: formatPrintabilityResult(reply) });
    await flushPromises();
    const groups = [...root.querySelectorAll<HTMLElement>(".printability-group")];
    expect(groups.map((g) => g.getAttribute("role"))).toEqual(["group", "group"]);
    expect(groups.map((g) => nameOf(g))).toEqual(["Bracket", "Lid"]);
    const list = groups[0]!.querySelector("ul")!;
    expect(list.getAttribute("aria-label")).toBe("Bracket findings");
    const rows = [...list.querySelectorAll<HTMLElement>("li > button")];
    expect(rows.map((r) => nameOf(r))).toEqual([
      "Overhang, 132 mm² leaning 90°, face 4, from 5 mm above the bed",
      "Bridge 14 mm span (over 10), face 5, centred 8 mm above the bed",
    ]);
  });

  it("draws the legend as a list with swatches a screen reader skips", async () => {
    const { root, state } = await printability();
    state.finished({ result: formatPrintabilityResult(reply) });
    await flushPromises();
    const legend = root.querySelector<HTMLElement>("[role=list][aria-label=Legend]")!;
    const items = [...legend.querySelectorAll<HTMLElement>("[role=listitem]")];
    expect(items.map((i) => i.textContent?.trim())).toEqual(["Overhang", "Bridge"]);
    expect(items.every((i) => i.querySelector("[aria-hidden=true]") !== null)).toBe(true);
    expect(root.querySelectorAll(".print-swatch[aria-hidden=true]")).toHaveLength(4);
  });

  it("shows a refused check as an error in words, not an alert", async () => {
    const { root, state } = await printability();
    state.finished({ error: "face 7 of body1 is not flat" });
    await flushPromises();
    expect(texts(root, ".printability-error")).toEqual(["Error: face 7 of body1 is not flat"]);
    expect(alerts(root)).toEqual([]);
  });

  it("shows a body note and a failed feature as warnings in words, not alerts", async () => {
    const { root, state } = await printability();
    state.finished({ result: formatPrintabilityResult(reply) });
    await flushPromises();
    expect(texts(root, ".printability-note, .printability-warning")).toEqual([
      "Warning: Open shell, 4 open edges",
      "Warning: f3: fillet failed",
    ]);
    expect(alerts(root)).toEqual([]);
  });

  it("keeps a finding a button in a list, not an alert", async () => {
    const { root, state } = await printability();
    state.finished({ result: formatPrintabilityResult(reply) });
    await flushPromises();
    expect(root.querySelectorAll(".printability-finding[role=alert]")).toHaveLength(0);
    expect(root.querySelector(".printability-finding")!.closest("[role=alert]")).toBeNull();
  });

  it("says a stale result as a status, not an alert", async () => {
    const { root, state } = await printability();
    state.finished({ result: formatPrintabilityResult({ ...reply, findings: [], errors: [], bodies: [] }) });
    state.setStale();
    await flushPromises();
    expect(root.querySelector(".printability-stale")?.getAttribute("role")).toBe("status");
    expect(alerts(root)).toEqual([]);
  });
});

function bed(initial: CustomBedRequest["initial"] = [200, 210, 220]) {
  const req: CustomBedRequest = { initial, resolve: vi.fn() };
  mount(CustomBedDialog, { props: { req }, attachTo: document.body });
  return req;
}

const dimension = (name: string) => document.querySelector<HTMLInputElement>(`[data-testid=bed-custom-${name}]`)!;
function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const ok = () => document.querySelector<HTMLElement>("[data-testid=bed-custom-confirm]")!;

describe("the custom bed size dialog, for a screen reader", () => {
  it("is a named dialog whose every control is named and none is raw", async () => {
    bed();
    await flushPromises();
    const dialog = document.querySelector("[role=dialog]")!;
    expect(nameOf(dialog)).toBe("Custom bed size");
    expect(raw(document.body)).toEqual([]);
    expect(unnamed(dialog)).toEqual([]);
  });

  it("names the three sizes and says millimetres", async () => {
    bed();
    await flushPromises();
    expect(["width", "depth", "height"].map((k) => nameOf(dimension(k)))).toEqual(["Width", "Depth", "Height"]);
    for (const k of ["width", "depth", "height"]) expect(describedBy(dimension(k)), k).toMatch(/mm|millimet/i);
  });

  it("names its buttons", async () => {
    bed();
    await flushPromises();
    const dialog = document.querySelector("[role=dialog]")!;
    expect(byName(dialog, "button", "Cancel")).toBeDefined();
    expect(byName(dialog, "button", "OK")).toBeDefined();
  });

  it("tells a size that is not positive as an error alert in words", async () => {
    const req = bed();
    await flushPromises();
    expect(document.querySelector("[role=alert]")).toBeNull();
    type(dimension("depth"), "-5");
    ok().click();
    await flushPromises();
    expect(document.querySelector("[role=alert]")?.textContent).toMatch(/^Error: .*positive/);
    expect(req.resolve).not.toHaveBeenCalled();
  });

  it("tells a text that is no number as an error alert naming its field", async () => {
    const req = bed();
    await flushPromises();
    type(dimension("height"), "3*");
    await flushPromises();
    ok().click();
    await flushPromises();
    expect(document.querySelector("[role=alert]")?.textContent).toMatch(/^Error: Height: /);
    expect(req.resolve).not.toHaveBeenCalled();
  });

  it("confirms a typed size, and Enter on a button presses that button instead", async () => {
    const req = bed();
    await flushPromises();
    type(dimension("width"), "120");
    ok().click();
    expect(req.resolve).toHaveBeenCalledWith([120, 210, 220]);
    const cancel = document.querySelector<HTMLElement>("[data-testid=bed-custom-cancel]")!;
    cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(req.resolve).toHaveBeenCalledTimes(1);
  });

  it("is drawn by the host only while a question is open", async () => {
    mount(CustomBedHost, { attachTo: document.body });
    await flushPromises();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    customBedReq.value = { initial: [200, 200, 200], resolve: vi.fn() };
    await flushPromises();
    await flushPromises();
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
  });
});

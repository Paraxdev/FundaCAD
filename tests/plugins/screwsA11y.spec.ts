// The Fasteners library, its custom form and the Standard Thread panel draw with the base controls: every control has
// a name, a number says its unit, and a failing check is an alert that is also spoken.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import CustomForm from "../../plugins/FundaCAD.Screws/CustomForm.vue";
import LibraryPanel from "../../plugins/FundaCAD.Screws/LibraryPanel.vue";
import ThreadPanel from "../../plugins/FundaCAD.Screws/ThreadPanel.vue";
import { addUserFastener, open, selection, tab, userLibrary } from "../../plugins/FundaCAD.Screws/state";
import {
  threadDraft,
  threadTool,
  type StandardThreadTool,
  type ThreadDraft,
} from "../../plugins/FundaCAD.Screws/threadTool";
import type { FastenerSpec } from "../../plugins/FundaCAD.Screws/spec";
import { ENGINE } from "../../src/app/engineKey";
import { announce } from "../../src/ui/announce";

vi.mock("../../src/ui/announce", async (original) => ({
  ...(await original<typeof import("../../src/ui/announce")>()),
  announce: vi.fn(),
}));

enableAutoUnmount(afterEach);

const CONTROLS = "input, select, textarea, button, [role=combobox], [role=switch], [role=radio], [role=checkbox]";

function textOf(ids: string | null): string {
  return (ids ?? "")
    .split(/\s+/)
    .map((id) => (id ? (document.getElementById(id)?.textContent?.trim() ?? "") : ""))
    .join(" ")
    .trim();
}

function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const by = textOf(el.getAttribute("aria-labelledby"));
  if (by) return by;
  if (el.id) {
    const text = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim();
    if (text) return text;
  }
  const wrapping = el.closest("label")?.textContent?.trim();
  if (wrapping) return wrapping;
  return el.tagName === "BUTTON" || el.getAttribute("role") === "radio" ? (el.textContent?.trim() ?? "") : "";
}

const controlsOf = (root: Element) => [...root.querySelectorAll(CONTROLS)];
const unnamed = (root: Element) => controlsOf(root).filter((el) => !nameOf(el));
const describedBy = (el: Element) => textOf(el.getAttribute("aria-describedby"));

/** A raw control is one drawn outside a base component's wrapper. */
function rawControls(root: Element): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("select, textarea, input")) {
    const type = el.getAttribute("type");
    if (el.tagName === "SELECT") out.push("select");
    else if (el.tagName === "TEXTAREA" && !el.closest(".ui-field")) out.push("textarea");
    else if (el.tagName === "INPUT" && type !== "checkbox" && !el.closest(".ui-field")) out.push("input");
  }
  for (const el of root.querySelectorAll("button")) {
    if (!/\b(btn|ui-[\w-]+|select-trigger)\b/.test(el.className)) out.push(`button.${el.className || "plain"}`);
  }
  return out;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  open.value = false;
  tab.value = "catalogue";
  selection.value = null;
  userLibrary.value = [];
  threadDraft.value = null;
  threadTool.value = null;
  vi.unstubAllGlobals();
});

const screw = (over: Record<string, unknown> = {}): FastenerSpec =>
  ({
    kind: "screw",
    units: "mm",
    name: "Test screw",
    head: { type: "countersunk", diameter: 7, height: 2 },
    drive: { type: "phillips", size: 3, depth: 1.5 },
    point: { type: "chamfer" },
    thread: { type: "metric", diameter: 3, pitch: 0.5, length: 10, hand: "right", modelled: false },
    length: 12,
    ...over,
  }) as unknown as FastenerSpec;

const INCH = {
  units: "in",
  thread: { type: "unified", diameter: 0.25, pitch: 0.05, length: 0.5, hand: "right", modelled: false },
  head: { type: "countersunk", diameter: 0.5, height: 0.1 },
  drive: { type: "phillips", size: 0.2, depth: 0.05 },
  length: 1,
};

async function library() {
  open.value = true;
  mount(LibraryPanel, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: {} } } });
  await flushPromises();
  return document.body.querySelector(".scr-library")!;
}

async function form(spec: FastenerSpec | null = screw()) {
  const w = mount(CustomForm, {
    props: { initial: spec, editing: true },
    global: { stubs: { FastenerPreview: true } },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

async function panel() {
  threadDraft.value = {
    editing: null,
    face: {},
    faceDiameter: null,
    external: false,
    system: "iso",
    designation: "M6",
    faceIs: "tap",
    hand: "right",
    starts: 1,
    printFit: true,
    clearance: 0.2,
  } as unknown as ThreadDraft;
  threadTool.value = { changed: vi.fn(), cancel: vi.fn(), apply: vi.fn() } as unknown as StandardThreadTool;
  mount(ThreadPanel, { attachTo: document.body });
  await flushPromises();
  return document.body.querySelector("[data-testid=thread-panel]")!;
}

function type(input: HTMLInputElement, text: string) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the library panel", () => {
  it("names every control of the catalogue, its filters and a picked size", async () => {
    const root = await library();
    (root.querySelector(".scr-row") as HTMLElement).click();
    await flushPromises();
    expect(controlsOf(root).length).toBeGreaterThan(12);
    expect(unnamed(root).map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
  });

  it("draws its filters and size choices with the base Select, no raw select or text input", async () => {
    const root = await library();
    (root.querySelector(".scr-row") as HTMLElement).click();
    await flushPromises();
    expect(root.querySelectorAll("select")).toHaveLength(0);
    expect(root.querySelectorAll("[role=combobox]").length).toBeGreaterThanOrEqual(8);
    expect(rawControls(root)).toEqual([]);
  });

  it("keeps the class names the tests and the harness read", async () => {
    const root = await library();
    for (const sel of [".scr-tab-catalogue", ".scr-tab-custom", ".scr-close", ".scr-search input"]) {
      expect(root.querySelector(sel), sel).not.toBeNull();
    }
    for (const sel of [".scr-filter-category", ".scr-filter-system", ".scr-filter-standard"]) {
      expect(root.querySelector(sel)?.getAttribute("role"), sel).toBe("combobox");
    }
  });

  it("names the buttons of My fasteners and of its form", async () => {
    addUserFastener(screw());
    tab.value = "custom";
    const root = await library();
    for (const sel of [".scr-new", ".scr-import", ".scr-export"]) expect(root.querySelector(sel), sel).not.toBeNull();
    expect(root.querySelectorAll(".scr-custom-row button").length).toBe(3);
    expect(unnamed(root)).toEqual([]);
    expect(rawControls(root)).toEqual([]);
    (root.querySelector(".scr-new") as HTMLElement).click();
    await flushPromises();
    expect(root.querySelector(".scr-form")).not.toBeNull();
    expect(unnamed(root)).toEqual([]);
    expect(rawControls(root)).toEqual([]);
  });
});

describe("the custom fastener form", () => {
  it("names every control and draws none of them raw", async () => {
    const w = await form();
    const root = w.element;
    expect(controlsOf(root).length).toBeGreaterThan(15);
    expect(root.querySelectorAll("select")).toHaveLength(0);
    expect(root.querySelectorAll("[role=combobox]").length).toBeGreaterThanOrEqual(6);
    expect(unnamed(root).map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
    expect(rawControls(root)).toEqual([]);
  });

  it("draws Notes as a TextField textarea and Name as a TextField", async () => {
    const w = await form();
    expect(w.get(".scr-name input").attributes("type")).toBe("text");
    expect(w.findAll(".ui-text-field textarea")).toHaveLength(1);
  });

  it("says millimetres on every length and angle, and names a count as unitless", async () => {
    const w = await form();
    const lengths = [...w.element.querySelectorAll(".ui-number-field input")].filter(
      (el) => !/Driver number/.test(nameOf(el)),
    );
    expect(lengths.length).toBeGreaterThan(5);
    for (const el of lengths) expect(describedBy(el), nameOf(el)).toMatch(/mm|millimet|deg/i);
    const driver = [...w.element.querySelectorAll(".ui-number-field input")].find((el) =>
      /Driver number/.test(nameOf(el)),
    )!;
    expect(describedBy(driver)).toBe("");
  });

  it("says inches, and threads per inch, on an inch fastener", async () => {
    const w = await form(screw(INCH));
    const tpi = w.get(".scr-tpi input").element;
    expect(describedBy(tpi)).toMatch(/TPI|thread/i);
    const length = w.get(".scr-len-length input").element;
    expect(describedBy(length)).toMatch(/\bin\b|inch/i);
  });

  it("makes the problem list an alert that is still read as a list", async () => {
    const w = await form(screw({ length: undefined }));
    const list = w.get(".scr-problems");
    expect(list.attributes("role")).toBe("alert");
    expect(list.findAll("li").length).toBeGreaterThan(0);
    // An alert role on the ul itself would take its list role away, and the items would be read as loose text.
    expect(list.findAll("li").every((li) => li.element.parentElement?.tagName === "UL")).toBe(true);
    expect(list.find("ul").attributes("role")).toBeUndefined();
  });

  it("speaks a new problem once, debounced, and nothing on first mount", async () => {
    const first = await form(screw({ length: undefined }));
    await wait(700);
    expect(vi.mocked(announce).mock.calls.filter(([t]) => /Missing/.test(t))).toHaveLength(0);
    first.unmount();

    const w = await form();
    expect(w.find(".scr-problems").exists()).toBe(false);
    const length = w.get(".scr-len-length input").element as HTMLInputElement;
    type(length, "1");
    type(length, "");
    await flushPromises();
    expect(w.get(".scr-problems").text()).toMatch(/Missing/);
    const spoken = vi.mocked(announce).mock.calls.filter(([t]) => /Missing/.test(t));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]![1]).toBe("assertive");
    expect(spoken[0]![2]).toEqual({ key: expect.any(String), delay: expect.any(Number) });
  });

  it("a refused countersink angle is in the alert list too", async () => {
    const w = await form();
    const angle = [...w.element.querySelectorAll(".ui-number-field input")].find((el) =>
      /Countersink angle/.test(nameOf(el)),
    ) as HTMLInputElement;
    type(angle, "-5");
    await flushPromises();
    expect(w.get(".scr-problems").attributes("role")).toBe("alert");
    expect(w.get(".scr-problems").text()).toMatch(/Countersink angle: At least 1/);
    await wait(700);
    expect(vi.mocked(announce).mock.calls.some(([t]) => /Countersink angle/.test(t))).toBe(true);
  });
});

describe("the Standard Thread panel", () => {
  it("names every control and draws none of them raw", async () => {
    const root = await panel();
    expect(root.querySelectorAll("select")).toHaveLength(0);
    expect(root.querySelectorAll("[role=combobox]").length).toBe(5);
    expect(unnamed(root).map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
    expect(rawControls(root)).toEqual([]);
  });

  it("keeps its test ids on the base controls", async () => {
    const root = await panel();
    for (const id of ["system", "size", "faceis", "hand", "starts"]) {
      expect(root.querySelector(`[data-testid=thread-${id}]`)?.getAttribute("role"), id).toBe("combobox");
    }
    expect(root.querySelector("[data-testid=thread-printfit]")).not.toBeNull();
    expect(root.querySelector("[data-testid=thread-apply]")?.textContent).toMatch(/Add/);
    expect(root.querySelector("[data-testid=thread-cancel]")?.textContent).toMatch(/Cancel/);
  });

  it("says the clearance is in millimetres", async () => {
    const root = await panel();
    const input = root.querySelector("[data-testid=thread-clearance]") as HTMLInputElement;
    expect(input.closest(".ui-number-field")).not.toBeNull();
    expect(describedBy(input)).toMatch(/mm|millimet/i);
  });
});

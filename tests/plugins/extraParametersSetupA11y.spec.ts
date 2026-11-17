// Parameter Setup draws with the base controls: every control has a name, a range says its unit, and a refused edit is
// an alert, where it used to be a toast.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import SetupPanel from "../../plugins/FundaCAD.ExtraParameters/SetupPanel.vue";
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

beforeEach(() => {
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
  setupOpen.value = false;
  vi.unstubAllGlobals();
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
      solidCore: { expr: "1", value: 1, unit: "count", group: "g1", control: { kind: "toggle" }, hidden: true },
      rings: { expr: "2", value: 2, unit: "count", group: "g1", control: { kind: "slider", min: 0, max: 22, step: 1 } },
      lip: { expr: "4", value: 4, unit: "mm", control: { kind: "slider", min: 0, max: 10, step: 0.5 } },
      gap: { expr: "0.5", value: 0.5, unit: "mm", control: { kind: "number", min: 0.3, step: 0.1 } },
      tilt: { expr: "15", value: 15, unit: "deg", control: { kind: "number", min: 0, max: 90 } },
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
      free: { expr: "3", value: 3, unit: "mm" },
    },
    paramExtras: {
      groups: [{ id: "g1", name: "Core" }],
      configurations: [{ id: "c1", name: "Classic", values: { solidCore: "0" } }],
      checks: [{ id: "k1", expr: "gap >= 0.3", message: "gap below 0.3 mm fuses", level: "warning" }],
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
  setupOpen.value = true;
  mount(SetupPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await flushPromises();
  await nextTick();
  return { store, root: document.querySelector(".xp-setup-panel") as HTMLElement };
}

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
  const wrapping = el.closest("label")?.textContent?.trim();
  if (wrapping) return wrapping;
  return el.tagName === "BUTTON" ? (el.textContent?.trim() ?? "") : "";
}

const CONTROLS = "input, select, textarea, button, [role=combobox], [role=switch], [role=radio], [role=checkbox]";
const describedBy = (el: Element) => textOf(el.getAttribute("aria-describedby"));
// A Select's name carries its value after a comma.
const named = (root: Element, name: string) =>
  [...root.querySelectorAll<HTMLElement>(CONTROLS)].find((el) => {
    const n = nameOf(el);
    return n === name || n.startsWith(`${name}, `);
  })!;

function rawControls(root: Element): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("select, textarea, input")) {
    const type = el.getAttribute("type");
    if (el.tagName === "SELECT") out.push("select");
    else if (type === "checkbox" && !el.closest(".ui-checkbox")) out.push("checkbox");
    else if (type !== "checkbox" && !el.closest(".ui-field")) out.push(`input[${type}]`);
  }
  for (const el of root.querySelectorAll("button")) {
    if (!/\b(btn|ui-[\w-]+|select-trigger|float-card-close)\b/.test(el.className)) out.push(`button.${el.className}`);
  }
  return out;
}

/** An edit as a person makes it: type, then Enter. */
async function edit(input: HTMLInputElement, text: string) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flushPromises();
  await nextTick();
}

const alerts = (root: Element) => [...root.querySelectorAll("[role=alert]")].map((a) => a.textContent?.trim());

describe("Parameter Setup, for a screen reader", () => {
  it("names every control", async () => {
    const { root } = await render();
    const controls = [...root.querySelectorAll(CONTROLS)];
    expect(controls.length).toBeGreaterThan(25);
    expect(controls.filter((c) => !nameOf(c)).map((c) => c.outerHTML.slice(0, 90))).toEqual([]);
  });

  it("draws no raw select, input or button, and keeps the class names the harness reads", async () => {
    const { root } = await render();
    expect(root.querySelectorAll("select")).toHaveLength(0);
    expect(rawControls(root)).toEqual([]);
    expect(root.querySelectorAll(".xp-kind[role=combobox]")).toHaveLength(7);
    expect(root.querySelector(".xp-kind")!.getAttribute("data-param")).toBe("rings");
    expect(root.querySelector(".xp-apply")).not.toBeNull();
    expect(root.querySelector(".xp-new-check-expr input")).not.toBeNull();
  });

  it("names each control for its parameter", async () => {
    const { root } = await render();
    for (const name of ["gap control", "gap group", "gap minimum", "gap maximum", "gap step", "size choices"]) {
      expect(named(root, name), name).toBeTruthy();
    }
    expect(named(root, "solidCore Hide")).toBeTruthy();
  });

  it("says millimetres and degrees on a range, and nothing on a count", async () => {
    const { root } = await render();
    for (const key of ["minimum", "maximum", "step"]) {
      expect(describedBy(named(root, `gap ${key}`)), key).toMatch(/mm|millimet/i);
      expect(describedBy(named(root, `tilt ${key}`)), key).toMatch(/deg|°/i);
      expect(describedBy(named(root, `rings ${key}`)), key).toBe("");
    }
  });

  it("makes every row's icon buttons named", async () => {
    const { root } = await render();
    const names = [...root.querySelectorAll("button")].map(nameOf);
    expect(names).toContain("Add group");
    expect(names).toContain("Add check");
    expect(names.some((n) => /^Delete group Core/.test(n))).toBe(true);
    expect(names.some((n) => /^Delete Classic/.test(n))).toBe(true);
  });
});

describe("a refused edit", () => {
  it("is not shown or spoken when the panel opens", async () => {
    const { root } = await render();
    expect(alerts(root)).toEqual([]);
    expect(announce).not.toHaveBeenCalled();
  });

  // The alert speaks it, a second announce would have it heard twice.
  it("is an alert, and only an alert, when a slider's max would pass its min", async () => {
    const { root, store } = await render();
    await edit(named(root, "lip maximum") as HTMLInputElement, "0");
    expect(alerts(root)).toEqual(["min must be below max"]);
    expect(vi.mocked(announce).mock.calls.filter(([t]) => /min must be below max/.test(t))).toHaveLength(0);
    expect(store.document.paramDefs!["lip"]!.control).toMatchObject({ kind: "slider", min: 0, max: 10 });
  });

  it("is an alert when a slider's bound is left empty, and clears on the next good edit", async () => {
    const { root, store } = await render();
    await edit(named(root, "lip minimum") as HTMLInputElement, "");
    expect(alerts(root)).toEqual(["a slider needs a min"]);
    await edit(named(root, "lip maximum") as HTMLInputElement, "12");
    expect(alerts(root)).toEqual([]);
    expect(store.document.paramDefs!["lip"]!.control).toMatchObject({ max: 12 });
  });

  it("speaks a step that is not positive through the field", async () => {
    const { root } = await render();
    await edit(named(root, "gap step") as HTMLInputElement, "-1");
    expect(vi.mocked(announce).mock.calls.some(([t]) => /positive number/i.test(t))).toBe(true);
  });

  it("is an alert when a check names a parameter that does not exist", async () => {
    const { root } = await render();
    await edit(named(root, "New check rule") as HTMLInputElement, "nope > 1");
    await edit(named(root, "New check message") as HTMLInputElement, "too much");
    named(root, "Add check").click();
    await flushPromises();
    expect(alerts(root)).toHaveLength(1);
    expect(alerts(root)[0]).toMatch(/nope/);
    expect(vi.mocked(announce).mock.calls.some(([t]) => /nope/.test(t))).toBe(false);
  });

  it("is an alert when a check has no rule or message", async () => {
    const { root } = await render();
    named(root, "Add check").click();
    await flushPromises();
    expect(alerts(root)).toEqual(["a check needs a rule and a message"]);
  });

  it("is an alert when a choice list cannot be read", async () => {
    const { root } = await render();
    await edit(named(root, "size choices") as HTMLInputElement, "Small = ten");
    expect(alerts(root)).toHaveLength(1);
    expect(vi.mocked(announce)).toHaveBeenCalled();
  });
});

// The panel can be under 300px wide, where a table row has no room for a Select's value.
describe("Parameter Setup, in a narrow panel", () => {
  async function renderAt(width: number) {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
    return render();
  }
  afterEach(() => vi.restoreAllMocks());

  const names = (el: Element) => [...el.querySelectorAll(CONTROLS)].map(nameOf);

  it("gives each parameter a block of its own, its range on a line of its own, in reading order", async () => {
    const { root } = await renderAt(248);
    const blocks = [...root.querySelectorAll<HTMLElement>(".xp-param")];
    expect(blocks).toHaveLength(7);
    for (const b of blocks) {
      const p = b.querySelector(".xp-kind")!.getAttribute("data-param");
      expect(b.style.display).toBe("grid");
      expect(b.querySelector<HTMLElement>(".xp-range")!.style.gridColumn).toBe("1 / -1");
      const own = names(b);
      expect(own[0]).toMatch(new RegExp(`^${p} control, `));
      expect(own.at(-2)).toMatch(new RegExp(`^${p} group, `));
      expect(own.at(-1)).toBe(`${p} Hide`);
    }
    expect(names(blocks.find((b) => b.querySelector("[data-param=lip]"))!)).toEqual([
      "lip control, Slider",
      "lip minimum",
      "lip maximum",
      "lip step",
      "lip group, No group",
      "lip Hide",
    ]);
  });

  it("drops the column headings, so the Hide box and the empty group say what they are", async () => {
    const { root } = await renderAt(248);
    expect(root.textContent).not.toContain("Range or choices");
    expect([...root.querySelectorAll(".xp-param .ui-checkbox-label")].map((l) => l.textContent?.trim())).toEqual(
      Array(7).fill("Hide"),
    );
    expect(named(root, "free group").textContent).toContain("No group");
  });

  it("puts a check's rule and message, and a configuration's name, on lines of their own", async () => {
    const { root } = await renderAt(248);
    const line = (name: string) => named(root, name).closest<HTMLElement>(".ui-field")!.style.gridColumn;
    expect(line("Check 1 rule")).toBe("2 / -1");
    expect(line("Check 1 message")).toBe("2 / -1");
    expect(line("Name of configuration Classic")).toBe("1 / -1");
    expect(line("New configuration name")).toBe("1 / -1");
    const level = named(root, "Check 1 level");
    expect(level.style.gridColumn).toBe("2");
    expect(level.parentElement!.style.display).toBe("grid");
    expect(named(root, "New check level").style.gridColumn).toBe("2");
  });

  it("is one table when the panel is wide", async () => {
    const { root } = await renderAt(640);
    expect(root.textContent).toContain("Range or choices");
    expect([...root.querySelectorAll<HTMLElement>(".xp-param")].map((b) => b.style.display)).toEqual(
      Array(7).fill("contents"),
    );
    expect(root.querySelectorAll(".xp-param .ui-checkbox-label")).toHaveLength(0);
    expect(named(root, "free group").textContent).toContain("none");
    expect(named(root, "Check 1 level").style.gridColumn).toBe("");
    expect(named(root, "Name of configuration Classic").closest<HTMLElement>(".ui-field")!.style.gridColumn).toBe("");
  });
});

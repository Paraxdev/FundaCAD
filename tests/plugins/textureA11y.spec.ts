// The Texture panel draws with the base controls: every control has a name, a length says its unit, the Faces and Whole
// Body choice is a radio group, and a refused number is an alert.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import TextureToolPanel from "../../plugins/FundaCAD.Texture/TextureToolPanel.vue";
import * as panel from "../../plugins/FundaCAD.Texture/panel";
import type { TextureMode, TextureValues } from "../../plugins/FundaCAD.Texture/textureForm";
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

const describedBy = (el: Element) => textOf(el.getAttribute("aria-describedby"));
const controlsOf = (root: Element) => [...root.querySelectorAll(CONTROLS)];
const unnamed = (root: Element) => controlsOf(root).filter((el) => !nameOf(el));

function rawControls(root: Element): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("select, textarea, input")) {
    const type = el.getAttribute("type");
    if (el.tagName === "SELECT") out.push("select");
    else if (type === "range" && !el.closest(".ui-slider")) out.push("range");
    else if (type === "checkbox" && !el.closest(".ui-checkbox")) out.push("checkbox");
    else if (type !== "range" && type !== "checkbox" && !el.closest(".ui-field")) out.push(`input[${type}]`);
  }
  for (const el of root.querySelectorAll("button")) {
    if (!/\b(btn|ui-[\w-]+|select-trigger)\b/.test(el.className)) out.push(`button.${el.className || "plain"}`);
  }
  for (const el of root.querySelectorAll("details, summary")) out.push(el.tagName.toLowerCase());
  return out;
}

const field = (root: Element, name: string) =>
  [...root.querySelectorAll<HTMLInputElement>(".ui-number-field input")].find((el) => nameOf(el) === name)!;
const button = (root: Element, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => nameOf(b) === text)!;

function type(input: HTMLInputElement, text: string) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function handlers() {
  return {
    onCommit: vi.fn<(v: TextureValues) => void>(),
    onCancel: vi.fn(),
    onChange: vi.fn<(v: TextureValues) => void>(),
    onModeChange: vi.fn<(m: TextureMode) => void>(),
  };
}

async function open(opts: Partial<Parameters<typeof panel.show>[0]> = {}) {
  const h = handlers();
  mount(TextureToolPanel, { attachTo: document.body });
  panel.show({ editing: false, mode: "faces", summary: "2 faces", initial: {}, ...opts }, h);
  await flushPromises();
  return { root: document.querySelector("[data-panel=texture]")!, h };
}

beforeEach(() => {
  panel.resetPanel();
  document.body.innerHTML = "";
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
  panel.resetPanel();
  vi.unstubAllGlobals();
});

describe("the Texture panel, for a screen reader", () => {
  it("names every control, in the open form and under Advanced", async () => {
    const { root } = await open({ palette: [{ name: "Black", color: "#000" }] });
    expect(controlsOf(root).length).toBeGreaterThan(20);
    expect(unnamed(root).map((el) => el.outerHTML.slice(0, 90))).toEqual([]);
  });

  it("draws no raw select, text input, range, checkbox, button or details", async () => {
    const { root } = await open({ initial: { kind: "image" } });
    expect(root.querySelectorAll("select")).toHaveLength(0);
    expect(root.querySelectorAll("[role=combobox]").length).toBeGreaterThanOrEqual(4);
    expect(root.querySelectorAll(".ui-slider-input")).toHaveLength(5);
    expect(rawControls(root)).toEqual([]);
  });

  it("is a named region with a heading, still marked data-panel=texture", async () => {
    const { root } = await open();
    const region = root.closest("[role=region]")!;
    expect(region).not.toBeNull();
    expect(textOf(region.getAttribute("aria-labelledby"))).toBe("Texture");
    expect(root.textContent).toContain("2 faces");
  });

  it("draws Faces and Whole Body as a radio group that follows the tool", async () => {
    const { root, h } = await open({ mode: "faces" });
    const group = root.querySelector("[role=radiogroup]")!;
    expect(group).not.toBeNull();
    expect(nameOf(group)).not.toBe("");
    const radios = [...group.querySelectorAll<HTMLElement>("[role=radio]")];
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["Faces", "Whole Body"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    radios[1]!.click();
    await flushPromises();
    expect(h.onModeChange).toHaveBeenCalledWith("body");
    panel.mode.value = "faces";
    await flushPromises();
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("offers every pattern in the Kind list, each naming its group", async () => {
    const { root } = await open();
    const kind = [...root.querySelectorAll<HTMLElement>("[role=combobox]")].find((el) => /^Kind/.test(nameOf(el)))!;
    kind.click();
    await flushPromises();
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(16);
    expect(options[0]!.textContent).toMatch(/Knurl/);
    expect(options[0]!.textContent).toMatch(/Geometric/);
    expect(options.at(-1)!.textContent).toMatch(/Heightmap/);
  });

  it("says millimetres on a length, degrees on an angle and nothing on a count", async () => {
    const { root } = await open();
    for (const name of ["Depth", "Scale", "Offset", "Edge blend", "Mesh detail"]) {
      expect(describedBy(field(root, name)), name).toMatch(/mm|millimet/i);
    }
    for (const name of ["Angle", "Slope min", "Slope max"]) {
      expect(describedBy(field(root, name)), name).toMatch(/deg|°/i);
    }
    for (const name of ["Seed", "Max triangles"]) expect(describedBy(field(root, name)), name).toBe("");
  });

  it("reads a percentage slider as a percentage", async () => {
    const { root } = await open({ initial: { grime: 0.25 } });
    const grime = [...root.querySelectorAll<HTMLInputElement>(".ui-slider-input")].find(
      (el) => nameOf(el) === "Grime",
    )!;
    expect(grime.getAttribute("aria-valuetext")).toBe("25%");
  });

  it("keeps the Add and Cancel buttons on pointerdown, and answers a keyboard click as well", async () => {
    const { root, h } = await open();
    const add = button(root, "Add");
    add.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    add.click();
    expect(h.onCommit).toHaveBeenCalledTimes(2);
    button(root, "Cancel").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the live preview going on an edit of a base control", async () => {
    const { root, h } = await open();
    type(field(root, "Depth"), "1.5");
    await flushPromises();
    expect(h.onChange.mock.lastCall![0].depth).toBe(1.5);
    const amplitude = [...root.querySelectorAll<HTMLInputElement>(".ui-slider-input")].find(
      (el) => nameOf(el) === "Amplitude",
    )!;
    amplitude.value = "50";
    amplitude.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    expect(h.onChange.mock.lastCall![0].amplitude).toBe(0.5);
  });
});

describe("a refused number", () => {
  it("is not shown or spoken for what the form opens with", async () => {
    const { root } = await open();
    await wait(800);
    expect(root.querySelectorAll("[data-testid=texture-field-error]")).toHaveLength(0);
    expect(announce).not.toHaveBeenCalled();
  });

  // The alert speaks it, a second announce would have it heard twice.
  it("is an alert naming the field, not announced as well, and gone when fixed", async () => {
    const { root } = await open();
    type(field(root, "Depth"), "abc");
    await flushPromises();
    const alerts = [...root.querySelectorAll("[data-testid=texture-field-error]")];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.getAttribute("role")).toBe("alert");
    expect(alerts[0]!.textContent).toMatch(/Depth/);
    await wait(800);
    expect(vi.mocked(announce).mock.calls.filter(([t]) => /Depth/.test(t))).toHaveLength(0);

    type(field(root, "Depth"), "0.5");
    await flushPromises();
    expect(root.querySelectorAll("[data-testid=texture-field-error]")).toHaveLength(0);
  });

  it("does not stay behind when the tool reopens the panel", async () => {
    const { root, h } = await open();
    type(field(root, "Depth"), "abc");
    await flushPromises();
    expect(root.querySelectorAll("[data-testid=texture-field-error]")).toHaveLength(1);
    panel.hide();
    await flushPromises();
    panel.show({ editing: false, mode: "faces", summary: "", initial: {} }, h);
    await flushPromises();
    expect(document.querySelectorAll("[data-testid=texture-field-error]")).toHaveLength(0);
  });
});

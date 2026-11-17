// The reference image panel and browser section for a screen reader: every control is named, the numbers say their unit,
// the images are a list, a refusal is an error alert in words and the calibration prompt is a status. The hidden file
// picker stays a raw input, named.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import ImagePanel from "../../plugins/FundaCAD.ReferenceImages/ImagePanel.vue";
import ItemsSection from "../../plugins/FundaCAD.ReferenceImages/ItemsSection.vue";
import { calibrating, selected, tool } from "../../plugins/FundaCAD.ReferenceImages/state";
import { RefImageTool } from "../../plugins/FundaCAD.ReferenceImages/tool";
import { ENGINE } from "../../src/app/engineKey";
import type { Engine } from "../../src/app/engine";
import { byName, describedBy, nameOf, rawControls, stubResizeObserver, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

const HASH = "0123456789abcdef0123456789abcdef";
const image = (over: Record<string, unknown> = {}) => ({
  id: "ri1",
  name: "Front photo",
  image: HASH,
  mime: "image/png",
  px: [400, 300],
  plane: "XY",
  at: [0, 0],
  width: 200,
  angle: 15,
  flipX: false,
  flipY: false,
  opacity: 0.5,
  locked: false,
  hidden: false,
  ...over,
});

function fakeEngine(list: Record<string, unknown>[]) {
  let current = list;
  const listeners = new Set<(l: readonly Record<string, unknown>[]) => void>();
  const store = {
    referenceImages: () => current,
    setReferenceImages: vi.fn((next: Record<string, unknown>[]) => {
      current = next;
      for (const fn of listeners) fn(current);
    }),
    onReferenceImagesChange(fn: (l: readonly Record<string, unknown>[]) => void) {
      listeners.add(fn);
      fn(current);
      return () => listeners.delete(fn);
    },
  };
  return { store, engine: { store, bridge: { docVersion: ref(0) } } as unknown as Engine };
}

function fakeTool() {
  return {
    write: vi.fn(),
    cancel: vi.fn(),
    endGesture: vi.fn(),
    startCalibrate: vi.fn(),
    finishCalibrate: vi.fn((): string | null => null),
    remove: vi.fn(),
    missing: vi.fn((id: string) => id === "ri2"),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  setActivePinia(createPinia());
  stubResizeObserver(vi.stubGlobal);
});

afterEach(() => {
  selected.value = null;
  calibrating.value = null;
  tool.value = null;
  vi.unstubAllGlobals();
});

async function openPanel(over: Record<string, unknown> = {}) {
  const fake = fakeEngine([image(over)]);
  const t = fakeTool();
  tool.value = t as unknown as RefImageTool;
  selected.value = "ri1";
  mount(ImagePanel, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: fake.engine } } });
  await flushPromises();
  const root = document.querySelector<HTMLElement>("[data-panel=reference-image]")!.closest(".ui-panel") as HTMLElement;
  return { root, t, fake };
}

async function openSection(list = [image(), image({ id: "ri2", name: "Side drawing", locked: true, hidden: true })]) {
  const fake = fakeEngine(list);
  const t = fakeTool();
  tool.value = t as unknown as RefImageTool;
  mount(ItemsSection, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: fake.engine } } });
  await flushPromises();
  return { root: document.body, t, fake };
}

const field = (root: Element, key: string) => root.querySelector<HTMLInputElement>(`[data-field=${key}]`)!;
const alerts = (root: Element) => [...root.querySelectorAll("[role=alert]")].map((a) => a.textContent?.trim());

async function enter(el: HTMLInputElement, text: string) {
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flushPromises();
}

describe("the reference image panel, for a screen reader", () => {
  it("is a region named by the image and draws no raw control", async () => {
    const { root } = await openPanel();
    expect(root.getAttribute("role")).toBe("region");
    expect(nameOf(root)).toBe("Front photo");
    expect(rawControls(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
  });

  it("names every control", async () => {
    const { root } = await openPanel();
    for (const name of ["Width", "Angle", "Opacity", "Flip X", "Flip Y", "Lock", "Close", "Calibrate"]) {
      expect(byName(root, "input, button, [role=switch], [role=checkbox], [role=slider]", name), name).toBeDefined();
    }
    expect(root.querySelector("[data-field=width]")).not.toBeNull();
    expect(root.querySelector("[data-field=locked]")).not.toBeNull();
  });

  it("says the unit of the width and of the angle, and the opacity as a percent", async () => {
    const { root } = await openPanel();
    expect(describedBy(field(root, "width"))).toMatch(/mm|millimet/i);
    expect(describedBy(field(root, "angle"))).toMatch(/deg|degree|°/i);
    const opacity = byName(root, "input", "Opacity")!;
    expect(opacity.getAttribute("type")).toBe("range");
    expect(opacity.getAttribute("aria-valuetext")).toBe("50%");
  });

  it("writes a typed width and a typed angle", async () => {
    const { root, t } = await openPanel();
    await enter(field(root, "width"), "250");
    expect(t.write).toHaveBeenCalledWith("ri1", { width: 250 }, undefined);
    await enter(field(root, "angle"), "45");
    expect(t.write).toHaveBeenCalledWith("ri1", { angle: 45 }, undefined);
  });

  it("tells a width that is no length as an error alert naming the field", async () => {
    const { root, t } = await openPanel();
    expect(alerts(root)).toEqual([]);
    await enter(field(root, "width"), "abc");
    expect(alerts(root)).toHaveLength(1);
    expect(alerts(root)[0]).toMatch(/^Error: Width: /);
    expect(t.write).not.toHaveBeenCalled();
    await enter(field(root, "width"), "120");
    expect(alerts(root)).toEqual([]);
  });

  it("flips and locks", async () => {
    const { root, t } = await openPanel();
    byName<HTMLInputElement>(root, "input", "Flip X")!.click();
    expect(t.write).toHaveBeenCalledWith("ri1", { flipX: true }, undefined);
    byName<HTMLButtonElement>(root, "[role=switch]", "Lock")!.click();
    expect(t.write).toHaveBeenCalledWith("ri1", { locked: true }, undefined);
  });

  it("disables what a locked image cannot do", async () => {
    const { root } = await openPanel({ locked: true });
    const locked = [
      field(root, "width"),
      field(root, "angle"),
      ...["Flip X", "Flip Y"].map((n) => byName<HTMLInputElement>(root, "input", n)!),
    ];
    for (const el of locked) {
      expect(el.disabled || el.getAttribute("aria-disabled") === "true" || el.readOnly, nameOf(el)).toBe(true);
    }
    expect(root.querySelector("[data-action=calibrate]")!.getAttribute("aria-disabled")).toBe("true");
  });

  it("starts a calibration and closes", async () => {
    const { root, t } = await openPanel();
    root.querySelector<HTMLButtonElement>("[data-action=calibrate]")!.click();
    expect(t.startCalibrate).toHaveBeenCalledWith("ri1");
    root.querySelector<HTMLButtonElement>("[data-action=close]")!.click();
    await nextTick();
    expect(selected.value).toBeNull();
  });
});

describe("a calibration, for a screen reader", () => {
  async function calibratingPanel(stage: "first" | "second" | "distance") {
    const opened = await openPanel();
    calibrating.value =
      stage === "first"
        ? { id: "ri1", stage }
        : stage === "second"
          ? { id: "ri1", stage, a: [0, 0] }
          : { id: "ri1", stage, a: [0, 0], b: [1, 0] };
    await flushPromises();
    return opened;
  }

  it("says the step as a status that follows the clicks", async () => {
    const { root } = await calibratingPanel("first");
    const status = root.querySelector("[role=status]")!;
    expect(status.textContent).toBe("Click the first point on the image.");
    calibrating.value = { id: "ri1", stage: "second", a: [0, 0] };
    await flushPromises();
    expect(root.querySelector("[role=status]")!.textContent).toBe("Click the second point.");
    expect(unnamed(root)).toEqual([]);
    expect(rawControls(root)).toEqual([]);
  });

  it("names the distance in millimetres and takes it from the keyboard", async () => {
    const { root, t } = await calibratingPanel("distance");
    const distance = field(root, "distance");
    expect(nameOf(distance)).toBe("Distance");
    expect(describedBy(distance)).toMatch(/mm|millimet/i);
    await enter(distance, "250");
    expect(t.finishCalibrate).toHaveBeenCalledWith("250");
  });

  it("tells a refused distance as an error alert in words, and Cancel leaves", async () => {
    const { root, t } = await calibratingPanel("distance");
    t.finishCalibrate.mockReturnValue("Type a length above zero");
    await enter(field(root, "distance"), "100");
    expect(alerts(root)).toEqual(["Error: Type a length above zero"]);
    byName<HTMLButtonElement>(root, "button", "Cancel")!.click();
    expect(t.cancel).toHaveBeenCalled();
  });

  it("tells a distance that is no length as an error alert naming the field", async () => {
    const { root, t } = await calibratingPanel("distance");
    await enter(field(root, "distance"), "abc");
    expect(alerts(root)[0]).toMatch(/^Error: Distance: /);
    expect(t.finishCalibrate).not.toHaveBeenCalled();
  });
});

describe("the reference images section, for a screen reader", () => {
  it("lists the images, each named, and draws no raw control", async () => {
    const { root } = await openSection();
    expect(rawControls(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
    const list = root.querySelector("[role=list]")!;
    expect(nameOf(list)).toBe("Reference images");
    expect([...list.querySelectorAll("[role=listitem]")]).toHaveLength(2);
    expect(root.querySelector("[data-section=reference-images]")).not.toBeNull();
    expect(root.querySelectorAll("[data-ref-image]")).toHaveLength(2);
  });

  it("names each image's buttons after the image and says its state", async () => {
    const { root } = await openSection();
    const names = [...root.querySelectorAll("button")].map(nameOf);
    expect(names).toEqual(
      expect.arrayContaining([
        "Collapse Reference images",
        "Settings of Front photo",
        "Lock Front photo against moving and calibrating",
        "Delete Front photo",
        "Hide Front photo",
        "Show Side drawing",
      ]),
    );
    const lock = (n: string) => byName(root, "button", `Lock ${n} against moving and calibrating`)!;
    expect(lock("Front photo").getAttribute("aria-pressed")).toBe("false");
    expect(lock("Side drawing").getAttribute("aria-pressed")).toBe("true");
  });

  it("says an image whose file is missing in words", async () => {
    const { root } = await openSection();
    const row = root.querySelector('[data-ref-image="ri2"]')!;
    expect(row.textContent).toContain("image not found");
    expect(root.querySelector('[data-ref-image="ri1"]')!.textContent).not.toContain("image not found");
  });

  it("opens an image's settings, locks, hides and deletes from buttons", async () => {
    const { root, t, fake } = await openSection();
    byName<HTMLButtonElement>(root, "button", "Settings of Front photo")!.click();
    expect(selected.value).toBe("ri1");
    await nextTick();
    expect(byName(root, "button", "Settings of Front photo")!.getAttribute("aria-pressed")).toBe("true");
    byName<HTMLButtonElement>(root, "button", "Lock Front photo against moving and calibrating")!.click();
    expect(fake.store.setReferenceImages).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "ri1", locked: true })]),
    );
    byName<HTMLButtonElement>(root, "button", "Hide Front photo")!.click();
    expect(fake.store.setReferenceImages).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "ri1", hidden: true })]),
    );
    byName<HTMLButtonElement>(root, "button", "Delete Front photo")!.click();
    expect(t.remove).toHaveBeenCalledWith("ri1");
  });

  it("folds the list from the caret, which says it is expanded", async () => {
    const { root } = await openSection();
    const caret = byName<HTMLButtonElement>(root, "button", "Collapse Reference images")!;
    expect(caret.getAttribute("aria-expanded")).toBe("true");
    caret.click();
    await flushPromises();
    const folded = byName(root, "button", "Expand Reference images")!;
    expect(folded.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector("[role=list]")).toBeNull();
  });

  it("draws nothing without an image", async () => {
    const { root } = await openSection([]);
    expect(root.querySelector("[role=list]")).toBeNull();
    expect(root.querySelector("button")).toBeNull();
  });
});

describe("the hidden file picker", () => {
  it("stays a raw file input, no base control picks a file, and it carries a name", () => {
    const fake = { add: vi.fn() };
    (RefImageTool.prototype as unknown as { chooseFile(p: string, d: null): void }).chooseFile.call(fake, "XY", null);
    const input = document.getElementById("ri-file-input") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(nameOf(input)).toBe("Reference image file");
    expect(rawControls(document.body)).toEqual(["input[file]"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import type { Component } from "vue";

import Button from "../../../src/components/ui/Button.vue";
import ChoiceList from "../../../src/components/ui/ChoiceList.vue";
import IconButton from "../../../src/components/ui/IconButton.vue";
import NumberField from "../../../src/components/ui/NumberField.vue";
import Slider from "../../../src/components/ui/Slider.vue";
import UnitChip from "../../../src/components/ui/UnitChip.vue";
import {
  onActivate,
  setChipUnit,
  setDisabled,
  setExpanded,
  setInvalid,
  setPressed,
  uiButton,
  uiIconButton,
  uiNumberInput,
  uiOption,
  uiSlider,
  uiUnitChip,
} from "../../../src/components/ui/dom";

enableAutoUnmount(afterEach);
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

interface Shape {
  tag: string;
  classes: string[];
  attrs: Record<string, string>;
  text: string;
  children: Shape[];
}

/** Tag, sorted classes, attributes and text, all the way down. An id reference is followed to the text it names, so
 *  generated ids compare equal. */
function shape(el: Element): Shape {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    // An input's value is compared as its property: Vue writes the attribute too, the factories only the property.
    if (["class", "id", "style", "value"].includes(a.name) || a.name.startsWith("data-v-")) continue;
    attrs[a.name] = a.name === "aria-labelledby" ? (document.getElementById(a.value)?.textContent ?? "?") : a.value;
  }
  const kids = Array.from(el.children);
  return {
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList).sort(),
    attrs,
    text: kids.length ? "" : (el.textContent ?? ""),
    children: kids.map(shape),
  };
}

/** The component's first element, past the mount point test-utils puts inside the host. */
function vue(component: Component, props: Record<string, unknown>, slots: Record<string, string> = {}): Element {
  const host = document.createElement("div");
  document.body.append(host);
  mount(component, { props, slots, attachTo: host });
  return host.firstElementChild!.firstElementChild!;
}

function dom(el: Element): Element {
  document.body.append(el);
  return el;
}

describe("dom.ts controls match their Vue twins", () => {
  it.each([
    { label: "Save" },
    { label: "Save", variant: "primary", size: "sm", block: true, icon: "check" },
    { tip: "Delete", keys: "Del", icon: "trash", variant: "danger" },
    { label: "Grid", pressed: false },
    { label: "Grid", pressed: true, variant: "ghost" },
    { label: "Open", variant: "tile" },
    { label: "Export", disabled: true, disabledReason: "Nothing to export" },
  ])("Button %o", (p) => {
    const { label, ...props } = p as Record<string, unknown> & { label?: string };
    const theirs = vue(Button, props, label === undefined ? {} : { default: label });
    expect(shape(dom(uiButton(p as Parameters<typeof uiButton>[0])))).toEqual(shape(theirs));
  });

  it.each([
    { icon: "close", tip: "Close" },
    { icon: "grid", tip: "Grid", keys: "G", size: "sm", variant: "plain", active: true },
    { icon: "grid", tip: "Grid", active: false, iconSize: 18 },
    { icon: "bell", tip: "Problems", badge: 3, size: "md" },
    { icon: "bell", tip: "Problems", badge: "" },
    { icon: "trash", tip: "Delete", variant: "danger", disabled: true, disabledReason: "Locked" },
  ])("IconButton %o", (p) => {
    expect(shape(dom(uiIconButton(p as Parameters<typeof uiIconButton>[0])))).toEqual(shape(vue(IconButton, p)));
  });

  it.each([
    { unit: "deg" },
    { unit: "%", tip: "Share" },
    { unit: "mm", options: ["mm", "in", "um"] },
    { unit: "in", options: ["mm", "in"], tip: "Unit, in", keys: "U" },
    { unit: "mm", options: ["mm", "in"], disabled: true, disabledReason: "Fixed" },
  ])("UnitChip %o", (p) => {
    expect(shape(dom(uiUnitChip(p)))).toEqual(shape(vue(UnitChip, p)));
  });

  it.each([
    [{ tip: "Width" }, { tip: "Width" }],
    [
      { tip: "Depth", size: "sm", unit: "mm", units: ["mm", "in"], unitTip: "Unit", widthCh: 6, placeholder: "0" },
      { tip: "Depth", size: "sm", unit: "mm", units: ["mm", "in"], unitTip: "Unit", widthCh: 6, placeholder: "0" },
    ],
    [
      { tip: "Angle", unit: "deg" },
      { tip: "Angle", unit: "deg" },
    ],
    [
      { tip: "Count", disabled: true, disabledReason: "Driven" },
      { tip: "Count", disabled: true, disabledReason: "Driven" },
    ],
  ])("NumberField %o", (factory, props) => {
    const mine = uiNumberInput(factory as Parameters<typeof uiNumberInput>[0]);
    const theirs = vue(NumberField, { modelValue: null, ...props });
    expect(shape(dom(mine.root))).toEqual(shape(theirs));
    expect(mine.root.style.getPropertyValue("--field-ch")).toBe(
      (theirs as HTMLElement).style.getPropertyValue("--field-ch"),
    );
  });

  it("NumberField's inputMode is text for a field that takes expressions", () => {
    expect(uiNumberInput({ tip: "Width", inputMode: "text" }).input.getAttribute("inputmode")).toBe("text");
  });

  it.each([
    { value: 30, tip: "Opacity" },
    { value: 0.7, min: 0, max: 1, step: 0.1, label: "Round", showValue: true },
    { value: 40, unit: "%", label: "Mix", showValue: true },
    { value: 5, unit: "mm", tip: "Gap", keys: "G" },
    { value: 5, tip: "Gap", disabled: true, disabledReason: "Locked" },
  ])("Slider %o", (p) => {
    const mine = uiSlider(p);
    const { value, ...props } = p;
    const theirs = vue(Slider, { modelValue: value, ...props });
    expect(shape(dom(mine.root))).toEqual(shape(theirs));
    const [a, b] = [mine.input, theirs.querySelector("input")!];
    expect([a.value, a.style.getPropertyValue("--ui-slider-fill")]).toEqual([
      b.value,
      b.style.getPropertyValue("--ui-slider-fill"),
    ]);
  });

  const choices = [
    { value: "mm", label: "mm" },
    { value: "in", label: "in", hint: "inch", title: "Imperial" },
    { value: "deg", label: "deg" },
  ];
  const listRows = (active: number) =>
    Array.from(vue(ChoiceList, { options: choices, modelValue: "in", active, id: "lst" }).children);

  it("ChoiceList's driven rows", () => {
    const theirs = listRows(1);
    const mine = choices.map((c, i) => {
      const row = uiOption({
        id: `lst-${i}`,
        label: c.label,
        hint: c.hint,
        title: c.title,
        selected: c.value === "in",
      });
      row.classList.toggle("is-active", i === 1);
      return dom(row);
    });
    expect(mine.map(shape)).toEqual(theirs.map(shape));
    expect(mine.map((r) => r.id)).toEqual(theirs.map((r) => r.id));
  });

  it("a bare option drops only .opt-row, so a list keeps its own row look", () => {
    const theirs = shape(listRows(0)[0]!);
    expect(shape(dom(uiOption({ id: "lst-0", label: "mm", bare: true })))).toEqual({
      ...theirs,
      classes: theirs.classes.filter((c) => c !== "opt-row" && c !== "is-active"),
    });
  });

  it("an option's press keeps focus on the combobox", () => {
    const row = dom(uiOption({ id: "o-0", label: "mm" }));
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    row.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });
});

describe("dom.ts control state", () => {
  it("setPressed and setDisabled flip the same marks the Vue props set", () => {
    const b = uiIconButton({ icon: "grid", tip: "Grid" });
    setPressed(b, true);
    expect([b.getAttribute("aria-pressed"), b.classList.contains("is-on"), b.classList.contains("active")]).toEqual([
      "true",
      true,
      true,
    ]);
    setDisabled(b, true, "Not here");
    expect([b.getAttribute("aria-disabled"), b.title]).toEqual(["true", "Not here"]);
    setDisabled(b, false);
    expect([b.hasAttribute("aria-disabled"), b.classList.contains("is-disabled"), b.title]).toEqual([
      false,
      false,
      "Grid",
    ]);
  });

  it("a unit picker shows the picked unit and its open list", () => {
    const chip = uiUnitChip({ unit: "mm", options: ["mm", "deg"] });
    setChipUnit(chip, "deg");
    setExpanded(chip, true, "units-1");
    expect([
      chip.dataset.value,
      chip.textContent,
      chip.getAttribute("aria-label"),
      chip.getAttribute("aria-expanded"),
      chip.getAttribute("aria-controls"),
    ]).toEqual(["deg", "°", "Unit, °", "true", "units-1"]);
    setExpanded(chip, false);
    expect([
      chip.getAttribute("aria-expanded"),
      chip.hasAttribute("aria-controls"),
      chip.classList.contains("open"),
    ]).toEqual(["false", false, false]);
  });

  it("a refused number input is marked invalid with the reason as its title, and freed again", () => {
    const f = uiNumberInput({ tip: "Width" });
    setInvalid(f, "Must be positive");
    expect([f.input.getAttribute("aria-invalid"), f.input.title, f.root.classList.contains("is-error")]).toEqual([
      "true",
      "Must be positive",
      true,
    ]);
    setInvalid(f, null);
    expect([f.input.hasAttribute("aria-invalid"), f.input.title, f.root.classList.contains("is-error")]).toEqual([
      false,
      "Width",
      false,
    ]);
  });

  it("a press on a number input's frame focuses its input and keeps the press from taking focus", () => {
    const f = uiNumberInput({ tip: "Width" });
    dom(f.root);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    f.root.dispatchEvent(down);
    expect([down.defaultPrevented, document.activeElement]).toEqual([true, f.input]);
  });

  it("a slider steps one snapped value per key, commits it and speaks its value text", () => {
    const got: [number, boolean][] = [];
    const s = uiSlider({
      value: 0.7,
      min: 0,
      max: 1,
      step: 0.1,
      tip: "Round",
      valueText: (v) => `${v}, rounded`,
      onValue: (v, c) => got.push([v, c]),
    });
    s.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
    s.input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", cancelable: true }));
    s.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true }));
    expect(got).toEqual([
      [0.8, true],
      [1, true],
    ]);
    expect([s.input.value, s.input.getAttribute("aria-valuetext")]).toEqual(["1", "1, rounded"]);
    s.input.value = "0.3";
    s.input.dispatchEvent(new Event("input"));
    expect(got.at(-1)).toEqual([0.3, false]);
    s.set(0.5);
    expect([got.length, s.input.getAttribute("aria-valuetext")]).toEqual([3, "0.5, rounded"]);
  });

  it("a disabled slider ignores its keys and puts a dragged value back", () => {
    const got: number[] = [];
    const s = uiSlider({ value: 5, tip: "Gap", disabled: true, onValue: (v) => got.push(v) });
    s.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
    s.input.value = "9";
    s.input.dispatchEvent(new Event("input"));
    expect([got, s.input.value]).toEqual([[], "5"]);
  });
});

describe("onActivate", () => {
  function button(opts: { disabled?: boolean } = {}) {
    const b = dom(uiButton({ label: "Confirm", disabled: opts.disabled })) as HTMLButtonElement;
    const acts: string[] = [];
    onActivate(b, (e) => acts.push(e.type));
    return { b, acts };
  }
  const press = (b: Element, button = 0) => {
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button });
    b.dispatchEvent(down);
    return down;
  };
  const release = (at: EventTarget) => at.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  const click = (b: Element) => b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  it("acts once for a pointer press and its click, and keeps focus where it was", () => {
    const { b, acts } = button();
    const down = press(b);
    release(b);
    click(b);
    expect([acts, down.defaultPrevented]).toEqual([["pointerdown"], true]);
  });

  it("acts on a lone click, as Enter, Space and a screen reader send it", () => {
    const { b, acts } = button();
    click(b);
    b.focus();
    b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    click(b);
    expect(acts).toEqual(["click", "click"]);
  });

  it("acts on a key's click that comes well after a press released off the button", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { b, acts } = button();
    press(b);
    release(document.body);
    vi.advanceTimersByTime(1500);
    click(b);
    expect(acts).toEqual(["pointerdown", "click"]);
  });

  it("still takes a touch's late click as the press's own", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { b, acts } = button();
    press(b);
    release(b);
    vi.advanceTimersByTime(350);
    click(b);
    expect(acts).toEqual(["pointerdown"]);
  });

  it("ignores a secondary button press", () => {
    const { b, acts } = button();
    const down = press(b, 2);
    expect([acts, down.defaultPrevented]).toEqual([[], false]);
  });

  it("acts on a plain press event with no button, as tests and the harness send it", () => {
    const { b, acts } = button();
    b.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(acts).toEqual(["pointerdown"]);
  });

  it("refuses a disabled button's press, click and Enter", () => {
    const { b, acts } = button({ disabled: true });
    press(b);
    release(b);
    click(b);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    b.dispatchEvent(enter);
    click(b);
    expect([acts, enter.defaultPrevented]).toEqual([[], true]);
  });
});

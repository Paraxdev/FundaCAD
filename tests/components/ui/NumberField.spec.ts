import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import NumberField from "../../../src/components/ui/NumberField.vue";
import { measureError, unitById } from "../../../src/ui/measure";

enableAutoUnmount(afterEach);
afterEach(() => vi.useRealTimers());

type Props = InstanceType<typeof NumberField>["$props"];

async function render(props: Record<string, unknown> = {}) {
  const w = mount(NumberField, {
    props: { modelValue: 5, label: "Depth", ...props } as never,
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  const input = w.get("input");
  const el = input.element as HTMLInputElement;
  return { w, input, el };
}

const emitted = (w: Awaited<ReturnType<typeof render>>["w"]) => w.emitted<[number | null]>("update:modelValue") ?? [];

async function commit(input: Awaited<ReturnType<typeof render>>["input"], text: string) {
  await input.setValue(text);
  await input.trigger("keydown", { key: "Enter" });
}

describe("NumberField", () => {
  it("shows the model in its unit", async () => {
    const { el } = await render({ modelValue: 25.4, unit: "in" });
    expect(el.value).toBe("1");
  });

  it("emits nothing while typing and the parsed value on Enter and on blur", async () => {
    const { w, input } = await render();
    await input.setValue("7");
    expect(emitted(w)).toEqual([]);
    await input.trigger("keydown", { key: "Enter" });
    await w.setProps({ modelValue: 7 });
    await input.setValue("8");
    await input.trigger("blur");
    expect(emitted(w)).toEqual([[7], [8]]);
  });

  it.each([
    ["1 in", "mm", 25.4],
    ["1 1/2 in", "mm", 38.1],
    ["2,5", "mm", 2.5],
    ["2", "in", 50.8],
    ["10+5", null, 15],
    ["90 deg", "rad", 90],
  ])("reads %j in a %s field as %d", async (text, unit, value) => {
    const { w, input } = await render({ unit });
    await commit(input, text);
    expect(emitted(w)[0]![0]).toBeCloseTo(value, 9);
  });

  it("keeps rejected text with aria-invalid and the parse reason as title", async () => {
    const { w, input, el } = await render({ tip: "Depth", unit: "mm" });
    await commit(input, "2 +");
    expect(emitted(w)).toEqual([]);
    expect([el.value, input.attributes("aria-invalid"), input.attributes("title"), w.classes("is-error")]).toEqual([
      "2 +",
      "true",
      measureError("2 +", unitById("mm")),
      true,
    ]);
  });

  it("names the input by its label, and keeps tip and keys in the title only", async () => {
    const { input } = await render({ label: "Depth", tip: "Cut depth", keys: "D" });
    expect([input.attributes("aria-label"), input.attributes("title")]).toEqual(["Depth", "Cut depth (D)"]);
  });

  it("names the input by labelledby alone when given one", async () => {
    const { input } = await render({ label: undefined, labelledby: "depth-label" });
    expect([input.attributes("aria-label"), input.attributes("aria-labelledby")]).toEqual([undefined, "depth-label"]);
  });

  it("warns in a dev build when it has no name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount(NumberField, { props: { modelValue: 1 } as never });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("NumberField has no name"))).toBe(true);
    warn.mockRestore();
  });

  it("refuses a typed value outside min and max, and a validate answer, with the reason", async () => {
    const { w, input } = await render({
      unit: "mm",
      min: 0,
      max: 100,
      validate: (v: number) => (v === 13 ? "Not that one" : null),
    });
    await commit(input, "-1");
    expect(input.attributes("title")).toBe("At least 0 mm");
    await commit(input, "101");
    expect(input.attributes("title")).toBe("At most 100 mm");
    await commit(input, "13");
    expect(input.attributes("title")).toBe("Not that one");
    expect(emitted(w)).toEqual([]);
  });

  it("shows an outside problem until it is withdrawn", async () => {
    const { w, input } = await render({ problem: "The kernel could not cut that deep" });
    expect([input.attributes("aria-invalid"), input.attributes("title")]).toEqual([
      "true",
      "The kernel could not cut that deep",
    ]);
    await w.setProps({ problem: null });
    expect(input.attributes("aria-invalid")).toBeUndefined();
  });

  it("restores the committed text on Escape", async () => {
    const { w, input, el } = await render();
    await input.setValue("9");
    await input.trigger("keydown", { key: "Escape" });
    expect(el.value).toBe("5");
    await input.trigger("blur");
    expect(emitted(w)).toEqual([]);
  });

  it("steps with ArrowUp and ArrowDown, ten times with Shift, clamped to min and max, committed on Enter", async () => {
    const { w, input, el } = await render({ min: 0, max: 12, step: 0.5 });
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(el.value).toBe("5.5");
    expect(emitted(w)).toEqual([]);
    await input.trigger("keydown", { key: "ArrowUp", shiftKey: true });
    expect(el.value).toBe("10.5");
    await input.trigger("keydown", { key: "ArrowUp", shiftKey: true });
    expect(el.value).toBe("12");
    await input.trigger("keydown", { key: "Enter" });
    expect(emitted(w)).toEqual([[12]]);
    await w.setProps({ modelValue: 12 });
    for (let i = 0; i < 3; i++) await input.trigger("keydown", { key: "ArrowDown", shiftKey: true });
    expect(el.value).toBe("0");
  });

  it("steps in the shown unit", async () => {
    const { w, input, el } = await render({ modelValue: 25.4, unit: "in", step: 0.25, commit: "live" });
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(el.value).toBe("1.25");
    expect(emitted(w)[0]![0]).toBeCloseTo(31.75, 9);
  });

  it("in live mode emits on every input that parses", async () => {
    const { w, input } = await render({ commit: "live" });
    await input.setValue("1");
    await input.setValue("1/");
    await input.setValue("1/2");
    expect(emitted(w)).toEqual([[1], [0.5]]);
    expect(input.attributes("aria-invalid")).toBeUndefined();
  });

  it("emits null for a blank nullable field and restores a blank required one", async () => {
    const a = await render({ nullable: true });
    await commit(a.input, "");
    expect(emitted(a.w)).toEqual([[null]]);
    const b = await render({ modelValue: 3 });
    await commit(b.input, " ");
    await b.w.vm.$nextTick();
    expect([emitted(b.w), b.el.value]).toEqual([[], "3"]);
  });

  it("shows null as blank", async () => {
    const { el } = await render({ modelValue: null, nullable: true, placeholder: "auto" });
    expect([el.value, el.placeholder]).toEqual(["", "auto"]);
  });

  it("keeps a focused draft when the value changes outside", async () => {
    const { w, input, el } = await render();
    el.focus();
    await input.setValue("12");
    await w.setProps({ modelValue: 99 });
    expect(el.value).toBe("12");
  });

  it("previews on a debounce, ends it on Escape, on commit and on unmount", async () => {
    const preview = vi.fn();
    const previewEnd = vi.fn();
    const { w, input } = await render({ preview, previewEnd });
    vi.useFakeTimers();
    await input.setValue("7");
    await input.setValue("7 in");
    vi.advanceTimersByTime(199);
    expect(preview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(preview.mock.calls.length).toBe(1);
    expect(preview.mock.calls[0]![0]).toBeCloseTo(177.8, 9);
    await input.trigger("keydown", { key: "Escape" });
    expect(previewEnd.mock.calls).toEqual([[false]]);

    await input.setValue("8");
    vi.advanceTimersByTime(200);
    await input.trigger("keydown", { key: "Enter" });
    expect(previewEnd.mock.calls).toEqual([[false], [true]]);

    await input.setValue("2 +");
    vi.advanceTimersByTime(200);
    expect(preview.mock.calls.length).toBe(2);
    await input.setValue("9");
    vi.advanceTimersByTime(200);
    w.unmount();
    expect(previewEnd.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("ends a live preview as not committing when the commit is refused", async () => {
    const preview = vi.fn();
    const previewEnd = vi.fn();
    const { w, input } = await render({ preview, previewEnd });
    vi.useFakeTimers();
    await input.setValue("5");
    vi.advanceTimersByTime(200);
    expect(preview.mock.calls).toEqual([[5]]);
    await commit(input, "5x");
    expect(emitted(w)).toEqual([]);
    expect(previewEnd.mock.calls).toEqual([[false]]);
  });

  it("never schedules a preview nobody asked for, and a blur with no preview ends nothing", async () => {
    const previewEnd = vi.fn();
    const { input } = await render({ previewEnd });
    await input.trigger("blur");
    expect(previewEnd).not.toHaveBeenCalled();
  });

  it("draws the unit beside the value, and a picker when units are offered", async () => {
    const a = await render({ unit: "mm" });
    expect(a.w.get(".ui-unit-chip").text()).toBe("mm");
    const b = await render({ unit: "mm", units: ["mm", "in"] });
    expect(b.w.get(".ui-unit-chip").attributes("role")).toBe("combobox");
  });

  it("disabled: aria-disabled, read only, no step and no emit", async () => {
    const { w, input, el } = await render({ disabled: true });
    expect([input.attributes("aria-disabled"), input.attributes("readonly"), w.classes("is-disabled")]).toEqual([
      "true",
      "",
      true,
    ]);
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(el.value).toBe("5");
    await commit(input, "6");
    expect(emitted(w)).toEqual([]);
  });

  it("sets its width in ch", async () => {
    const { w } = await render({ widthCh: 6 });
    expect(w.attributes("style")).toContain("--field-ch: 6");
  });
});

describe("NumberField expressions", () => {
  // A feature row: a plain number is in the row's unit, anything the grammar leaves to the parameter engine is text.
  const parse = (raw: string, unit: Parameters<NonNullable<Props["parse"]>>[1]) => {
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(n)) return n * (unit?.factor ?? 1);
    if (/^[a-z]/i.test(raw.trim())) return null;
    throw new Error("not a value");
  };

  it("hands text the parse returns null for to expression, trimmed, and keeps its refusal", async () => {
    const seen: string[] = [];
    const expression = (raw: string) => (seen.push(raw), raw === "nope" ? "unknown parameter" : null);
    const { w, input, el } = await render({ parse, expression, unit: "mm" });
    await commit(input, " width/2 ");
    expect([seen, emitted(w)]).toEqual([["width/2"], []]);
    await commit(input, "nope");
    expect([el.value, input.attributes("aria-invalid"), input.attributes("title")]).toEqual([
      "nope",
      "true",
      "unknown parameter",
    ]);
  });

  it("without expression, a null parse is refused as not a number", async () => {
    const { w, input } = await render({ parse });
    await commit(input, "width");
    expect([emitted(w), input.attributes("aria-invalid")]).toEqual([[], "true"]);
  });

  it("never previews an expression", async () => {
    const preview = vi.fn();
    const { input } = await render({ parse, expression: () => null, preview });
    vi.useFakeTimers();
    await input.setValue("width");
    vi.advanceTimersByTime(300);
    expect(preview).not.toHaveBeenCalled();
    await input.setValue("4");
    vi.advanceTimersByTime(300);
    expect(preview.mock.calls).toEqual([[4]]);
  });

  it("shows text in place of the model, does not step it, and commits a number equal to the model", async () => {
    const { w, input, el } = await render({ parse, expression: () => null, modelValue: 10, text: "w/4" });
    expect(el.value).toBe("w/4");
    const up = new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true });
    el.dispatchEvent(up);
    expect([el.value, up.defaultPrevented]).toEqual(["w/4", false]);
    await commit(input, "10");
    expect(emitted(w)).toEqual([[10]]);
  });

  it("follows an expression that lands after the commit while still focused", async () => {
    // A parameter commit resolves on a promise chain frames after Enter.
    const { w, input, el } = await render({ parse, expression: () => null, modelValue: 10 });
    el.focus();
    await commit(input, "w/4");
    await w.setProps({ text: "w/4", modelValue: null });
    expect([el.value, document.activeElement]).toEqual(["w/4", el]);
  });

  it("shows a refused value, then the rebuilt one once the owner answers", async () => {
    const { w, input, el } = await render({
      parse,
      expression: () => null,
      validate: (v: number) => (v < 0 ? "too small" : null),
    });
    el.focus();
    await commit(input, "-2");
    expect([el.value, input.attributes("title")]).toEqual(["-2", "too small"]);
    await commit(input, "6");
    await w.setProps({ modelValue: 6.5 });
    expect([el.value, input.attributes("aria-invalid")]).toEqual(["6.5", undefined]);
  });

  it("emits the reason it refuses its text, and null once it no longer does", async () => {
    const { w, input } = await render({ parse });
    await commit(input, "2 +");
    await input.setValue("3");
    expect(w.emitted("error")).toEqual([["not a value"], [null]]);
  });

  it("adopts a unit written in the committed text, and only of its own kind", async () => {
    const a = await render({ unit: "mm", adoptUnit: true });
    await commit(a.input, "2 in");
    expect([emitted(a.w)[0]![0], a.w.emitted("update:unit")]).toEqual([50.8, [["in"]]]);
    await commit(a.input, "3");
    expect(a.w.emitted("update:unit")).toHaveLength(1);
    const b = await render({ unit: "deg", adoptUnit: true });
    await commit(b.input, "5 in");
    expect(b.w.emitted("update:unit")).toBeUndefined();
    const c = await render({ unit: "mm" });
    await commit(c.input, "2 in");
    expect(c.w.emitted("update:unit")).toBeUndefined();
  });

  it("gives the unit chip its title", async () => {
    const { w } = await render({ unit: "mm", unitTip: "Expressions are written in this unit" });
    expect(w.get(".ui-unit-chip").attributes("title")).toBe("Expressions are written in this unit");
  });

  it("commits text that differs from what it showed even at the model's value, like a native change", async () => {
    const { w, input, el } = await render({ modelValue: 20 });
    el.focus();
    await commit(input, "20.0");
    await commit(input, "20");
    await input.setValue("2 cm");
    await input.trigger("blur");
    expect(emitted(w)).toEqual([[20], [20]]);
  });

  it("commits a previewed value though its owner shows the preview as the model", async () => {
    // The feature rows read the live feature, so an open preview is what the field is handed as its model.
    const owner: { w?: Awaited<ReturnType<typeof render>>["w"] } = {};
    const previewEnd = vi.fn();
    const preview = (v: number | null) => void owner.w!.setProps({ modelValue: v });
    const { w, input, el } = await render({ modelValue: 20, preview, previewEnd });
    owner.w = w;
    el.focus();
    vi.useFakeTimers();
    await input.setValue("30");
    await vi.advanceTimersByTimeAsync(200);
    expect(w.props("modelValue")).toBe(30);
    await input.trigger("keydown", { key: "Enter" });
    expect([emitted(w), previewEnd.mock.calls]).toEqual([[[30]], [[true]]]);

    await w.setProps({ modelValue: 20 });
    await input.setValue("21");
    await vi.advanceTimersByTimeAsync(200);
    await input.trigger("blur");
    expect([emitted(w), previewEnd.mock.calls]).toEqual([
      [[30], [21]],
      [[true], [true]],
    ]);
  });

  it("ends a preview as not committing when a blank required field commits nothing", async () => {
    const preview = vi.fn();
    const previewEnd = vi.fn();
    const { w, input, el } = await render({ modelValue: 20, preview, previewEnd });
    el.focus();
    vi.useFakeTimers();
    await input.setValue("30");
    await vi.advanceTimersByTimeAsync(200);
    await commit(input, "");
    await w.vm.$nextTick();
    expect([emitted(w), previewEnd.mock.calls, el.value]).toEqual([[], [[false]], "20"]);
  });

  it("ends a preview as not committing when the text it showed comes back unchanged", async () => {
    const preview = vi.fn();
    const previewEnd = vi.fn();
    const { w, input, el } = await render({ modelValue: 20, preview, previewEnd });
    el.focus();
    vi.useFakeTimers();
    await input.setValue("2");
    await vi.advanceTimersByTimeAsync(200);
    await commit(input, "20");
    expect([emitted(w), previewEnd.mock.calls]).toEqual([[], [[false]]]);
  });

  it("commits nothing when the text it showed comes back after its owner made a preview the model", async () => {
    const owner: { w?: Awaited<ReturnType<typeof render>>["w"] } = {};
    const preview = (v: number | null) => void owner.w!.setProps({ modelValue: v });
    const previewEnd = vi.fn(() => void owner.w!.setProps({ modelValue: 20 }));
    const { w, input, el } = await render({ modelValue: 20, preview, previewEnd });
    owner.w = w;
    el.focus();
    vi.useFakeTimers();
    await input.setValue("30");
    await vi.advanceTimersByTimeAsync(200);
    await commit(input, " 20 ");
    await vi.advanceTimersByTimeAsync(0);
    expect([emitted(w), previewEnd.mock.calls, el.value]).toEqual([[], [[false]], "20"]);
  });

  it("commits nothing when the expression it showed is typed back", async () => {
    const parse = (raw: string) => (/^[a-z]/i.test(raw.trim()) ? null : Number(raw));
    const seen: string[] = [];
    const expression = (raw: string) => (seen.push(raw), null);
    const { w, input, el } = await render({ parse, expression, modelValue: 10, text: "w/4" });
    el.focus();
    await input.setValue("w/");
    await commit(input, "w/4 ");
    await w.vm.$nextTick();
    expect([seen, emitted(w), el.value]).toEqual([[], [], "w/4"]);
  });
});

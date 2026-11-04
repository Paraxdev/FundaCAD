import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { enableAutoUnmount, mount, type DOMWrapper } from "@vue/test-utils";

vi.mock("../../../src/ui/announce", () => ({ announce: vi.fn() }));

import NumberField from "../../../src/components/ui/NumberField.vue";
import { announce } from "../../../src/ui/announce";
import { measureError, unitById } from "../../../src/ui/measure";
import { resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";

enableAutoUnmount(afterEach);
afterEach(() => vi.useRealTimers());
beforeEach(() => vi.mocked(announce).mockClear());

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

describe("NumberField limits", () => {
  it("with arrows commits typed text past min and max, unrefused", async () => {
    const { w, input } = await render({ min: 0, max: 10, limits: "arrows" });
    await commit(input, "-1");
    await commit(input, "11");
    expect(emitted(w)).toEqual([[-1], [11]]);
    expect(input.attributes("aria-invalid")).toBeUndefined();
  });

  it("with arrows still holds the arrow keys inside min and max", async () => {
    const top = await render({ modelValue: 10, min: 0, max: 10, limits: "arrows" });
    await top.input.trigger("keydown", { key: "ArrowUp" });
    expect(top.el.value).toBe("10");
    const bottom = await render({ modelValue: 0, min: 0, max: 10, limits: "arrows" });
    await bottom.input.trigger("keydown", { key: "ArrowDown" });
    expect(bottom.el.value).toBe("0");
  });

  it("refuses by default, and still judges a validate with arrows", async () => {
    const plain = await render({ min: 0 });
    await commit(plain.input, "-1");
    expect(emitted(plain.w)).toEqual([]);
    const judged = await render({ min: 0, limits: "arrows", validate: () => "No" });
    await commit(judged.input, "-1");
    expect(emitted(judged.w)).toEqual([]);
    expect(judged.input.attributes("title")).toBe("No");
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

describe("NumberField unit description", () => {
  const described = (el: HTMLInputElement) =>
    (el.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "?");

  it.each([
    ["mm", "millimetres"],
    ["in", "inches"],
    ["deg", "degrees"],
    ["MPa", "megapascals"],
    ["g/cm³", "grams per cubic centimetre"],
    ["samples", "samples"],
  ])("describes unit %s as %s", async (unit, word) => {
    const { el, w } = await render({ unit, modelValue: 12.5 });
    expect(described(el)).toEqual([word]);
    const span = w.get(".sr-only");
    expect(span.element.parentElement).toBe(w.element);
  });

  it("describes a unit of 1 or 0 as the plural too, as it names the unit and not an amount", async () => {
    for (const modelValue of [0, 1, 37.5]) {
      const { el } = await render({ unit: "mm", modelValue });
      expect(described(el)).toEqual(["millimetres"]);
    }
  });

  it.each([{}, { unit: null }, { unit: undefined }, { unit: "" }])(
    "has no span and no describedby for %o",
    async (p) => {
      const { el, w } = await render(p);
      expect([el.hasAttribute("aria-describedby"), w.findAll(".sr-only").length]).toEqual([false, 0]);
    },
  );

  it("keeps a caller's aria-describedby after the unit", async () => {
    const hint = document.createElement("div");
    hint.id = "hint-7";
    hint.textContent = "Across the flats";
    document.body.append(hint);
    try {
      const { el } = await render({ unit: "mm", "aria-describedby": "hint-7" });
      expect(described(el)).toEqual(["millimetres", "Across the flats"]);
      const bare = await render({ "aria-describedby": "hint-7" });
      expect(described(bare.el)).toEqual(["Across the flats"]);
    } finally {
      hint.remove();
    }
  });

  it("follows a unit changed from outside, and the span goes with the unit", async () => {
    const { el, w } = await render({ unit: "mm", units: ["mm", "in"] });
    await w.setProps({ unit: "in" });
    expect(described(el)).toEqual(["inches"]);
    await w.setProps({ unit: null });
    expect([el.hasAttribute("aria-describedby"), w.findAll(".sr-only").length]).toEqual([false, 0]);
  });

  it("gives each field its own unit span id", async () => {
    const Pair = defineComponent({
      render: () => [
        h(NumberField, { modelValue: 1, label: "A", unit: "mm" }),
        h(NumberField, { modelValue: 2, label: "B", unit: "deg" }),
        h(NumberField, { modelValue: 3, label: "C", unit: "mm" }),
      ],
    });
    const w = mount(Pair, { attachTo: document.body });
    const inputs = w.findAll("input").map((i) => i.element as HTMLInputElement);
    const ids = inputs.map((e) => e.getAttribute("aria-describedby"));
    expect([new Set(ids).size, inputs.map(described)]).toEqual([3, [["millimetres"], ["degrees"], ["millimetres"]]]);
  });

  it("reads mm and deg when Units spoken in full is off, and the words again once it is on", async () => {
    const Trio = defineComponent({
      props: { late: Boolean },
      render: (p: { late: boolean }) => [
        h(NumberField, { modelValue: 7.5, label: "A", unit: "mm" }),
        h(NumberField, { modelValue: 33, label: "B", unit: "deg" }),
        h(NumberField, { modelValue: 3, label: "C", unit: "samples" }),
        ...(p.late ? [h(NumberField, { modelValue: 9, label: "D", unit: "mm" })] : []),
      ],
    });
    try {
      setA11yPref("unitsInFull", false);
      const w = mount(Trio, { attachTo: document.body });
      const read = () => w.findAll("input").map((i) => described(i.element as HTMLInputElement));
      expect(read()).toEqual([["mm"], ["deg"], ["samples"]]);
      setA11yPref("unitsInFull", true);
      await w.setProps({ late: true });
      expect(read()).toEqual([["millimetres"], ["degrees"], ["samples"], ["millimetres"]]);
    } finally {
      resetA11yPrefs();
    }
  });

  it("hides the unit caption from browse mode, but never a unit picker", async () => {
    const caption = await render({ unit: "mm" });
    expect(caption.w.get(".ui-unit-chip").attributes("aria-hidden")).toBe("true");
    const picker = await render({ unit: "mm", units: ["mm", "in"] });
    expect(picker.w.get(".ui-unit-chip").attributes("aria-hidden")).toBeUndefined();
  });
});

describe("NumberField refusal", () => {
  const described = (el: HTMLInputElement) =>
    (el.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "?");
  const spoken = () => vi.mocked(announce).mock.calls;

  it("describes a refused value on the field after its unit, and drops it once the text is fixed", async () => {
    const { el, input } = await render({ unit: "mm", min: 2.5, modelValue: 7 });
    await commit(input, "1.75");
    expect(el.getAttribute("aria-invalid")).toBe("true");
    expect(described(el)).toEqual(["millimetres", "At least 2.5 mm"]);
    await input.setValue("3.5");
    expect(el.getAttribute("aria-invalid")).toBeNull();
    expect(described(el)).toEqual(["millimetres"]);
    expect(el.getAttribute("aria-describedby")).not.toContain("error");
  });

  it("describes a reason that came from outside the same way, and a caller's ids come last", async () => {
    const { w, el } = await render({ unit: "deg", modelValue: 33, "aria-describedby": "hint-a hint-b" });
    expect(described(el)).toEqual(["degrees", "?", "?"]);
    await w.setProps({ problem: "Cannot cut that deep" });
    expect(el.getAttribute("aria-describedby")?.split(" ").slice(2)).toEqual(["hint-a", "hint-b"]);
    expect(described(el).slice(0, 2)).toEqual(["degrees", "Cannot cut that deep"]);
    await w.setProps({ problem: null });
    expect(el.getAttribute("aria-describedby")).toMatch(/^\S+-unit hint-a hint-b$/);
  });

  it("describes a refusal on a field with no unit as the only description", async () => {
    const { el, input } = await render({ min: 2, modelValue: 6 });
    expect(el.getAttribute("aria-describedby")).toBeNull();
    await commit(input, "1");
    expect(described(el)).toEqual(["At least 2"]);
  });

  it("gives each field in one app its own error id", async () => {
    const Two = defineComponent({
      render: () => [
        h(NumberField, { modelValue: 6, label: "A", min: 2, class: "a" }),
        h(NumberField, { modelValue: 9, label: "B", min: 3, class: "b" }),
      ],
    });
    const w = mount(Two, { attachTo: document.body });
    await new Promise((r) => setTimeout(r, 2));
    const [a, b] = w.findAll("input") as [DOMWrapper<HTMLInputElement>, DOMWrapper<HTMLInputElement>];
    await commit(a, "1");
    await commit(b, "2");
    const els = [a.element, b.element] as const;
    expect(els[0].getAttribute("aria-describedby")).not.toBe(els[1].getAttribute("aria-describedby"));
    expect(els.map(described)).toEqual([["At least 2"], ["At least 3"]]);
  });

  it("speaks a refusal once on Enter, without the name while the field has focus", async () => {
    const { el, input } = await render({ unit: "mm", min: 2.5, modelValue: 7, label: "Width" });
    el.focus();
    await commit(input, "1.75");
    expect(spoken()).toEqual([["At least 2.5 mm", "assertive"]]);
    await input.trigger("keydown", { key: "Enter" });
    expect(spoken()).toHaveLength(1);
  });

  it("speaks again for a new refusal after a valid commit, and each time the text is typed again", async () => {
    const { el, input } = await render({ min: 2, modelValue: 7, label: "Width" });
    el.focus();
    expect(spoken()).toHaveLength(0);
    await commit(input, "1");
    expect(spoken()).toHaveLength(1);
    await commit(input, "5");
    expect(spoken()).toHaveLength(1);
    await commit(input, "0.5");
    expect(spoken()).toHaveLength(2);
    await commit(input, "0.25");
    expect(spoken()).toHaveLength(3);
  });

  it("names the field when a blur commits the refusal with focus elsewhere", async () => {
    const { input } = await render({ unit: "mm", min: 2.5, modelValue: 7, label: "Width" });
    await input.setValue("1.75");
    await input.trigger("blur");
    expect(spoken()).toEqual([["Width, At least 2.5 mm", "assertive"]]);
  });

  it("names the field from the text of its labelledby ids", async () => {
    const lab = document.createElement("span");
    lab.id = "w-lab";
    lab.textContent = "Wall thickness";
    document.body.append(lab);
    const { input } = await render({ label: undefined, labelledby: "w-lab", min: 2, modelValue: 7 });
    await input.setValue("1");
    await input.trigger("blur");
    lab.remove();
    expect(spoken()).toEqual([["Wall thickness, At least 2", "assertive"]]);
  });

  it("speaks a reason from outside once, and again after it was withdrawn", async () => {
    const { w } = await render({ modelValue: 4 });
    await w.setProps({ problem: "Cannot cut that deep" });
    await w.setProps({ problem: "Cannot cut that deep, 2" });
    expect(spoken()).toEqual([["Depth, Cannot cut that deep", "assertive"]]);
    await w.setProps({ problem: null });
    await w.setProps({ problem: "Too thin" });
    expect(spoken()).toHaveLength(2);
  });

  describe("in live mode", () => {
    async function live() {
      const r = await render({ commit: "live", unit: "mm", min: 2.5, max: 100, modelValue: 7, label: "Width" });
      r.el.focus();
      vi.useFakeTimers();
      return r;
    }

    it("speaks nothing for text that is fixed inside the pause", async () => {
      const { input } = await live();
      await input.setValue("1");
      vi.advanceTimersByTime(699);
      await input.setValue("12");
      vi.advanceTimersByTime(5000);
      expect(spoken()).toEqual([]);
    });

    it("speaks the reason once the pause ends, not a moment before", async () => {
      const { input } = await live();
      await input.setValue("1");
      vi.advanceTimersByTime(699);
      expect(spoken()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(spoken()).toEqual([["At least 2.5 mm", "assertive"]]);
      vi.advanceTimersByTime(5000);
      expect(spoken()).toHaveLength(1);
    });

    it("says the reason current when the pause ends and not again for a changed reason", async () => {
      const { input } = await live();
      await input.setValue("1");
      vi.advanceTimersByTime(300);
      await input.setValue("200");
      vi.advanceTimersByTime(399);
      expect(spoken()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(spoken()).toEqual([["At most 100 mm", "assertive"]]);
      await input.setValue("300");
      vi.advanceTimersByTime(5000);
      expect(spoken()).toHaveLength(1);
    });

    it("speaks nothing when the field goes away inside the pause", async () => {
      const { w, input } = await live();
      await input.setValue("1");
      vi.advanceTimersByTime(400);
      w.unmount();
      vi.advanceTimersByTime(5000);
      expect(spoken()).toEqual([]);
    });
  });
});

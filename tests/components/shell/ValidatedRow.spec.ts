// The other half of what keystrokeGuard used to do.
//
// Vue's keyed patching stops the <input> being destroyed mid-edit, but a value
// binding still re-fires when the document changes, which clobbers uncommitted
// keystrokes just as thoroughly. Parameter commits land asynchronously on a
// promise chain in the store, so an update arriving mid-typing is routine, not
// hypothetical. NumberField's focus guard (useCommitField) is what survives it.

import { afterEach, describe, it, expect, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ValidatedRow from "../../../src/components/shell/ValidatedRow.vue";
import type { UnitDef } from "../../../src/ui/measure";

enableAutoUnmount(afterEach);
afterEach(() => vi.useRealTimers());

/** A plain number in the shown unit, a word is an expression, anything else is refused. */
function parse(raw: string, unit: UnitDef | null): number | null {
  const n = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(n)) return n * (unit?.factor ?? 1);
  if (/^[a-z]/i.test(raw.trim())) return null;
  throw new Error("not a value");
}

function mountRow(
  opts: {
    value?: number | null;
    text?: string | null;
    expression?: (raw: string) => string | null;
    validate?: (v: number) => string | null;
    unit?: string;
    units?: string[];
    preview?: (v: number | null) => void;
    previewEnd?: (committing: boolean) => void;
    problem?: string | null;
  } = {},
) {
  return mount(ValidatedRow, {
    props: {
      label: "Width",
      value: opts.value === undefined ? 10 : opts.value,
      parse,
      expression: opts.expression ?? (() => null),
      ...(opts.text === undefined ? {} : { text: opts.text }),
      ...(opts.validate === undefined ? {} : { validate: opts.validate }),
      ...(opts.unit === undefined ? {} : { unit: opts.unit }),
      ...(opts.units === undefined ? {} : { units: opts.units }),
      ...(opts.preview === undefined ? {} : { preview: opts.preview }),
      ...(opts.previewEnd === undefined ? {} : { previewEnd: opts.previewEnd }),
      ...(opts.problem === undefined ? {} : { problem: opts.problem }),
    },
    attachTo: document.body, // focus/activeElement only behave when attached
  });
}

/** Type into the field WITHOUT committing. Enter or blur is the commit, that is the distinction these tests are
 *  about, so they draw it by hand. */
async function type(w: ReturnType<typeof mountRow>, text: string) {
  const input = w.get("input");
  input.element.focus();
  input.element.value = text;
  await input.trigger("input");
  return input;
}

const commits = (w: ReturnType<typeof mountRow>) => w.emitted<[number]>("commit")?.map((e) => e[0]) ?? [];

describe("ValidatedRow", () => {
  it("tracks the source value while NOT focused", async () => {
    const w = mountRow({ value: 10 });
    expect(w.get("input").element.value).toBe("10");

    await w.setProps({ value: 25 });
    expect(w.get("input").element.value).toBe("25");
  });

  it("keeps uncommitted keystrokes when a background update lands mid-edit", async () => {
    const w = mountRow({ value: 10 });
    const input = await type(w, "123");

    // An async param commit from elsewhere rewrites the bound value.
    await w.setProps({ value: 99 });

    expect(input.element.value).toBe("123");
  });

  it("commits the typed value on Enter and on blur, not on every keystroke", async () => {
    const w = mountRow({ value: 10 });
    const input = await type(w, "42");

    expect(commits(w)).toEqual([]); // typing alone must not touch the store
    await input.trigger("keydown", { key: "Enter" });
    expect(commits(w)).toEqual([42]);
    await w.setProps({ value: 42 });
    await type(w, "43");
    await input.trigger("blur");
    expect(commits(w)).toEqual([42, 43]);
  });

  it("re-syncs from the source after a successful commit", async () => {
    // The panel may legitimately re-spell what was sent (canonical rounding, an
    // fx badge), so a success must re-read rather than keep the typed text.
    const w = mountRow({ value: 10 });
    const input = await type(w, "7");

    await w.setProps({ value: 7.001 }); // the store's canonical spelling
    expect(input.element.value).toBe("7"); // still mid-edit, draft is preferred

    await input.trigger("keydown", { key: "Enter" });
    await w.vm.$nextTick();
    expect(input.element.value).toBe("7.001");
  });

  it("follows an expression commit that lands after Enter", async () => {
    // A parameter expression is queued on a promise chain in the store and
    // arrives several frames after Enter, while the field still has focus.
    // Skipping that answer left the field showing its pre-edit number and the
    // edit looked like it had done nothing at all.
    const seen: string[] = [];
    const w = mountRow({ value: 10, expression: (raw) => (seen.push(raw), null) });
    const input = await type(w, "w");
    await input.trigger("keydown", { key: "Enter" });
    expect(seen).toEqual(["w"]);

    await w.setProps({ value: null, text: "w" }); // the queued commit lands
    expect(input.element.value).toBe("w");
    expect(document.activeElement).toBe(input.element); // still mid-edit
  });

  it("stops following a late commit once the user types again", async () => {
    const w = mountRow({ value: 10 });
    const input = await type(w, "7");
    await input.trigger("keydown", { key: "Enter" });
    await type(w, "8"); // moved on: this is preferred over the previous edit's answer

    await w.setProps({ value: 7 });
    expect(input.element.value).toBe("8");
  });

  it("keeps the rejected text and flags the error when a commit fails", async () => {
    const w = mountRow({ value: 10, expression: () => "unknown parameter" });
    const input = await type(w, "widht");
    await input.trigger("keydown", { key: "Enter" });

    // The user has to be able to see and fix what they typed.
    expect(input.element.value).toBe("widht");
    expect(input.attributes("aria-invalid")).toBe("true");
    expect(input.attributes("title")).toBe("unknown parameter");
    expect(w.get(".param-problem").text()).toBe("unknown parameter");
  });

  it("shows a refused value, then the rebuilt one", async () => {
    const w = mountRow({ value: 10, validate: (v) => (v < 0 ? "Width must be more than 0" : null) });
    const input = await type(w, "-2");
    await input.trigger("keydown", { key: "Enter" });
    expect([input.element.value, w.get(".param-problem").text(), commits(w)]).toEqual([
      "-2",
      "Width must be more than 0",
      [],
    ]);
    await type(w, "12");
    await input.trigger("keydown", { key: "Enter" });
    await w.setProps({ value: 12.5 }); // the rebuild answers with its own value
    expect([input.element.value, w.find(".param-problem").exists(), commits(w)]).toEqual(["12.5", false, [12]]);
  });

  it("clears the error as soon as the user types again", async () => {
    const w = mountRow({ value: 10, expression: () => "nope" });
    const input = await type(w, "bad");
    await input.trigger("keydown", { key: "Enter" });
    expect(input.attributes("aria-invalid")).toBe("true");

    await type(w, "bad2");
    expect(input.attributes("aria-invalid")).toBeUndefined();
    expect(w.find(".param-problem").exists()).toBe(false);
  });

  it("previews while typing and ends the preview on Escape and on unmount", async () => {
    const preview = vi.fn();
    const previewEnd = vi.fn();
    const w = mountRow({ value: 10, preview, previewEnd });
    vi.useFakeTimers();
    const input = await type(w, "12");
    vi.advanceTimersByTime(200);
    expect(preview.mock.calls).toEqual([[12]]);
    await input.trigger("keydown", { key: "Escape" });
    expect([previewEnd.mock.calls, input.element.value]).toEqual([[[false]], "10"]);
    await type(w, "13");
    vi.advanceTimersByTime(200);
    w.unmount();
    expect(previewEnd.mock.calls).toEqual([[false], [false]]);
  });

  it("shows the kernel's refusal of a preview under the row and on the field", () => {
    const w = mountRow({ value: 10, problem: "The fillet is larger than the edge" });
    expect(w.get(".param-problem").text()).toBe("The fillet is larger than the edge");
    expect(w.get(".ui-field").classes()).toContain("is-error");
  });

  // --- the unit chip ---
  // The unit used to be appended to the LABEL, which produced rows reading
  // "Radius mm | 5in": a label is a name, and a unit is part of the value.

  it("puts the unit beside the value rather than in the label", () => {
    const w = mountRow({ value: 5, unit: "mm", units: ["mm", "in"] });
    expect(w.get("label").text()).toBe("Width");
    expect(w.get(".ui-unit-chip").text()).toBe("mm");
  });

  it("offers the units as a picker titled Change unit, and reports the pick", async () => {
    const w = mountRow({ value: 5, unit: "mm", units: ["mm", "in"] });
    const chip = w.get(".ui-unit-chip");
    expect([chip.attributes("role"), chip.attributes("title")]).toEqual(["combobox", "Change unit"]);
    await chip.trigger("keydown", { key: "ArrowDown" });
    await chip.trigger("keydown", { key: "End" });
    await chip.trigger("keydown", { key: "Enter" });
    expect(w.emitted("update:unit")).toEqual([["in"]]);
  });

  it("adopts a unit the user wrote", async () => {
    const w = mount(ValidatedRow, {
      props: { label: "Width", value: 10, unit: "mm", units: ["mm", "in"], parse: () => 127 },
      attachTo: document.body,
    });
    const input = w.get("input");
    input.element.value = "5in";
    await input.trigger("input");
    await input.trigger("keydown", { key: "Enter" });
    expect(w.emitted("update:unit")).toEqual([["in"]]);
  });

  it("makes the chip a caption when the unit cannot be changed", () => {
    // An expression is written in canonical units, so there is nothing to pick:
    // the chip states the unit instead of offering it.
    const w = mountRow({ value: null, text: "20+5", unit: "mm" });
    const chip = w.get(".ui-unit-chip");
    expect([chip.element.tagName, chip.attributes("title")]).toEqual(["SPAN", "Expressions are written in this unit"]);
  });

  it("renders no chip at all for a unitless value", () => {
    // A fillet's conic profile is a ratio; a blank chip would claim otherwise.
    const w = mountRow({ value: 0.5 });
    expect(w.find(".ui-unit-chip").exists()).toBe(false);
  });
});

describe("ValidatedRow name", () => {
  it("names its input with the row label, and its hint is the title", () => {
    const w = mount(ValidatedRow, { props: { label: "Width", value: 5, parse, hint: "a value with any unit" } });
    expect([w.get("input").attributes("aria-label"), w.get("input").attributes("title")]).toEqual([
      "Width",
      "a value with any unit",
    ]);
  });

  it("carries its field key", () => {
    const w = mount(ValidatedRow, { props: { label: "Width", field: "width", value: 5, parse } });
    expect(w.get(".param-row").attributes("data-field")).toBe("width");
  });
});

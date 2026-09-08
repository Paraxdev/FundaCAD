// The other half of what keystrokeGuard used to do.
//
// Vue's keyed patching stops the <input> being destroyed mid-edit, but a value
// binding still re-fires when the document changes, which clobbers uncommitted
// keystrokes just as thoroughly. Parameter commits land asynchronously on a
// promise chain in the store, so an update arriving mid-typing is routine, not
// hypothetical. useDraft's focus guard is what survives it.

import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ValidatedRow from "../../../src/components/shell/ValidatedRow.vue";

function mountRow(opts: {
  value: string;
  commit?: (raw: string) => string | null;
  unit?: string;
  pickUnit?: (x: number, y: number) => void;
}) {
  return mount(ValidatedRow, {
    props: {
      label: "Width",
      value: opts.value,
      commit: opts.commit ?? (() => null),
      ...(opts.unit === undefined ? {} : { unit: opts.unit }),
      ...(opts.pickUnit === undefined ? {} : { pickUnit: opts.pickUnit }),
    },
    attachTo: document.body, // focus/activeElement only behave when attached
  });
}

/** Type into the field WITHOUT committing.
 *
 *  Deliberately not wrapper.setValue(): that fires `input` AND `change` (it
 *  supports v-model.lazy), so it would commit on every simulated keystroke and
 *  quietly invalidate every mid-edit assertion below. Committing is `change`,
 *  which is the blur/Enter moment, that is the distinction these tests are
 *  about, so they draw it by hand. */
async function type(w: ReturnType<typeof mountRow>, text: string) {
  const input = w.get("input");
  input.element.focus();
  input.element.value = text;
  await input.trigger("input");
  return input;
}

describe("ValidatedRow", () => {
  it("tracks the source value while NOT focused", async () => {
    const w = mountRow({ value: "10" });
    expect(w.get("input").element.value).toBe("10");

    await w.setProps({ value: "25" });
    expect(w.get("input").element.value).toBe("25");
  });

  it("keeps uncommitted keystrokes when a background update lands mid-edit", async () => {
    const w = mountRow({ value: "10" });
    const input = await type(w, "123");

    // An async param commit from elsewhere rewrites the bound value. Before
    // useDraft this wiped the field under the user's cursor.
    await w.setProps({ value: "99" });

    expect(input.element.value).toBe("123");
  });

  it("commits the typed text on change, not on every keystroke", async () => {
    const seen: string[] = [];
    const w = mountRow({ value: "10", commit: (raw) => { seen.push(raw); return null; } });
    const input = await type(w, "42");

    expect(seen).toEqual([]); // typing alone must not touch the store
    await input.trigger("change");
    expect(seen).toEqual(["42"]);
  });

  it("re-syncs from the source after a successful commit", async () => {
    // The panel may legitimately re-spell what was sent (canonical rounding, an
    // fx badge), so a success must re-read rather than keep the typed text.
    const w = mountRow({ value: "10", commit: () => null });
    const input = await type(w, "7");

    await w.setProps({ value: "7.00" }); // the store's canonical spelling
    expect(input.element.value).toBe("7"); // still mid-edit, draft wins

    await input.trigger("change");
    expect(input.element.value).toBe("7.00");
  });

  it("follows a commit that lands after the change event", async () => {
    // Not every commit is synchronous: a parameter expression is queued on a
    // promise chain in the store and arrives several frames after `change`,
    // while the field still has focus. The focus guard is right for an edit
    // landing from somewhere else and wrong for the answer to this one, so
    // skipping it left the field showing its pre-edit number and the edit
    // looked like it had done nothing at all.
    const w = mountRow({ value: "10", commit: () => null });
    const input = await type(w, "20+5");
    await input.trigger("change");

    await w.setProps({ value: "20+5" }); // the queued commit lands
    expect(input.element.value).toBe("20+5");
    expect(document.activeElement).toBe(input.element); // still mid-edit
  });

  it("stops following a late commit once the user types again", async () => {
    const w = mountRow({ value: "10", commit: () => null });
    const input = await type(w, "7");
    await input.trigger("change");
    await type(w, "8"); // moved on: this outranks the previous edit's answer

    await w.setProps({ value: "7" });
    expect(input.element.value).toBe("8");
  });

  it("keeps the rejected text and flags the error when a commit fails", async () => {
    const w = mountRow({ value: "10", commit: () => "unknown parameter" });
    const input = await type(w, "widht/2");
    await input.trigger("change");

    // The user has to be able to see and fix what they typed.
    expect(input.element.value).toBe("widht/2");
    expect(input.classes()).toContain("input-error");
    expect(input.attributes("title")).toBe("unknown parameter");
  });

  it("clears the error as soon as the user types again", async () => {
    const w = mountRow({ value: "10", commit: () => "nope" });
    const input = await type(w, "bad");
    await input.trigger("change");
    expect(input.classes()).toContain("input-error");

    await type(w, "bad2");
    expect(input.classes()).not.toContain("input-error");
  });

  // --- the unit chip ---
  // The unit used to be appended to the LABEL, which produced rows reading
  // "Radius mm | 5in": a label is a name, and a unit is part of the value.

  it("puts the unit beside the value rather than in the label", () => {
    const w = mountRow({ value: "5", unit: "mm", pickUnit: () => {} });
    expect(w.get("label").text()).toBe("Width");
    expect(w.get(".dim-unit").text()).toBe("mm");
  });

  it("opens the picker under the chip", async () => {
    const at: [number, number][] = [];
    const w = mountRow({ value: "5", unit: "mm", pickUnit: (x, y) => at.push([x, y]) });
    await w.get(".dim-unit").trigger("click");
    // happy-dom has no layout, so the rect is zeroes; what is pinned here is
    // that the chip reports a position at all rather than the caller guessing.
    expect(at).toHaveLength(1);
  });

  it("makes the chip a caption when the unit cannot be changed", () => {
    // An expression is written in canonical units, so there is nothing to pick:
    // the chip states the unit instead of offering it.
    const w = mountRow({ value: "20+5", unit: "mm" });
    expect(w.find("button.dim-unit").exists()).toBe(false);
    expect(w.get("span.dim-unit").classes()).toContain("static");
  });

  it("renders no chip at all for a unitless value", () => {
    // A fillet's conic profile is a ratio; a blank chip would claim otherwise.
    const w = mountRow({ value: "0.5" });
    expect(w.find(".dim-unit").exists()).toBe(false);
  });
});

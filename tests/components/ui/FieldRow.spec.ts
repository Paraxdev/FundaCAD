import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h } from "vue";

import FieldRow from "../../../src/components/ui/FieldRow.vue";

enableAutoUnmount(afterEach);

type Slot = {
  id: string;
  labelId: string;
  describedby: string | undefined;
  errorId: string | undefined;
  invalid: boolean;
};

function render(props: Record<string, unknown>) {
  return mount(FieldRow, {
    props: { label: "Radius", ...props },
    slots: {
      default: (s: Slot) =>
        h("input", { id: s.id, "aria-describedby": s.describedby, "aria-invalid": s.invalid || undefined }),
    },
  });
}

describe("FieldRow", () => {
  it("wires the label to the control through a generated id", () => {
    const w = render({});
    const id = w.find("input").attributes("id");
    expect(id).toBeTruthy();
    expect(w.find("label").attributes("for")).toBe(id);
    expect(w.find("label").text()).toBe("Radius");
  });

  it("hands the slot its label's id, for a control named by aria-labelledby", () => {
    const w = mount(FieldRow, {
      props: { label: "Kind" },
      slots: { default: (s: Slot) => h("button", { "aria-labelledby": s.labelId }) },
    });
    const id = w.find("label").attributes("id");
    expect(id).toBeTruthy();
    expect(w.find("button").attributes("aria-labelledby")).toBe(id);
  });

  it("takes the caller's id through for", () => {
    const w = render({ for: "radius-in" });
    expect([w.find("label").attributes("for"), w.find("input").attributes("id")]).toEqual(["radius-in", "radius-in"]);
  });

  it("gives two rows of one form different ids", () => {
    const row = () => h(FieldRow, { label: "R" }, { default: (s: Slot) => h("input", { id: s.id }) });
    const w = mount({ render: () => h("form", [row(), row()]) });
    const [a, b] = w.findAll("input").map((i) => i.attributes("id"));
    expect(a).not.toBe(b);
    expect(w.findAll("label").map((l) => l.attributes("for"))).toEqual([a, b]);
  });

  it("describes the control by its hint alone, and the error line replaces the hint and hides from browse mode", async () => {
    const w = render({ hint: "From the sketch plane" });
    const hint = w.find(".ui-field-hint");
    expect(w.find("input").attributes("aria-describedby")).toBe(hint.attributes("id"));
    expect(hint.text()).toBe("From the sketch plane");
    expect(hint.attributes("aria-hidden")).toBeUndefined();
    await w.setProps({ error: "Must be above 0" });
    expect([
      w.find(".ui-field-hint").text(),
      w.find(".ui-field-hint").attributes("aria-hidden"),
      w.classes("is-error"),
      w.find("input").attributes("aria-invalid"),
      w.find("input").attributes("aria-describedby"),
    ]).toEqual(["Must be above 0", "true", true, "true", undefined]);
    await w.setProps({ error: undefined });
    expect(w.find("input").attributes("aria-describedby")).toBe(w.find(".ui-field-hint").attributes("id"));
    expect(w.find(".ui-field-hint").attributes("aria-hidden")).toBeUndefined();
  });

  it("hands the slot errorId only while there is an error, and the id names the error line", async () => {
    const seen: (string | undefined)[] = [];
    const w = mount(FieldRow, {
      props: { label: "Mode", hint: "Pick one" },
      slots: {
        default: (s: Slot) => {
          seen.push(s.errorId);
          return h("button", { "aria-describedby": s.errorId });
        },
      },
      attachTo: document.body,
    });
    expect(w.find("button").attributes("aria-describedby")).toBeUndefined();
    await w.setProps({ error: "Choose a face" });
    const id = w.find("button").attributes("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)?.textContent?.trim()).toBe("Choose a face");
    expect(id).not.toBe(w.find("label").attributes("id"));
    await w.setProps({ error: "" });
    expect(w.find("button").attributes("aria-describedby")).toBeUndefined();
    expect(seen.at(-1)).toBeUndefined();
  });

  it("gives two rows with errors different error ids", () => {
    const row = () =>
      h(FieldRow, { label: "R", error: "Bad" }, { default: (s: Slot) => h("input", { "aria-describedby": s.errorId }) });
    const w = mount({ render: () => h("form", [row(), row()]) });
    const [a, b] = w.findAll("input").map((i) => i.attributes("aria-describedby"));
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("has no description without hint or error, and inline is the default layout", () => {
    const w = render({});
    expect([w.find(".ui-field-hint").exists(), w.find("input").attributes("aria-describedby")]).toEqual([
      false,
      undefined,
    ]);
    expect(w.classes()).toContain("ui-field-row-inline");
    expect(render({ layout: "stacked" }).classes()).toContain("ui-field-row-stacked");
  });
});

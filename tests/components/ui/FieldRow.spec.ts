import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h } from "vue";

import FieldRow from "../../../src/components/ui/FieldRow.vue";

enableAutoUnmount(afterEach);

type Slot = { id: string; describedby: string | undefined; invalid: boolean };

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

  it("describes the control by its hint, and by the error instead while there is one", async () => {
    const w = render({ hint: "From the sketch plane" });
    const hint = w.find(".ui-field-hint");
    expect(w.find("input").attributes("aria-describedby")).toBe(hint.attributes("id"));
    expect(hint.text()).toBe("From the sketch plane");
    await w.setProps({ error: "Must be above 0" });
    expect([
      w.find(".ui-field-hint").text(),
      w.classes("is-error"),
      w.find("input").attributes("aria-invalid"),
    ]).toEqual(["Must be above 0", true, "true"]);
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

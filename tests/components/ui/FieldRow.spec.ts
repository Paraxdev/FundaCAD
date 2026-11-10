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
      h(
        FieldRow,
        { label: "R", error: "Bad" },
        { default: (s: Slot) => h("input", { "aria-describedby": s.errorId }) },
      );
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

describe("FieldRow param layout", () => {
  function param(props: Record<string, unknown>, attrs: Record<string, string> = {}) {
    return mount(FieldRow, {
      props: { label: "Offset", layout: "param", ...props },
      attrs,
      slots: { default: (s: Slot) => h("input", { id: s.id, "aria-describedby": s.describedby }) },
    });
  }
  const shape = (el: Element): unknown => ({
    tag: el.tagName.toLowerCase(),
    classes: [...el.classList],
    id: el.getAttribute("id") ? "set" : null,
    for: el.getAttribute("for"),
    ariaHidden: el.getAttribute("aria-hidden"),
    title: el.getAttribute("title"),
    field: el.getAttribute("data-field"),
  });

  it("keeps the inspector row markup, with the caller's class, title and data-field on the root", () => {
    const w = param({ controlClass: "param-file" }, { class: "fx-row", title: "Rows tip", "data-field": "offset" });
    const inputId = w.find("input").attributes("id");
    expect([...w.element.children].map(shape)).toEqual([
      { tag: "label", classes: [], id: "set", for: inputId, ariaHidden: null, title: null, field: null },
      {
        tag: "div",
        classes: ["param-value", "param-file"],
        id: null,
        for: null,
        ariaHidden: null,
        title: null,
        field: null,
      },
    ]);
    expect(shape(w.element)).toEqual({
      tag: "div",
      classes: ["param-row", "fx-row"],
      id: null,
      for: null,
      ariaHidden: null,
      title: "Rows tip",
      field: "offset",
    });
    expect(w.find(".param-value").element.children[0]).toBe(w.find("input").element);
    expect(w.find(".ui-field-label, .ui-field-control").exists()).toBe(false);
  });

  it("draws the problem line hidden from browse mode in place of the hint, and the hint when there is none", async () => {
    const w = param({ hint: "From the plane" });
    const hint = w.find(".ui-field-hint");
    expect([hint.element.tagName, hint.text(), hint.attributes("aria-hidden")]).toEqual([
      "DIV",
      "From the plane",
      undefined,
    ]);
    expect(w.find("input").attributes("aria-describedby")).toBe(hint.attributes("id"));
    expect(w.find(".param-problem").exists()).toBe(false);
    await w.setProps({ error: "Must be above 7" });
    const p = w.find(".param-problem");
    expect([p.element.tagName, p.text(), p.attributes("aria-hidden"), w.find(".ui-field-hint").exists()]).toEqual([
      "P",
      "Must be above 7",
      "true",
      false,
    ]);
    expect(p.attributes("id")).toBeTruthy();
    expect(w.find("input").attributes("aria-describedby")).toBeUndefined();
    await w.setProps({ error: undefined, hint: undefined });
    expect([w.find(".param-problem").exists(), w.find(".ui-field-hint").exists()]).toEqual([false, false]);
  });

  it("gives the label a fixed column only when the caller asks for one, and the value column keeps its flex", () => {
    const flexes = (w: ReturnType<typeof param>) => [
      w.find("label").element.style.flex,
      w.find(".param-value").attributes("style"),
    ];
    expect({ fixed: flexes(param({ labelWidth: "96px" })), free: flexes(param({})) }).toEqual({
      fixed: ["0 0 96px", undefined],
      free: ["", undefined],
    });
  });

  it("draws no for when the control is named by something else, and still hands the slot an id", () => {
    const w = param({ for: null });
    expect(w.find("label").attributes("for")).toBeUndefined();
    expect(w.find("label").attributes("id")).toBeTruthy();
    expect(w.find("input").attributes("id")).toBeTruthy();
  });

  it("takes the caller's id through for", () => {
    const w = param({ for: "offset-in" });
    expect([w.find("label").attributes("for"), w.find("input").attributes("id")]).toEqual(["offset-in", "offset-in"]);
  });

  it("gives three param rows different label, control and error ids", () => {
    const row = (label: string) =>
      h(FieldRow, { label, layout: "param", error: "Bad" }, { default: (s: Slot) => h("input", { id: s.id }) });
    const w = mount({ render: () => h("form", [row("A"), row("B"), row("C")]) });
    const labels = w.findAll("label");
    const inputs = w.findAll("input").map((i) => i.attributes("id"));
    const ids = [
      ...labels.map((l) => l.attributes("id")),
      ...inputs,
      ...w.findAll(".param-problem").map((p) => p.attributes("id")),
    ];
    expect(new Set(ids).size).toBe(9);
    expect(labels.map((l) => l.attributes("for"))).toEqual(inputs);
  });
});

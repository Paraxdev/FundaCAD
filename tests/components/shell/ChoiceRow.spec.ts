import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h } from "vue";
import ChoiceRow from "../../../src/components/shell/ChoiceRow.vue";

enableAutoUnmount(afterEach);

const options = [
  { value: "blind", label: "Blind" },
  { value: "through", label: "Through all" },
  { value: "face", label: "Up to a face" },
];

describe("ChoiceRow", () => {
  it("points its label at the trigger and keeps the trigger's name", () => {
    const w = mount(ChoiceRow, { props: { label: "Mode", value: "blind", options, commit: () => {} } });
    const trigger = w.get("[role=combobox]");
    expect(trigger.attributes("id")).toBeTruthy();
    expect(w.get("label").attributes("for")).toBe(trigger.attributes("id"));
    expect(trigger.attributes("aria-label")).toBe("Mode, Blind");
  });

  it("names the trigger by the shown option of a different value", () => {
    const w = mount(ChoiceRow, { props: { label: "Mode", value: "face", options, commit: () => {} } });
    expect(w.get("[role=combobox]").attributes("aria-label")).toBe("Mode, Up to a face");
  });

  it("gives two rows different trigger ids", () => {
    const row = (label: string) => h(ChoiceRow, { label, value: "blind", options, commit: () => {} });
    const w = mount({ render: () => h("div", [row("Mode"), row("Mode")]) });
    const ids = w.findAll("[role=combobox]").map((t) => t.attributes("id"));
    expect(ids[0]).not.toBe(ids[1]);
    expect(w.findAll("label").map((l) => l.attributes("for"))).toEqual(ids);
  });

  it("puts the row title on the row", () => {
    const w = mount(ChoiceRow, {
      props: { label: "Mode", value: "blind", options, commit: () => {}, rowTitle: "How far it goes" },
    });
    expect(w.get(".param-row").attributes("title")).toBe("How far it goes");
  });

  it("renders its field as data-field on the row, and none without one", () => {
    const withField = mount(ChoiceRow, {
      props: { label: "Mode", field: "holeType", value: "blind", options, commit: () => {} },
    });
    expect(withField.get(".param-row").attributes("data-field")).toBe("holeType");
    const without = mount(ChoiceRow, { props: { label: "Mode", value: "blind", options, commit: () => {} } });
    expect(without.get(".param-row").attributes("data-field")).toBeUndefined();
  });
});

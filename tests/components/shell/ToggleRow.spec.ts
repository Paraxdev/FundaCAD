import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h } from "vue";
import ToggleRow from "../../../src/components/shell/ToggleRow.vue";

enableAutoUnmount(afterEach);

function mountPair(commits: string[]) {
  const row = (name: string, value: boolean) =>
    h(ToggleRow, { label: "Invert heights", value, commit: (v: boolean) => commits.push(`${name}:${v}`) });
  return mount({ render: () => h("div", [row("first", false), row("second", true)]) }, { attachTo: document.body });
}

describe("ToggleRow", () => {
  it("gives two switches with one label different ids, each label pointing at its own", () => {
    const w = mountPair([]);
    const ids = w.findAll("[role=switch]").map((s) => s.attributes("id"));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    expect(w.findAll("label").map((l) => l.attributes("for"))).toEqual(ids);
  });

  it("flips only its own switch when its label is clicked", async () => {
    const commits: string[] = [];
    const w = mountPair(commits);
    await w.findAll("label")[1]!.trigger("click");
    expect(commits).toEqual(["second:false"]);
    await w.findAll("label")[0]!.trigger("click");
    expect(commits).toEqual(["second:false", "first:true"]);
  });

  it("still names the switch by its label and reports its state", () => {
    const w = mountPair([]);
    const switches = w.findAll("[role=switch]");
    expect(switches.map((s) => [s.attributes("aria-label"), s.attributes("aria-checked")])).toEqual([
      ["Invert heights", "false"],
      ["Invert heights", "true"],
    ]);
  });

  it("puts the row title on the row", () => {
    const w = mount(ToggleRow, { props: { label: "Flip", value: false, commit: () => {}, rowTitle: "Flips it" } });
    expect(w.get(".param-row").attributes("title")).toBe("Flips it");
  });

  it("renders its field as data-field on the row, and none without one", () => {
    const withField = mount(ToggleRow, {
      props: { label: "Drill point", field: "drillPoint", value: true, commit: () => {} },
    });
    expect(withField.get(".param-row").attributes("data-field")).toBe("drillPoint");
    const without = mount(ToggleRow, { props: { label: "Drill point", value: true, commit: () => {} } });
    expect(without.get(".param-row").attributes("data-field")).toBeUndefined();
  });
});

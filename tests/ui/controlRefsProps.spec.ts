import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, type VNode } from "vue";

import ChoiceRow from "../../src/components/shell/ChoiceRow.vue";
import FileRow from "../../src/components/shell/FileRow.vue";
import Switch from "../../src/components/ui/Switch.vue";
import ToggleRow from "../../src/components/shell/ToggleRow.vue";
import ValidatedRow from "../../src/components/shell/ValidatedRow.vue";
import { walkControls } from "../../src/ui/controlRefs";

vi.mock("../../src/plugins/host", () => ({ openDialog: vi.fn() }));

const rect = () => ({ left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 });
const nothing = () => {};
const holeTypes = [
  { value: "simple", label: "Simple" },
  { value: "cbore", label: "Counterbore" },
];

function panel(rows: () => VNode[]) {
  return mount({ render: () => h("div", { class: "timeline-props" }, rows()) }, { attachTo: document.body });
}

function refs(): string[] {
  return walkControls(document, { rect }).controls.map((c) => c.ref);
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("property rows in the harness", () => {
  it("names a hole's choice, switch, file and value controls by their field", () => {
    const w = panel(() => [
      h(ChoiceRow, { label: "Type", field: "holeType", value: "cbore", options: holeTypes, commit: nothing }),
      h(ToggleRow, { label: "Drill point", field: "drillPoint", value: true, commit: nothing }),
      h(FileRow, { label: "Heightmap", field: "heightmapPath", value: "C:/maps/ridge 7.png", commit: nothing }),
      h(ValidatedRow, {
        label: "Diameter",
        field: "diameter",
        value: 8.5,
        unit: "mm",
        units: ["mm", "in"],
        parse: (raw: string) => Number(raw),
        onCommit: nothing,
      }),
    ]);
    expect(refs()).toEqual([
      "prop:holeType",
      "prop:drillPoint",
      "prop:heightmapPath",
      'text:"Clear the file"',
      "prop:diameter",
      'text:"Diameter unit, mm"',
    ]);
    w.unmount();
  });

  it("keeps the unit chip and the file clear button on their own refs", () => {
    const w = panel(() => [
      h(FileRow, { label: "Heightmap", field: "heightmapPath", value: "C:/maps/ridge 7.png", commit: nothing }),
      h(ValidatedRow, {
        label: "Diameter",
        field: "diameter",
        value: 8.5,
        unit: "mm",
        units: ["mm", "in"],
        parse: (raw: string) => Number(raw),
        onCommit: nothing,
      }),
    ]);
    expect(refs()).toEqual([
      "prop:heightmapPath",
      'text:"Clear the file"',
      "prop:diameter",
      'text:"Diameter unit, mm"',
    ]);
    w.unmount();
  });

  it("gives two rows with the same label different refs", () => {
    const w = panel(() => [
      h(ChoiceRow, { label: "Mode", field: "startMode", value: "simple", options: holeTypes, commit: nothing }),
      h(ChoiceRow, { label: "Mode", field: "endMode", value: "cbore", options: holeTypes, commit: nothing }),
      h(ToggleRow, { label: "Mode", field: "flipMode", value: false, commit: nothing }),
    ]);
    expect(refs()).toEqual(["prop:startMode", "prop:endMode", "prop:flipMode"]);
    w.unmount();
  });

  it("falls back to the old refs for a row without a field", () => {
    const w = panel(() => [
      h(ChoiceRow, { label: "Type", value: "simple", options: holeTypes, commit: nothing }),
      h(ToggleRow, { label: "Drill point", value: true, commit: nothing }),
    ]);
    expect(refs()).toEqual(['text:"Type, Simple"', 'text:"Drill point"']);
    w.unmount();
  });

  it("keeps the ref of a switch and a select outside a property row", () => {
    const w = mount(
      {
        render: () => [
          h(Switch, { modelValue: true, label: "Snap" }),
          h("div", { class: "param-row" }, [h(Switch, { modelValue: false, label: "Grid" })]),
        ],
      },
      { attachTo: document.body },
    );
    expect(refs()).toEqual(['text:"Snap"', 'text:"Grid"']);
    w.unmount();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h } from "vue";
import ReadoutList from "../../../src/components/ui/ReadoutList.vue";

enableAutoUnmount(afterEach);

const pairs = (w: ReturnType<typeof mount>) =>
  w.findAll(".measure-row").map((r) => [r.find("dt").text(), r.find("dd").text()]);

describe("ReadoutList", () => {
  it("is a dl with no rows when given none", () => {
    const w = mount(ReadoutList, { props: { rows: [] } });
    expect([w.element.tagName, w.findAll("dt").length, w.findAll("dd").length]).toEqual(["DL", 0, 0]);
  });

  it("reads one row as a term and its value", () => {
    const w = mount(ReadoutList, { props: { rows: [{ k: "Area", v: "37.25 mm²" }] } });
    expect(pairs(w)).toEqual([["Area", "37.25 mm²"]]);
  });

  it("keeps three rows in order, each pair inside its own measure-row div", () => {
    const rows = [
      { k: "Distance", v: "12.5 mm" },
      { k: "ΔX ΔY ΔZ", v: "3.2, -7.1, 9.4" },
      { k: "Angle", v: "73.5°" },
    ];
    const w = mount(ReadoutList, { props: { rows } });
    expect(pairs(w)).toEqual([
      ["Distance", "12.5 mm"],
      ["ΔX ΔY ΔZ", "3.2, -7.1, 9.4"],
      ["Angle", "73.5°"],
    ]);
    expect(w.findAll("dl > div.measure-row")).toHaveLength(3);
    expect([w.find("dt").classes(), w.find("dd").classes()]).toEqual([["measure-k"], ["measure-v"]]);
  });

  it("puts rowClass on every row", () => {
    const rows = [
      { k: "Max", v: "41.7 MPa" },
      { k: "Min", v: "2.3 MPa" },
    ];
    const w = mount(ReadoutList, { props: { rows, rowClass: "stress-key-row" } });
    expect(w.findAll(".measure-row").map((r) => r.classes())).toEqual([
      ["measure-row", "stress-key-row"],
      ["measure-row", "stress-key-row"],
    ]);
  });

  it("lets the value slot draw the dd, given the row and its index", () => {
    const rows = [
      { k: "Von Mises", v: "41.7 MPa" },
      { k: "Safety factor", v: "0.8" },
    ];
    const w = mount(ReadoutList, {
      props: { rows },
      slots: {
        value: ({ row, index }: { row: { k: string; v: string }; index: number }) =>
          h("dd", { class: ["measure-v", { "stress-yields": index === 1 }] }, `${row.v}!`),
      },
    });
    expect(w.findAll("dd").map((d) => [d.text(), d.classes()])).toEqual([
      ["41.7 MPa!", ["measure-v"]],
      ["0.8!", ["measure-v", "stress-yields"]],
    ]);
  });

  it("shows a second set of rows without the first leaking", async () => {
    const w = mount(ReadoutList, {
      props: {
        rows: [
          { k: "A", v: "1" },
          { k: "B", v: "2" },
        ],
      },
    });
    await w.setProps({ rows: [{ k: "C", v: "3" }] });
    expect(pairs(w)).toEqual([["C", "3"]]);
  });
});

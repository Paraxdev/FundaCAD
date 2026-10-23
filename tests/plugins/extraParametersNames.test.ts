import { describe, expect, it } from "vitest";
import { nameColumnChars, rowTooltip } from "../../plugins/FundaCAD.ExtraParameters/view";

const def = (comment?: string) => ({ expr: "3.7", value: 3.7, unit: "mm", comment });

describe("parameter row tooltip", () => {
  it("leads with the full name, then the comment on a second line", () => {
    const t = rowTooltip({ name: "bracket_wall_thickness_outer", problem: null, def: def("wall at the lip") });
    expect(t).toBe("bracket_wall_thickness_outer\nwall at the lip");
  });

  it("is just the name when there is no comment and no problem", () => {
    expect(rowTooltip({ name: "gap", problem: null, def: def() })).toBe("gap");
  });

  it("puts the problem before the comment, both under the name", () => {
    const t = rowTooltip({ name: "pitch_outer", problem: "below the minimum 0.3", def: def("spacing") });
    expect(t).toEqual("pitch_outer\nbelow the minimum 0.3\nspacing");
  });
});

describe("name column width", () => {
  it("is 0 with no rows, the one name's length, and the longest of many", () => {
    expect(nameColumnChars([])).toBe(0);
    expect(nameColumnChars([{ name: "gap" }])).toBe(3);
    expect(
      nameColumnChars([{ name: "gap" }, { name: "bracket_wall_thickness_outer" }, { name: "pitch_x" }]),
    ).toBe(28);
  });
});

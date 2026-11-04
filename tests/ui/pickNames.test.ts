import { describe, expect, it } from "vitest";
import { distinctNames } from "../../src/ui/pickNames";

describe("distinctNames", () => {
  it("returns nothing for no rows", () => {
    expect(distinctNames([])).toEqual([]);
  });

  it("leaves a single row alone", () => {
    expect(distinctNames(["Edge 7 of Bracket"])).toEqual(["Edge 7 of Bracket"]);
  });

  it("numbers only the repeated pair by its position, leaving unique rows alone", () => {
    expect(distinctNames(["Face 3 of Lid", "Face 9 of Lid", "Face 3 of Lid", "Edge 2 of Base"])).toEqual([
      "Face 3 of Lid, row 1",
      "Face 9 of Lid",
      "Face 3 of Lid, row 3",
      "Edge 2 of Base",
    ]);
  });

  it("numbers three rows of one label and a second repeated label separately", () => {
    expect(distinctNames(["1 edge", "Plane", "1 edge", "Plane", "1 edge"])).toEqual([
      "1 edge, row 1",
      "Plane, row 2",
      "1 edge, row 3",
      "Plane, row 4",
      "1 edge, row 5",
    ]);
  });
});

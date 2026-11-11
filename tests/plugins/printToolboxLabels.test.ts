import { describe, expect, it } from "vitest";
import { toolLabel } from "../../plugins/FundaCAD.PrintToolbox/lines";
import { PRINT_TOOLS } from "../../plugins/FundaCAD.PrintToolbox/printForm";

describe("PrintToolbox tool names", () => {
  it("gives every tool a line of its own, never its action id", () => {
    for (const id of [...PRINT_TOOLS.map((t) => t.id), "print-bed-fit-check", "print-printability"]) {
      expect(toolLabel(id), id).not.toBe(id);
    }
  });
});

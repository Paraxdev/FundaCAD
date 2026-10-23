import { afterEach, describe, expect, it } from "vitest";
import scss from "../../src/styles/_prefs.scss?raw";
import { fmtLengthCompact, setUnit } from "../../src/ui/units";

afterEach(() => setUnit("mm"));

describe("fmtLengthCompact", () => {
  it("keeps at most three significant digits, in every unit, for grid steps off the round numbers", () => {
    setUnit("in");
    expect([0.1, 1, 5, 10, 50, 100, 2.5].map(fmtLengthCompact)).toEqual([
      "0.00394in",
      "0.0394in",
      "0.197in",
      "0.394in",
      "1.97in",
      "3.94in",
      "0.0984in",
    ]);
    setUnit("mm");
    expect([0.1, 2.5, 12.345, 1234].map(fmtLengthCompact)).toEqual(["0.1mm", "2.5mm", "12.3mm", "1230mm"]);
    setUnit("cm");
    expect([5, 37.5, 1000].map(fmtLengthCompact)).toEqual(["0.5cm", "3.75cm", "100cm"]);
  });
});

describe("shortcut rows", () => {
  const rule = (sel: string) => {
    const at = scss.indexOf(`
${sel} {`);
    return at < 0 ? "" : scss.slice(at, scss.indexOf("}", at));
  };

  it("gives the changed tag and the reset link no padding and a one line height, so a changed row is no taller", () => {
    expect(rule(".sc-reset")).toMatch(/padding:\s*0;/);
    expect(rule(".sc-reset")).toMatch(/line-height:\s*1;/);
    expect(scss).toMatch(/\.sc-changed,\s*\.sc-fixed\s*\{[^}]*line-height:\s*1;/);
  });
});

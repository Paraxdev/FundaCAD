import { describe, expect, it } from "vitest";
import { windowTitle } from "../../src/app/unsavedGuard";

describe("window title", () => {
  it("marks unsaved changes with a star after the name", () => {
    expect(windowTitle("bracket.funda", false)).toBe("bracket.funda · FundaCAD");
    expect(windowTitle("bracket.funda", true)).toBe("bracket.funda* · FundaCAD");
  });
});

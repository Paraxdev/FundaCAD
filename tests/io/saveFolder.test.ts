import { describe, expect, it } from "vitest";
import { saveFolder, setSaveFolder, suggestedSavePath } from "../../src/io/saveFolder";

describe("Save As starting point", () => {
  it("keeps the document's own path", () => {
    expect(suggestedSavePath("D:/x/a.funda", "a.funda", "D:/proj")).toBe("D:/x/a.funda");
  });

  it("puts a new document in the hinted folder", () => {
    expect(suggestedSavePath(null, "Plate.funda", "D:/proj/")).toBe("D:/proj/Plate.funda");
    expect(suggestedSavePath(null, "Plate.funda", "D:\\proj\\")).toBe("D:\\proj\\Plate.funda");
  });

  it("falls back to the bare name with no hint", () => {
    expect(suggestedSavePath(null, "Untitled.funda", null)).toBe("Untitled.funda");
  });

  it("reads the hint that was set", () => {
    setSaveFolder("D:/proj");
    expect(saveFolder()).toBe("D:/proj");
    expect(suggestedSavePath(null, "a.funda")).toBe("D:/proj/a.funda");
    setSaveFolder(null);
    expect(suggestedSavePath(null, "a.funda")).toBe("a.funda");
  });
});

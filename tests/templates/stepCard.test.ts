import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/templates/examples.json", () => ({
  default: [{ id: "frame", name: "Frame", caption: "", hint: "", icon: "assembly", source: "step" }],
}));

import { templateFile, templateText } from "../../src/templates";

describe("a STEP card", () => {
  it("is not a document to open", async () => {
    await expect(templateText("frame")).rejects.toThrow("the Frame example is a STEP file to import, not a document");
  });

  it("names the file it could not find", async () => {
    await expect(templateFile("frame")).rejects.toThrow("no example file called frame");
  });
});

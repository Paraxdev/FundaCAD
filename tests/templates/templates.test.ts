import { describe, expect, it } from "vitest";
import { TEMPLATES, templateText } from "../../src/templates";
import { documentShapeProblem } from "../../src/document/documentShape";
import { migrateDocument } from "../../src/document/migrate";
import type { CadDocument } from "../../src/types";

describe("built-in templates", () => {
  it("have unique ids", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  for (const t of TEMPLATES) {
    it(`${t.name} is a current document with no history and no imports`, async () => {
      const doc = JSON.parse(await templateText(t.id)) as CadDocument & { versions?: unknown };
      expect(documentShapeProblem(doc)).toBeNull();
      expect(migrateDocument(doc)).toEqual([]);
      expect(doc.versions).toBeUndefined();
      expect(doc.features.length).toBeGreaterThan(0);
      expect(doc.features.some((f) => f.type === "import")).toBe(false);
    });
  }

  it("refuses an unknown id", async () => {
    await expect(templateText("nope")).rejects.toThrow();
  });
});

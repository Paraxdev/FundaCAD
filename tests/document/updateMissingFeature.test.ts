// A tool left open on a step an undo took away commits through updateFeature. Writing nothing must not cost the redo.
import { describe, expect, it, vi } from "vitest";
import { box, freshStore } from "./storeKit";
import type { Feature } from "../../src/types";

vi.stubGlobal("window", globalThis);

describe("updateFeature on a step that is not in the document", () => {
  it("writes nothing and leaves the undo and the redo as they were", () => {
    const s = freshStore();
    s.addFeature(box("a", 40.5, 22.25, 7));
    s.addFeature(box("b", 12.75, 9.5, 4.25));
    s.undo();
    const doc = s.toJSON();

    s.updateFeature("b", { length: 30 } as Partial<Feature>);

    expect(s.toJSON()).toBe(doc);
    expect([s.undoLabel, s.redoLabel]).toEqual(["Box 1", "Box 2"]);
    expect(s.redo()).toBe("Box 2");
    expect(s.document.features.find((f) => f.id === "b")).toMatchObject({ length: 12.75 });
  });

  it("still writes a step that is there", () => {
    const s = freshStore();
    s.addFeature(box("a", 40.5, 22.25, 7));
    s.updateFeature("a", { length: 30 } as Partial<Feature>);
    expect(s.document.features[0]).toMatchObject({ length: 30 });
    expect(s.undo()).not.toBeNull();
    expect(s.document.features[0]).toMatchObject({ length: 40.5 });
  });
});

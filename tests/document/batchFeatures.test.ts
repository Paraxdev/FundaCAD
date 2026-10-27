// Several History rows or plane rows acted on at once are ONE undo step.
import { describe, expect, it } from "vitest";
import { opened } from "./storeKit";
import type { DocumentStore } from "../../src/document/store";

const doc = () =>
  opened({
    features: [
      { id: "a", type: "box", length: 1, width: 1, height: 1 },
      { id: "p1", type: "datumPlane", plane: "XY", offset: 1 },
      { id: "b", type: "box", length: 2, width: 1, height: 1 },
      { id: "p2", type: "datumPlane", plane: "XY", offset: 2 },
      { id: "c", type: "box", length: 3, width: 1, height: 1 },
    ],
  });

const state = (s: DocumentStore) => ({
  ids: s.document.features.map((f) => f.id),
  suppressed: s.document.features.filter((f) => s.isSuppressed(f.id)).map((f) => f.id),
  hidden: ["p1", "p2"].filter((id) => !s.isPlaneVisible(id)),
  rollback: s.rollbackIndex,
});

describe("batch feature actions", () => {
  it("suppresses and unsuppresses several features in one undo step", () => {
    const s = doc();
    const before = state(s);
    s.setSuppressed(["a", "c"], true);
    expect(state(s)).toEqual({ ...before, suppressed: ["a", "c"] });
    s.undo();
    expect(state(s)).toEqual(before);
    s.redo();
    expect(state(s).suppressed).toEqual(["a", "c"]);
    s.setSuppressed(["a", "c"], false);
    expect(state(s)).toEqual(before);
    s.undo();
    expect(state(s).suppressed).toEqual(["a", "c"]);
  });

  it("deletes several features in one undo step and keeps the rollback marker on its feature", () => {
    const s = doc();
    s.setRollback(4);
    s.setSuppressed(["b"], true);
    const before = state(s);
    s.removeFeatures(["a", "b", "p2"]);
    expect(state(s)).toEqual({ ids: ["p1", "c"], suppressed: [], hidden: [], rollback: 1 });
    s.undo();
    expect(state(s)).toEqual(before);
    s.redo();
    expect(state(s).ids).toEqual(["p1", "c"]);
  });

  it("hides and shows several planes in one undo step", () => {
    const s = doc();
    const before = state(s);
    s.setPlanesVisibility(
      new Map([
        ["p1", false],
        ["p2", false],
      ]),
    );
    expect(state(s)).toEqual({ ...before, hidden: ["p1", "p2"] });
    s.undo();
    expect(state(s)).toEqual(before);
    s.redo();
    expect(state(s).hidden).toEqual(["p1", "p2"]);
  });
});

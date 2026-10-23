// Undo and redo back to exactly the saved position leave the document clean, any other position is unsaved.
import { describe, expect, it } from "vitest";
import type { DocumentStore } from "../../src/document/store";
import { box, freshStore, opened } from "./storeKit";

const A = "D:/parts/bracket-a.funda";
const B = "E:/jobs/hinge-b.funda";

const at = (s: DocumentStore) => ({
  dirty: s.dirty,
  path: s.filePath,
  ids: s.document.features.map((f) => f.id),
});

const image = (opacity: number) => ({
  id: "ri1",
  name: "ri1.png",
  image: "429c5bc1257ce3bdfc611423f2302bd2",
  mime: "image/png",
  px: [400, 200],
  plane: "XZ",
  at: [12.5, -7.25],
  width: 63.5,
  angle: 17,
  opacity,
});

function savedWith(...ids: string[]) {
  const s = freshStore();
  ids.forEach((id, i) => s.addFeature(box(id, 11.5 + 3.25 * i, 4.75 + i)));
  s.markSaved(A);
  return s;
}

describe("clean at the saved position", () => {
  it("a fresh document is clean, one edit dirties it and its undo is clean again", () => {
    const s = freshStore();
    expect(at(s)).toEqual({ dirty: false, path: null, ids: [] });
    s.addFeature(box("p1", 23.5, 6.25));
    expect(at(s)).toEqual({ dirty: true, path: null, ids: ["p1"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: null, ids: [] });
  });

  it("undo of every edit back to the save is clean, redo away is dirty and redo back is clean", () => {
    const s = savedWith("p1");
    s.addFeature(box("p2", 9.5, 3.75));
    s.addFeature(box("p3", 14.25, 2.5));
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1", "p2", "p3"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1", "p2"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["p1"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: [] });
    s.redo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["p1"] });
    s.redo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1", "p2"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["p1"] });
  });

  it("a new edit after undoing past the save leaves the saved point unreachable until the next save", () => {
    const s = savedWith("p1", "p2");
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1"] });
    s.addFeature(box("q1", 31.75, 8.5));
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1"] });
    s.redo();
    s.addFeature(box("q2", 5.25, 2.75));
    for (let i = 0; i < 4; i++) s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: [] });
    for (let i = 0; i < 4; i++) s.redo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1", "q1", "q2"] });
    s.markSaved(A);
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1", "q1"] });
    s.redo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["p1", "q1", "q2"] });
  });

  it("a save in the middle of the history is clean only there", () => {
    const s = freshStore();
    s.addFeature(box("p1", 12.5, 4.25));
    s.addFeature(box("p2", 7.75, 3.5));
    s.markSaved(A);
    s.addFeature(box("p3", 19.25, 5.5));
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["p1", "p2"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1"] });
    s.redo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["p1", "p2"] });
    s.redo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1", "p2", "p3"] });
  });

  it("a save that missed a change made while it was written reaches no clean position", () => {
    const s = savedWith("p1");
    s.addFeature(box("p2", 8.25, 3.5));
    s.markSaved(A, false);
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1"] });
    s.redo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1", "p2"] });
  });

  it("an opened document is clean until edited, and undo of the edit is clean again", () => {
    const s = opened({ features: [box("o1", 27.5, 9.25)] });
    s.markSaved(A);
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["o1"] });
    s.addFeature(box("o2", 6.5, 2.25));
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["o1"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["o1"] });
  });

  it("writes made while opening move the saved point along with them", () => {
    const s = opened({ features: [box("o1", 27.5, 9.25)] });
    s.markSaved(A);
    s.keepingClean(() => s.addFeature(box("o2", 6.5, 2.25)));
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["o1", "o2"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["o1"] });
    s.redo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["o1", "o2"] });
  });

  it("an assistant's replacing load is its own step, its undo is the saved document again", () => {
    const s = savedWith("p1");
    s.load(JSON.stringify({ parameters: {}, features: [box("x1", 44.5, 13.75)] }), { replace: true });
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["x1"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["p1"] });
    s.redo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["x1"] });
  });

  it("an untitled assistant load undoes to the saved document with its path, and redoes to an unsaved Untitled", () => {
    const s = savedWith("p1");
    s.load(JSON.stringify({ parameters: {}, features: [box("x1", 44.5, 13.75)] }), { replace: true, untitled: true });
    expect(at(s)).toEqual({ dirty: true, path: null, ids: ["x1"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: A, ids: ["p1"] });
    s.redo();
    expect(at(s)).toEqual({ dirty: true, path: null, ids: ["x1"] });
  });

  it("a replacing load saved under its own path is clean there and its undo is unsaved", () => {
    const s = savedWith("p1");
    s.load(JSON.stringify({ parameters: {}, features: [box("x1", 44.5, 13.75)] }), { replace: true, untitled: true });
    s.markSaved(B);
    expect(at(s)).toEqual({ dirty: false, path: B, ids: ["x1"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: ["p1"] });
    s.redo();
    expect(at(s)).toEqual({ dirty: false, path: null, ids: ["x1"] });
  });

  it("a second document opened after the first does not inherit the first one's saved point", () => {
    const s = savedWith("p1");
    s.load(JSON.stringify({ parameters: {}, features: [] }));
    expect(at(s)).toEqual({ dirty: true, path: A, ids: [] });
    s.addFeature(box("b1", 17.25, 3.5));
    s.undo();
    expect(at(s)).toEqual({ dirty: true, path: A, ids: [] });
    s.markSaved(B);
    s.addFeature(box("b2", 21.5, 6.75));
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: B, ids: [] });
    expect(s.canUndo).toBe(false);
  });

  it("a new document after an edited one is clean at its start only", () => {
    const s = savedWith("p1", "p2");
    s.undo();
    s.newDocument();
    expect(at(s)).toEqual({ dirty: false, path: null, ids: [] });
    s.addFeature(box("n1", 9.75, 4.5));
    expect(at(s)).toEqual({ dirty: true, path: null, ids: ["n1"] });
    s.undo();
    expect(at(s)).toEqual({ dirty: false, path: null, ids: [] });
  });

  it("the saved point is reachable while still on the capped undo stack, and lost once it falls off", () => {
    const fill = (n: number) => {
      const s = freshStore();
      s.markSaved(A);
      for (let i = 0; i < n; i++) s.addFeature(box(`f${i}`, 3.5 + i, 2.25));
      for (let i = 0; i < n; i++) s.undo();
      return { dirty: s.dirty, left: s.document.features.length, more: s.canUndo };
    };
    expect(fill(50)).toEqual({ dirty: false, left: 0, more: false });
    expect(fill(51)).toEqual({ dirty: true, left: 1, more: false });
  });

  it("a save on the bottom entry of a full stack survives that entry falling off", () => {
    const s = freshStore();
    s.addFeature(box("f0", 3.5, 2.25));
    s.markSaved(A);
    for (let i = 1; i <= 50; i++) s.addFeature(box(`f${i}`, 3.5 + i, 2.25));
    for (let i = 0; i < 50; i++) s.undo();
    expect({ dirty: s.dirty, ids: s.document.features.map((f) => f.id), more: s.canUndo }).toEqual({
      dirty: false,
      ids: ["f0"],
      more: false,
    });
  });

  it("a coalesced drag continuing from the saved point leaves it behind", () => {
    const s = freshStore();
    s.setReferenceImages([image(0.35)], { coalesce: "opacity:ri1" });
    s.markSaved(A);
    s.setReferenceImages([image(0.65)], { coalesce: "opacity:ri1" });
    expect(s.dirty).toBe(true);
    s.undo();
    s.redo();
    expect({ dirty: s.dirty, opacity: s.referenceImages()[0]?.opacity }).toEqual({ dirty: true, opacity: 0.65 });
    s.setReferenceImages([image(0.8)], { coalesce: "opacity:other" });
    s.undo();
    expect({ dirty: s.dirty, opacity: s.referenceImages()[0]?.opacity }).toEqual({ dirty: true, opacity: 0.65 });
  });
});

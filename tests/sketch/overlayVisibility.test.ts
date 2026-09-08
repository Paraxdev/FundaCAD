// A hidden sketch must be gone from BOTH surfaces it occupies: the curves drawn
// on the model, and the region fills that answer a click.
//
// The overlay declared a `sketchVisible` hook and had always filtered on it,
// but nothing ever assigned it, so its default ("everything is visible") stood
// and the filter was inert. Reported as two symptoms of one cause: a sketch
// hidden from the browser tree still drew its outline over the pocket it had
// cut, and clicking the pocket's inner face selected the hidden profile that
// lay over it instead of the face.
import { describe, it, expect } from "vitest";
import { SketchOverlay } from "../../src/sketch/overlay";
import type { CadDocument } from "../../src/types";

/** Two closed square profiles on XY, as separate sketches. */
const doc = (): CadDocument =>
  ({
    version: 4,
    parameters: {},
    features: [
      { id: "s1", type: "sketch", plane: "XY", entities: [square("a", 0)] },
      { id: "s2", type: "sketch", plane: "XY", entities: [square("b", 40)] },
    ],
  }) as unknown as CadDocument;

const square = (id: string, x: number) =>
  ({ type: "rectangle", id, x, y: 0, width: 10, height: 10 });

const ids = (o: SketchOverlay) => o.regions.map((r) => r.sketchId).sort();

describe("SketchOverlay.sketchVisible", () => {
  it("draws and offers both sketches by default", () => {
    // The default has to stay permissive: an overlay nobody has configured must
    // show the document, not hide it.
    const o = new SketchOverlay();
    o.update(doc());
    expect(ids(o)).toEqual(["s1", "s2"]);
  });

  it("drops a hidden sketch's REGIONS, not just its curves", () => {
    // The click half of the report. A hidden sketch that kept its fills would
    // still be invisible and still steal the pick, the worse of the two bugs,
    // because there is nothing on screen to explain it.
    const o = new SketchOverlay();
    o.sketchVisible = (id) => id !== "s2";
    o.update(doc());
    expect(ids(o)).toEqual(["s1"]);
  });

  it("hides everything when the predicate says so", () => {
    const o = new SketchOverlay();
    o.sketchVisible = () => false;
    o.update(doc());
    expect(o.regions).toEqual([]);
  });

  it("re-shows a sketch on the next update after the predicate changes", () => {
    // Visibility is display-only: the store emits no document change, so the
    // browser's toggle calls update() itself. If the overlay cached anything per
    // sketch, un-hiding would need a rebuild the toggle never triggers.
    const o = new SketchOverlay();
    let hidden = "s2";
    o.sketchVisible = (id) => id !== hidden;
    o.update(doc());
    expect(ids(o)).toEqual(["s1"]);
    hidden = "";
    o.update(doc());
    expect(ids(o)).toEqual(["s1", "s2"]);
  });

  it("still hides the sketch being edited, independently of the predicate", () => {
    // hiddenSketchId is the OPEN sketch, drawn by the editor rather than here.
    // The two filters are separate and both have to hold, or entering a sketch
    // would double-draw it.
    const o = new SketchOverlay();
    o.update(doc(), "s1");
    expect(ids(o)).toEqual(["s2"]);
  });
});

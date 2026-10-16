// What an import reply adds to the document: one sketch per DXF layer, the
// import feature only when the file had 3D geometry, ids that are free.

import { describe, expect, it } from "vitest";
import { freeIds, importFeatures } from "../../src/io/importSketches";
import type { ImportReply, SketchEntity } from "../../src/types";

type Ok = Extract<ImportReply, { ok: true }>;
const line: SketchEntity = { id: "e1", type: "line", x1: 0, y1: 0, x2: 10, y2: 0 };

describe("freeIds", () => {
  it("skips ids in use and hands out distinct ones", () => {
    expect(freeIds(["f1", "f3", "f4"], 3)).toEqual(["f5", "f6", "f7"]);
    expect(freeIds(["f2"], 2)).toEqual(["f3", "f4"]);
    expect(freeIds(["sk", "f2"], 2)).toEqual(["f3", "f4"]);
    expect(freeIds([], 0)).toEqual([]);
  });
});

describe("importFeatures", () => {
  const taken = ["f1", "f2"];

  it("turns each layer into a sketch on XY named after it, and adds no import feature without geometry", () => {
    const res: Ok = { ok: true, name: "plate", sketches: [{ name: "Plate", entities: [line] }, { name: "Cam", entities: [line] }] };
    const out = importFeatures(res, { format: "dxf", source: "C:/x/plate.dxf", taken });
    expect(out).toEqual([
      { id: "f3", type: "sketch", plane: "XY", name: "Plate", entities: [line] },
      { id: "f4", type: "sketch", plane: "XY", name: "Cam", entities: [line] },
    ]);
  });

  it("adds the import feature after the sketches when the file also had 3D faces", () => {
    const res: Ok = { ok: true, name: "mix", geom: "abc", solid: true, faces: 6, notes: ["n"], sketches: [{ name: "A", entities: [line] }] };
    const out = importFeatures(res, { format: "dxf", source: "mix.dxf", taken });
    expect(out.map((f) => [f.id, f.type])).toEqual([["f3", "sketch"], ["f4", "import"]]);
    expect(out[1]).toMatchObject({ format: "dxf", geom: "abc", source: "mix.dxf", solid: true, notes: ["n"] });
  });

  it("keeps the single import feature of every other format as it was", () => {
    const res: Ok = { ok: true, name: "part", geom: "h", solid: false, faces: 3, color: "#ff0000" };
    expect(importFeatures(res, { format: "stl", source: "part.stl", taken: [] })).toEqual([
      { id: "f1", type: "import", format: "stl", name: "part", geom: "h", source: "part.stl", solid: false, color: "#ff0000" },
    ]);
  });
});

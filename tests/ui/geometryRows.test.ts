// Rows the Geometry list shows, from plain numbers: what one reply and a body's meta make, and which rows a filter keeps.
import { describe, expect, it } from "vitest";
import {
  edgeRows,
  faceKeyOf,
  faceRows,
  filterRows,
  NO_FILTERS,
  planeRowKey,
  planeRows,
  type BodyMeta,
  type GeometryRow,
} from "../../src/ui/geometryRows";
import { circleDiameter } from "../../src/ui/selectionMeasure";
import type { Feature, PlaneDef, TopologyFace, TopologyReply, Vec3 } from "../../src/types";

const names: Record<string, string> = { ex1: "Extrude 1", fil1: "Fillet 1" };
const ownerName = (id: string) => names[id] ?? null;

function reply(faces: TopologyFace[], edgeFaces?: number[][]): TopologyReply {
  return { body: "body3", faceCount: faces.length, faces, ...(edgeFaces ? { edgeFaces } : {}) };
}
const meta = (faceCount: number, more: Partial<BodyMeta> = {}): BodyMeta => ({
  id: "body3",
  name: "Bracket",
  faceCount,
  ...more,
});
const keys = (rows: readonly GeometryRow[]) => rows.map((r) => r.key);

const TOP: TopologyFace = {
  i: 0,
  surface: "plane",
  area: 2400,
  centroid: [113.5, -41.25, 37],
  normal: [0, 0, 1],
  size: [60, 40],
};
const BORE: TopologyFace = {
  i: 1,
  surface: "cylinder",
  area: 628.3,
  centroid: [31, 7.5, 12],
  axis: [0.34, 0, 0.94],
  radius: 5,
  length: 20,
  wraps: true,
  concave: true,
};

describe("faceRows", () => {
  it("makes no rows from an empty reply", () => {
    expect(faceRows(reply([]), meta(0), ownerName)).toEqual([]);
  });

  it("makes one whole row with every fact of the face", () => {
    const rows = faceRows(reply([TOP]), meta(1, { faceOwners: ["ex1"] }), ownerName);
    expect(rows).toEqual([
      {
        key: "f:body3:0",
        kind: "face",
        bodyId: "body3",
        index: 0,
        type: "flat",
        size: 60,
        facing: "up",
        facts: {
          kind: "face",
          number: 1,
          surface: "plane",
          area: 2400,
          centroid: [113.5, -41.25, 37],
          normal: [0, 0, 1],
          size: [60, 40],
          body: "Bracket",
          owner: "Extrude 1",
        },
      },
    ]);
  });

  it("maps the op's words to the facts' words on a bore", () => {
    const [, row] = faceRows(reply([TOP, BORE]), meta(2, { faceOwners: ["ex1", "gone"] }), ownerName);
    expect(row).toEqual({
      key: "f:body3:1",
      kind: "face",
      bodyId: "body3",
      index: 1,
      type: "cylinder",
      size: 10,
      facing: null,
      facts: {
        kind: "face",
        number: 2,
        surface: "cylinder",
        area: 628.3,
        centroid: [31, 7.5, 12],
        axis: [0.34, 0, 0.94],
        radius: 5,
        length: 20,
        full: true,
        concave: true,
        body: "Bracket",
        owner: null,
      },
    });
  });

  it("gives a face no owner fact when the body has no faceOwners", () => {
    const [row] = faceRows(reply([TOP]), meta(1), ownerName);
    expect("owner" in (row!.facts as object)).toBe(false);
  });

  it("drops a face at or past the mesh's face count, keeps the one before it", () => {
    const faces = [TOP, { ...BORE, i: 1 }, { ...BORE, i: 2 }];
    expect(keys(faceRows(reply(faces), meta(2), ownerName))).toEqual(["f:body3:0", "f:body3:1"]);
    expect(keys(faceRows(reply(faces), meta(3), ownerName))).toEqual(["f:body3:0", "f:body3:1", "f:body3:2"]);
  });

  it("sizes a flat by its long side, a round by its diameter, the rest by area", () => {
    const area = 49;
    const size = (f: Partial<TopologyFace> & { surface: TopologyFace["surface"] }) =>
      faceRows(reply([{ i: 0, area, ...f }]), meta(1), ownerName)[0]!.size;
    expect(size({ surface: "plane", size: [12.5, 3] })).toBe(12.5);
    expect(size({ surface: "plane" })).toBe(7);
    expect(size({ surface: "cylinder", radius: 2.5 })).toBe(5);
    expect(size({ surface: "cylinder" })).toBe(7);
    expect(size({ surface: "sphere", radius: 4 })).toBe(8);
    expect(size({ surface: "torus", radius: 1.5, major: 9 })).toBe(3);
    expect(size({ surface: "cone", axis: [0, 0, 1], length: 3 })).toBe(7);
    expect(size({ surface: "bspline" })).toBe(7);
    expect(size({ surface: "other" })).toBe(7);
  });

  it("keeps a scan's bare face, with no size to compare", () => {
    const [row] = faceRows(reply([{ i: 0, surface: "other" }]), meta(1), ownerName);
    expect(row!.size).toBe(0);
    expect(row!.type).toBe("curved");
  });

  it("types only a plane flat and only a cylinder as one, the rest curved", () => {
    const type = (surface: TopologyFace["surface"]) =>
      faceRows(reply([{ i: 0, surface }]), meta(1), ownerName)[0]!.type;
    expect(["plane", "cylinder", "cone", "sphere", "torus", "bspline", "other"].map((s) => type(s as never))).toEqual([
      "flat",
      "cylinder",
      "curved",
      "curved",
      "curved",
      "curved",
      "curved",
    ]);
  });

  it("faces a flat by the nearest direction, a curved face has none", () => {
    const facing = (normal: Vec3 | undefined, surface: TopologyFace["surface"] = "plane") =>
      faceRows(reply([{ i: 0, surface, ...(normal ? { normal } : {}) }]), meta(1), ownerName)[0]!.facing;
    const tilt = (deg: number): Vec3 => [0, -Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)];
    expect(facing(tilt(20))).toBe("up");
    expect(facing(tilt(44))).toBe("up");
    expect(facing(tilt(45))).toBe("up");
    expect(facing(tilt(46))).toBe("front");
    expect(facing([0, 0, 0])).toBeNull();
    expect(facing(undefined)).toBeNull();
    expect(facing([0, 0, 1], "sphere")).toBeNull();
  });

  describe("band merge", () => {
    const piece = (i: number, area: number, centroid: Vec3): TopologyFace => ({
      i,
      surface: "cylinder",
      area,
      centroid,
      axis: [0, 0, 1],
      radius: 8,
      length: 3,
      wraps: true,
      concave: false,
    });
    const FACES = [TOP, piece(1, 10, [1, 2, 3]), piece(2, 30, [5, 6, 7]), { ...BORE, i: 3 }, piece(4, 20, [9, 2, 1])];

    it("makes one row for a run, on its lowest face, with the area its pieces add up to", () => {
      const rows = faceRows(reply(FACES), meta(5, { faceBands: [[4, 1, 2]], faceOwners: ["ex1", "fil1"] }), ownerName);
      expect(keys(rows)).toEqual(["f:body3:0", "f:body3:1", "f:body3:3"]);
      expect(rows[1]).toEqual({
        key: "f:body3:1",
        kind: "face",
        bodyId: "body3",
        index: 1,
        type: "cylinder",
        size: 16,
        facing: null,
        members: [1, 2, 4],
        facts: {
          kind: "face",
          number: 2,
          surface: "cylinder",
          area: 60,
          centroid: [(10 * 1 + 30 * 5 + 20 * 9) / 60, (10 * 2 + 30 * 6 + 20 * 2) / 60, (10 * 3 + 30 * 7 + 20 * 1) / 60],
          axis: [0, 0, 1],
          radius: 8,
          full: true,
          concave: false,
          pieces: 3,
          body: "Bracket",
          owner: "Fillet 1",
        },
      });
    });

    it("leaves one piece's size and length out, a flat run is sized by its area", () => {
      const flat = (i: number): TopologyFace => ({ i, surface: "plane", area: 8, normal: [0, 0, 1], size: [4, 2] });
      const [row] = faceRows(reply([flat(0), flat(1)]), meta(2, { faceBands: [[0, 1]] }), ownerName);
      expect(row!.size).toBe(4);
      expect("size" in (row!.facts as object)).toBe(false);
      expect("length" in (row!.facts as object)).toBe(false);
      expect(row!.facts).toMatchObject({ area: 16, pieces: 2 });
    });

    it("takes the same runs a click takes: one reaching outside the body or of one face is no run", () => {
      const m = (faceBands: number[][]) => meta(5, { faceBands });
      expect(keys(faceRows(reply(FACES), m([[1, 5]]), ownerName))).toHaveLength(5);
      expect(keys(faceRows(reply(FACES), m([[-1, 2]]), ownerName))).toHaveLength(5);
      expect(keys(faceRows(reply(FACES), m([[2]]), ownerName))).toHaveLength(5);
    });

    it("keeps two runs apart", () => {
      const rows = faceRows(
        reply(FACES),
        meta(5, {
          faceBands: [
            [0, 3],
            [1, 2],
          ],
        }),
        ownerName,
      );
      expect(rows.map((r) => [r.key, r.members])).toEqual([
        ["f:body3:0", [0, 3]],
        ["f:body3:1", [1, 2]],
        ["f:body3:4", undefined],
      ]);
    });

    it("gives a selected piece the key of its run's row", () => {
      const m = meta(5, { faceBands: [[4, 1, 2]] });
      expect([0, 1, 2, 3, 4].map((i) => faceKeyOf(m, i))).toEqual([
        "f:body3:0",
        "f:body3:1",
        "f:body3:1",
        "f:body3:3",
        "f:body3:1",
      ]);
    });
  });
});

describe("edgeRows", () => {
  const straight = (slot: number, length = 40) => ({
    slot,
    points: [
      [113.5, -41.25, 37],
      [113.5 + length * 0.6, -41.25 + length * 0.8, 37],
    ] as [number, number, number][],
  });
  // A circle tilted out of the world planes and away from the origin, as a slanted hole's rim is.
  const ring = (r: number, from: number, to: number, n: number): [number, number, number][] =>
    Array.from({ length: n + 1 }, (_, k) => {
      const t = from + ((to - from) * k) / n;
      const u = r * Math.cos(t);
      const v = r * Math.sin(t);
      return [31 + u * 0.8, -12 + v, 7 + u * 0.6];
    });
  const circle = (slot: number, r: number) => ({ slot, points: ring(r, 0, Math.PI * 2, 48) });
  const arc = (slot: number, r: number) => ({ slot, points: ring(r, 0.3, 1.7, 12) });
  const FACES3 = meta(9, { faceOwners: ["ex1", "ex1", "ex1", "fil1"] });

  it("makes no rows from no edges", () => {
    expect(edgeRows([], 0, undefined, meta(0), ownerName)).toEqual([]);
  });

  it("makes one whole row with its neighbours and owner", () => {
    const rows = edgeRows([straight(4)], 6, [[], [], [], [], [3, 0], []], FACES3, ownerName);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.size).toBeCloseTo(40, 9);
    const { size: _size, facts, ...rest } = rows[0]!;
    expect(rest).toEqual({ key: "e:body3:4", kind: "edge", bodyId: "body3", index: 4, type: "straight", facing: null });
    expect((facts as { length: number }).length).toBeCloseTo(40, 9);
    expect({ ...facts, length: 0 }).toEqual({
      kind: "edge",
      number: 5,
      curve: "line",
      length: 0,
      faces: [4, 1],
      body: "Bracket",
      owner: "Fillet 1",
    });
  });

  it("keeps the rows and drops only the neighbour and owner facts on a length mismatch", () => {
    const refs = [straight(0), straight(1)];
    for (const edgeFaces of [[[0, 1]], [[0], [1], [2]], undefined]) {
      const rows = edgeRows(refs, 2, edgeFaces, FACES3, ownerName);
      expect(keys(rows)).toEqual(["e:body3:0", "e:body3:1"]);
      for (const r of rows) {
        expect("faces" in (r.facts as object)).toBe(false);
        expect("owner" in (r.facts as object)).toBe(false);
      }
    }
    const fits = edgeRows(refs, 2, [[0, 1], [2]], FACES3, ownerName);
    expect(fits.map((r) => (r.facts as { faces?: number[] }).faces)).toEqual([[1, 2], [3]]);
  });

  it("numbers by the wire slot, so hidden edges leave gaps in the numbers", () => {
    const rows = edgeRows([straight(0), straight(5)], 7, undefined, FACES3, ownerName);
    expect(rows.map((r) => [r.key, r.facts.kind === "edge" && r.facts.number])).toEqual([
      ["e:body3:0", 1],
      ["e:body3:5", 6],
    ]);
  });

  it("names a neighbour in a run by its row's number, once", () => {
    const m = meta(5, { faceBands: [[1, 2, 4]] });
    const rows = edgeRows(
      [straight(0), straight(1)],
      2,
      [
        [2, 0],
        [1, 4],
      ],
      m,
      ownerName,
    );
    expect(rows.map((r) => (r.facts as { faces?: number[] }).faces)).toEqual([[2, 1], [2]]);
  });

  it("leaves out a neighbour past the mesh's face count", () => {
    const rows = edgeRows([straight(0)], 1, [[1, 3]], meta(3), ownerName);
    expect((rows[0]!.facts as { faces?: number[] }).faces).toEqual([2]);
  });

  it("reads a slanted circle, an arc and a free curve from their points", () => {
    const ellipse = {
      slot: 3,
      points: ring(10, 0, 1.4, 16).map(([x, y, z], k) => [x * (1 + k * 0.02), y, z] as [number, number, number]),
    };
    const rows = edgeRows([circle(0, 7), arc(1, 7), straight(2), ellipse], 4, undefined, meta(0), ownerName);
    expect(rows.map((r) => [r.type, r.facts.kind === "edge" && r.facts.curve])).toEqual([
      ["round", "circle"],
      ["round", "arc"],
      ["straight", "line"],
      ["curved", "curve"],
    ]);
    const facts = rows.map((r) => r.facts as { radius?: number; length: number });
    expect(facts[0]!.radius).toBeCloseTo(7, 2);
    expect(facts[1]!.radius).toBeCloseTo(7, 6);
    expect(facts[2]!.radius).toBeUndefined();
    expect(facts[3]!.radius).toBeUndefined();
    expect(rows[0]!.size).toBeCloseTo(Math.PI * 14, 1);
    // The same answer the readout already gives for a closed ring.
    expect(circleDiameter(circle(0, 7).points)).toBeCloseTo(facts[0]!.radius! * 2, 9);
  });

  it("treats a straight edge in many collinear points as a line, and a shallow bow as an arc", () => {
    const along = (t: number): [number, number, number] => [10 + t * 0.3, -4 + t * 0.4, 2 + t * Math.sqrt(0.75)];
    const many = { slot: 0, points: [0, 3, 7, 9].map(along) };
    const bow = (s: number) => ({
      slot: 1,
      points: [
        along(0),
        [10 + 5 * 0.3 + s, -4 + 5 * 0.4, 2 + 5 * Math.sqrt(0.75)] as [number, number, number],
        along(10),
      ],
    });
    const type = (e: { slot: number; points: [number, number, number][] }) =>
      edgeRows([e], 2, undefined, meta(0), ownerName)[0]!.type;
    expect(type(many)).toBe("straight");
    expect(type(bow(0.00005))).toBe("straight");
    expect(type(bow(0.01))).toBe("round");
  });

  it("does not take a closed shape that is no circle for one", () => {
    const square = {
      slot: 0,
      points: [
        [5, 5, 1],
        [15, 5, 1],
        [15, 15, 1],
        [5, 15, 1],
        [5, 5, 1],
      ] as [number, number, number][],
    };
    expect(edgeRows([square], 1, undefined, meta(0), ownerName)[0]!.type).toBe("curved");
  });

  it("survives an edge with one point", () => {
    const [row] = edgeRows([{ slot: 0, points: [[1, 2, 3]] }], 1, undefined, meta(0), ownerName);
    expect(row!.size).toBe(0);
    expect(row!.type).toBe("straight");
  });
});

describe("filterRows", () => {
  const row = (name: string, type: GeometryRow["type"], size: number, facing: GeometryRow["facing"]): GeometryRow => ({
    key: name,
    kind: "face",
    bodyId: "body3",
    index: 0,
    type,
    size,
    facing,
    facts: { kind: "face", number: 1, surface: "plane" },
  });
  const ROWS = [
    row("a", "flat", 60, "up"),
    row("b", "flat", 12.5, "down"),
    row("c", "cylinder", 40, null),
    row("d", "curved", 39.99, null),
    row("e", "flat", 40, "up"),
  ];
  const filter = (f: Partial<typeof NO_FILTERS>) => keys(filterRows(ROWS, { ...NO_FILTERS, ...f }));

  it("keeps everything with no filter, as the same array", () => {
    expect(filterRows(ROWS, NO_FILTERS)).toBe(ROWS);
    expect(filter({})).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("gives nothing back from nothing", () => {
    expect(filterRows([], { ...NO_FILTERS, type: "flat" })).toEqual([]);
  });

  it("filters by type", () => {
    expect(filter({ type: "flat" })).toEqual(["a", "b", "e"]);
    expect(filter({ type: "cylinder" })).toEqual(["c"]);
    expect(filter({ type: "straight" })).toEqual([]);
  });

  it("filters by facing, a face with none never matches", () => {
    expect(filter({ facing: "up" })).toEqual(["a", "e"]);
    expect(filter({ facing: "down" })).toEqual(["b"]);
    expect(filter({ facing: "left" })).toEqual([]);
  });

  it("takes a size exactly at the limit and leaves one just under", () => {
    expect(filter({ minSize: 40 })).toEqual(["a", "c", "e"]);
    expect(filter({ minSize: 40.01 })).toEqual(["a"]);
    expect(filter({ minSize: 39.99 })).toEqual(["a", "c", "d", "e"]);
  });

  it("does not let float noise lose a size that shows as the limit", () => {
    const noisy = [row("n", "flat", 25.4 - 1e-9, "up"), row("u", "flat", 25.4 - 1e-3, "up")];
    expect(keys(filterRows(noisy, { ...NO_FILTERS, minSize: 25.4 }))).toEqual(["n"]);
  });

  it("treats an empty or zero size as no limit, and a negative as none", () => {
    expect(filter({ minSize: null })).toHaveLength(5);
    expect(filter({ minSize: 0 })).toHaveLength(5);
    expect(filter({ minSize: -3 })).toHaveLength(5);
  });

  it("applies filters together", () => {
    expect(filter({ type: "flat", facing: "up", minSize: 41 })).toEqual(["a"]);
    expect(filter({ type: "cylinder", facing: "up" })).toEqual([]);
  });
});

describe("planeRows", () => {
  const SLANTED = { origin: [113.5, -41.25, 37], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] } as PlaneDef;
  const BACK = { origin: [7, 88, -3], normal: [0, 1, 0], xdir: [1, 0, 0] } as PlaneDef;
  const defs: Record<string, PlaneDef> = { d1: SLANTED, d2: BACK, d3: SLANTED };
  const datum = (id: string, name?: string) => ({ id, type: "datumPlane", ...(name ? { name } : {}) }) as Feature;
  const rows = (features: Feature[], off: string[] = []) =>
    planeRows(
      ["XY", "XZ"],
      features,
      (f) => defs[f.id]!,
      (id) => off.includes(id),
    );
  const planeKeys = (r: readonly GeometryRow[]) => r.map((x) => x.key);

  it("gives the whole row of an origin plane and of a slanted datum off the origin", () => {
    expect(rows([datum("d1", "Lid")]).filter((r) => r.key !== "p:o:XZ")).toEqual([
      {
        key: "p:o:XY",
        kind: "plane",
        bodyId: "",
        index: 0,
        facts: { kind: "plane", name: "XY", origin: true, normal: [0, 0, 1] },
        size: 0,
        facing: "up",
        type: "flat",
        plane: { kind: "basePlane", plane: "XY" },
      },
      {
        key: "p:d1",
        kind: "plane",
        bodyId: "",
        index: 2,
        facts: { kind: "plane", name: "Lid", origin: false, normal: [0, 0.6, 0.8] },
        size: 0,
        facing: "up",
        type: "flat",
        plane: { kind: "datumPlane", id: "d1" },
      },
    ]);
  });

  it("lists the origin planes alone with no datum, and takes every datum of many in order", () => {
    expect(planeKeys(rows([]))).toEqual(["p:o:XY", "p:o:XZ"]);
    expect(planeKeys(rows([datum("d1", "Lid"), { id: "x", type: "box" } as Feature, datum("d2", "Rear")]))).toEqual([
      "p:o:XY",
      "p:o:XZ",
      "p:d1",
      "p:d2",
    ]);
  });

  it("leaves a suppressed datum out, and the next one keeps the number Items gives it", () => {
    const got = rows([datum("d1"), datum("d2"), datum("d3")], ["d2"]);
    expect(planeKeys(got)).toEqual(["p:o:XY", "p:o:XZ", "p:d1", "p:d3"]);
    expect(got.map((r) => (r.facts as { name: string }).name)).toEqual(["XY", "XZ", "Plane1", "Plane3"]);
    expect(got.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });

  it("keeps only the planes a facing filter names, the datum looking back among them", () => {
    const got = rows([datum("d1", "Lid"), datum("d2", "Rear")]);
    expect(got.find((r) => r.key === "p:d2")?.facing).toBe("back");
    expect(planeKeys(filterRows(got, { ...NO_FILTERS, facing: "up" }))).toEqual(["p:o:XY", "p:d1"]);
  });

  it("names a plane's key among the feature rows Items selects", () => {
    expect(planeRowKey({ kind: "basePlane", plane: "YZ" })).toBe("o:YZ");
    expect(planeRowKey({ kind: "datumPlane", id: "d9" })).toBe("d9");
  });
});

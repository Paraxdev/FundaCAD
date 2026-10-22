import { describe, expect, it } from "vitest";
import { TEMPLATES, templateText } from "../../src/templates";
import { documentShapeProblem } from "../../src/document/documentShape";
import { migrateDocument } from "../../src/document/migrate";
import { commitParamExpr, recompute } from "../../src/params/engine";
import type { CadDocument } from "../../src/types";
import printer3000Inline from "../fixtures/printer_3000.stpz?inline";

async function load(id: string): Promise<CadDocument> {
  return JSON.parse(await templateText(id)) as CadDocument;
}

describe("built-in templates", () => {
  it("have unique ids", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it("are each a document, in the order Home shows them", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      "wall-bracket",
      "box-with-lid",
      "capsule-holder",
      "plate",
      "pinned-lever",
    ]);
  });

  for (const t of TEMPLATES) {
    it(`${t.name} is a current document with no history and no imports`, async () => {
      const doc = (await load(t.id)) as CadDocument & { versions?: unknown };
      expect(documentShapeProblem(doc)).toBeNull();
      expect(migrateDocument(doc)).toEqual([]);
      expect(doc.versions).toBeUndefined();
      expect(doc.features.length).toBeGreaterThan(0);
      expect(doc.features.some((f) => f.type === "import")).toBe(false);
    });

    it(`${t.name} stores the values its parameters give`, async () => {
      const doc = await load(t.id);
      const before = JSON.parse(JSON.stringify(doc)) as CadDocument;
      expect(recompute(doc).issues).toEqual({});
      // recompute also caches each feature binding (d1, d2...) in `parameters`, which the files leave out.
      const kept = Object.fromEntries(Object.keys(before.parameters).map((k) => [k, doc.parameters[k]]));
      expect({ parameters: kept, paramDefs: doc.paramDefs, features: doc.features }).toEqual({
        parameters: before.parameters,
        paramDefs: before.paramDefs,
        features: before.features,
      });
    });
  }

  it("refuses an unknown id", async () => {
    await expect(templateText("nope")).rejects.toThrow();
  });
});

describe("the printer STEP fixture", () => {
  const VENDORS =
    /prusa|creality|ender|voron|bambu|anycubic|elegoo|ultimaker|artillery|sovol|qidi|flashforge|makerbot|ratrig/i;
  const GROUPS = ["Printer", "Frame", "Motion", "Bed", "Toolhead", "Electronics"];

  const bytesOf = (inline: string) => Uint8Array.from(atob(inline.split(",")[1]!), (c) => c.charCodeAt(0));

  async function facts(gz: Uint8Array<ArrayBuffer>) {
    const plain = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(plain).text();
    const products = new Set([...text.matchAll(/PRODUCT\('([^']*)'/g)].map((m) => m[1]!));
    return {
      gzip: [gz[0], gz[1]],
      header: text.slice(0, 13),
      groups: GROUPS.filter((g) => products.has(g)),
      vendor: [...products].filter((p) => VENDORS.test(p)),
      colours: new Set([...text.matchAll(/COLOUR_RGB\('',([^)]*)\)/g)].map((m) => m[1])).size >= 5,
    };
  }

  it("keeps a 3,000 part printer for the big import at most 1 MB", async () => {
    const gz = bytesOf(printer3000Inline);
    expect(gz.length).toBeLessThanOrEqual(1024 * 1024);
    expect(await facts(gz)).toEqual({
      gzip: [0x1f, 0x8b],
      header: "ISO-10303-21;",
      groups: GROUPS,
      vendor: [],
      colours: true,
    });
  });

  it("finds a vendor word in a product name", () => {
    expect(["Frame", "Toolhead", "Ender style bed", "VORON frame"].filter((p) => VENDORS.test(p))).toEqual([
      "Ender style bed",
      "VORON frame",
    ]);
  });
});

describe("Box with a lid", () => {
  const round = (v: number) => Math.round(v * 1e6) / 1e6;

  type Line = { x1: string; y1: string; x2: string; y2: string };
  function outlines(doc: CadDocument) {
    const p = doc.parameters as Record<string, number>;
    const rects: Record<string, number[]> = {};
    for (const f of doc.features) {
      if (f.type !== "sketch") continue;
      const lines = f.entities as unknown as Line[];
      for (let i = 0; i < lines.length; i += 4) {
        const xs = lines.slice(i, i + 4).flatMap((l) => [p[l.x1]!, p[l.x2]!]);
        const ys = lines.slice(i, i + 4).flatMap((l) => [p[l.y1]!, p[l.y2]!]);
        rects[`${f.id}#${i / 4}`] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map(round);
      }
    }
    return rects;
  }
  function fit(doc: CadDocument) {
    const r = outlines(doc);
    const [cl, cr, cf, cb] = r["cavityOutline#0"]!;
    const [ll, lr, lf, lb] = r["lipOutline#0"]!;
    const [dl, dr] = r["lidOutline#0"]!;
    return {
      cavity: [round(cr! - cl!), round(cb! - cf!)],
      lip: [round(lr! - ll!), round(lb! - lf!)],
      lipCentredOnLid: round((ll! + lr!) / 2) === round((dl! + dr!) / 2),
      apart: r["boxOutline#0"]![1]! < dl!,
    };
  }
  function extrudes(doc: CadDocument) {
    return doc.features.flatMap((f) =>
      f.type === "extrude"
        ? [[f.id, f.operation, f.distance, f.startOffset ?? 0, f.endType ?? "distance", f.targets ?? []]]
        : [],
    );
  }

  it("lays out a box and a lid whose lip fits the box with 0.2 mm all round", async () => {
    const doc = await load("box-with-lid");
    expect(outlines(doc)).toEqual({
      "boxOutline#0": [-69, -5, -22, 22],
      "cavityOutline#0": [-67, -7, -20, 20],
      "lidOutline#0": [5, 69, -22, 22],
      "lipOutline#0": [7.2, 66.8, -19.8, 19.8],
      "lipOutline#1": [9.2, 64.8, -17.8, 17.8],
    });
    expect(fit(doc)).toEqual({ cavity: [60, 40], lip: [59.6, 39.6], lipCentredOnLid: true, apart: true });
    expect(extrudes(doc)).toEqual([
      ["box", "new", 27, 0, "distance", []],
      ["cavity", "cut", 25, 2, "throughAll", ["body1"]],
      ["lid", "new", 2, 0, "distance", []],
      ["lip", "join", 5, 2, "distance", ["body2"]],
    ]);
  });

  it("keeps the fit when the inside width, the clearance and the floor change to odd values", async () => {
    const doc = await load("box-with-lid");
    commitParamExpr(doc, "innerWidth", "63.7");
    commitParamExpr(doc, "clearance", "0.35");
    commitParamExpr(doc, "floor", "2.6");
    expect(recompute(doc).issues).toEqual({});
    expect(fit(doc)).toEqual({ cavity: [63.7, 40], lip: [63, 39.3], lipCentredOnLid: true, apart: true });
    expect(extrudes(doc)).toEqual([
      ["box", "new", 27.6, 0, "distance", []],
      ["cavity", "cut", 25, 2.6, "throughAll", ["body1"]],
      ["lid", "new", 2.6, 0, "distance", []],
      ["lip", "join", 5, 2.6, "distance", ["body2"]],
    ]);
  });
});

describe("Capsule holder", () => {
  const round = (v: number, n = 4) => Math.round(v * 10 ** n) / 10 ** n;
  const num = (doc: CadDocument, name: string) => (doc.parameters as Record<string, number>)[name]!;

  type Line = { x1: string | number; y1: string | number };
  // A sketch's corners as [radius, height] in mm.
  function corners(doc: CadDocument, id: string): [number, number][] {
    const value = (v: string | number) => (typeof v === "number" ? v : num(doc, v));
    const sketch = doc.features.find((f) => f.id === id);
    if (sketch?.type !== "sketch") throw new Error(`no sketch ${id}`);
    return (sketch.entities as unknown as Line[]).map((l) => [round(value(l.x1)), round(value(l.y1))]);
  }

  // How much wider the cap's groove is than the tube's ridge along the drawn flanks, at ten radii between the tube
  // groove's bottom and the tube's outside. Both flanks are 60 degrees, so a fitting pair has one play everywhere.
  function play(cap: CadDocument, tube: CadDocument = cap) {
    const [, outerTop, apex] = corners(tube, "grooveProfile") as [[number, number], [number, number], [number, number]];
    const [mouthLow, mouthTop, rootTop] = corners(cap, "voidProfile") as [
      [number, number],
      [number, number],
      [number, number],
    ];
    const across = (from: [number, number], to: [number, number], r: number) =>
      from[1] + ((to[1] - from[1]) * (r - from[0])) / (to[0] - from[0]);
    const centre = (mouthLow[1] + mouthTop[1]) / 2;
    const plays = Array.from({ length: 10 }, (_, i) => {
      const r = apex[0] + ((num(tube, "neckRadius") - apex[0]) * (i + 1)) / 10;
      const ridge = num(tube, "pitch") / 2 - across([apex[0], 0], [outerTop[0], outerTop[1] - apex[1]], r);
      return across([mouthTop[0], mouthTop[1] - centre], [rootTop[0], rootTop[1] - centre], r) - ridge;
    });
    return { min: round(Math.min(...plays), 3), max: round(Math.max(...plays), 3) };
  }

  const revolves = (doc: CadDocument) =>
    doc.features.flatMap((f) =>
      f.type === "revolve" ? [[f.id, f.operation, f.angle, f.pitch ?? 0, f.targets ?? []]] : [],
    );
  const moves = (doc: CadDocument) =>
    doc.features.flatMap((f) => {
      const m = f as unknown as Record<string, unknown>;
      return f.type === "move"
        ? [[f.id, m["activeWhen"], m["dx"] ?? 0, m["dz"] ?? 0, m["rx"] ?? 0, round(Number(m["rz"] ?? 0), 6)]]
        : [];
    });

  const setAll = (doc: CadDocument, values: Record<string, string>) => {
    for (const [name, expr] of Object.entries(values)) commitParamExpr(doc, name, expr);
    expect(recompute(doc).issues).toEqual({});
  };

  it("lays out a tube and a cap side by side, each a profile turned about Z with its thread climbing", async () => {
    const doc = await load("capsule-holder");
    expect(corners(doc, "tubeProfile")).toEqual([
      [0, 0],
      [14.05, 0],
      [15.05, 1],
      [15.05, 30.4],
      [12.4, 30.4],
      [12.4, 42.4],
      [10, 42.4],
      [10, 2.4],
      [0, 2.4],
    ]);
    expect(corners(doc, "capProfile")).toEqual([
      [0, 0],
      [14.05, 0],
      [15.05, 1],
      [15.05, 16.65],
      [12.775, 16.65],
      [12.775, 14.4],
      [11.9232, 14.4],
      [11.9232, 2.4],
      [0, 2.4],
    ]);
    expect(corners(doc, "grooveProfile")).toEqual([
      [12.6, 30.525],
      [12.6, 32.1725],
      [11.1732, 31.3488],
    ]);
    expect(corners(doc, "voidProfile")).toEqual([
      [11.7982, 2.525],
      [11.7982, 4.3807],
      [12.65, 3.8889],
      [12.65, 3.0168],
    ]);
    expect(revolves(doc)).toEqual([
      ["tube", "new", 360, 0, []],
      ["groove", "cut", 2160, 2, ["body1"]],
      ["cap", "new", 360, 0, []],
      ["capThread", "cut", 2880, 2, ["body2"]],
    ]);
    expect(moves(doc)).toEqual([
      ["place", 1, 38.1, 0, 0, 0],
      ["screw", 0, 0, 47.175, 180, 112.787024],
    ]);
  });

  it("leaves 0.25 mm of play on both flanks of the thread", async () => {
    expect(play(await load("capsule-holder"))).toEqual({ min: 0.289, max: 0.289 });
  });

  it("keeps the play, the turns and the layout when the diameter, pitch, clearance, wall and length change", async () => {
    const doc = await load("capsule-holder");
    setAll(doc, { innerDiameter: "23.4", pitch: "2.5", clearance: "0.3", wall: "2.2", innerLength: "51" });
    expect(corners(doc, "tubeProfile")).toEqual([
      [0, 0],
      [15.4, 0],
      [16.4, 1],
      [16.4, 41.2],
      [13.9, 41.2],
      [13.9, 53.2],
      [11.7, 53.2],
      [11.7, 2.2],
      [0, 2.2],
    ]);
    expect(corners(doc, "capProfile")).toEqual([
      [0, 0],
      [15.4, 0],
      [16.4, 1],
      [16.4, 17],
      [14.35, 17],
      [14.35, 14.2],
      [13.2665, 14.2],
      [13.2665, 2.2],
      [0, 2.2],
    ]);
    expect(revolves(doc)).toEqual([
      ["tube", "new", 360, 0, []],
      ["groove", "cut", 1800, 2.5, ["body1"]],
      ["cap", "new", 360, 0, []],
      ["capThread", "cut", 2160, 2.5, ["body2"]],
    ]);
    expect(play(doc)).toEqual({ min: 0.346, max: 0.346 });
    expect(moves(doc)[0]).toEqual(["place", 1, 40.8, 0, 0, 0]);
  });

  it("turns the thread a whole number of times past the tube's end, also when the length is a multiple of the pitch", async () => {
    const turns = async (pitch: string) => {
      const doc = await load("capsule-holder");
      setAll(doc, { pitch });
      return revolves(doc).flatMap(([id, , angle]) =>
        id === "groove" || id === "capThread" ? [(angle as number) / 360] : [],
      );
    };
    expect(await turns("3")).toEqual([4, 6]);
    expect(await turns("2.9")).toEqual([5, 6]);
    expect(await turns("1.5")).toEqual([8, 10]);
  });

  it("draws every thread profile shorter than one turn climbs", async () => {
    for (const pitch of ["1", "1.25", "2", "3.5"]) {
      const doc = await load("capsule-holder");
      setAll(doc, { pitch });
      const tall = (id: string) => {
        const ys = corners(doc, id).map((c) => c[1]);
        return Math.max(...ys) - Math.min(...ys);
      };
      expect([tall("grooveProfile") < +pitch, tall("voidProfile") < +pitch]).toEqual([true, true]);
    }
  });

  it("puts the cap on the tube when screwedOn is 1, and turns the layout off", async () => {
    const doc = await load("capsule-holder");
    setAll(doc, { screwedOn: "1" });
    expect(moves(doc)).toEqual([
      ["place", 0, 38.1, 0, 0, 0],
      ["screw", 1, 0, 47.175, 180, 112.787024],
    ]);
  });

  describe("keeps the thread inside what the kernel cuts whole", () => {
    const turns = (doc: CadDocument) =>
      revolves(doc).flatMap(([id, , angle]) =>
        id === "groove" || id === "capThread" ? [(angle as number) / 360] : [],
      );
    const shoulder = (doc: CadDocument) => corners(doc, "tubeProfile")[3]![1];

    it("turns the thread at least three times, a two turn sweep cuts nothing from the tube", async () => {
      const seen: [string, number[], number][] = [];
      for (const [threadLength, pitch] of [
        ["3", "2"],
        ["4", "2"],
        ["4.99", "2"],
        ["6", "3"],
        ["5", "2"],
        ["5.01", "2"],
      ] as const) {
        const doc = await load("capsule-holder");
        setAll(doc, { threadLength, pitch });
        seen.push([`${threadLength}/${pitch}`, turns(doc), round(shoulder(doc), 2)]);
      }
      expect(seen).toEqual([
        ["3/2", [3, 4], 37.4],
        ["4/2", [3, 4], 37.4],
        ["4.99/2", [3, 4], 37.4],
        ["6/3", [3, 4], 34.9],
        ["5/2", [3, 4], 37.4],
        ["5.01/2", [3, 4], 37.39],
      ]);
    });

    it("stops the thread at nine pitches and at the tube's length, longer sweeps cut only part of it", async () => {
      const seen: [string, number[], number][] = [];
      for (const [threadLength, innerLength] of [
        ["16", "40"],
        ["18", "40"],
        ["18.3", "40"],
        ["30", "40"],
        ["12", "7"],
        ["12", "3"],
      ] as const) {
        const doc = await load("capsule-holder");
        setAll(doc, { threadLength, innerLength });
        seen.push([`${threadLength}/${innerLength}`, turns(doc), round(shoulder(doc), 2)]);
      }
      expect(seen).toEqual([
        ["16/40", [8, 10], 26.4],
        ["18/40", [9, 11], 24.4],
        ["18.3/40", [9, 11], 24.4],
        ["30/40", [9, 11], 24.4],
        ["12/7", [4, 5], 2.4],
        ["12/3", [3, 4], 0.4],
      ]);
    });

    it("draws the same fit for a clearance below 0.05 as for 0.05, at 0 the cap's thread would graze the tube's", async () => {
      const at = async (clearance: string) => {
        const doc = await load("capsule-holder");
        setAll(doc, { clearance });
        return [corners(doc, "capProfile"), corners(doc, "voidProfile"), corners(doc, "grooveProfile")];
      };
      const floor = await at("0.05");
      expect(await at("0")).toEqual(floor);
      expect(await at("0.032")).toEqual(floor);
      expect(await at("0.051")).not.toEqual(floor);
      const [cap, root] = [floor[0]!, floor[1]!];
      expect(round(cap[4]![0]! - root[2]![0]!, 6)).toBe(0.025);
    });

    it("keeps at least 0.4 mm of wall under the thread groove", async () => {
      const left = async (wall: string, pitch: string) => {
        const doc = await load("capsule-holder");
        setAll(doc, { wall, pitch });
        const apex = corners(doc, "grooveProfile")[2]![0]!;
        return round(apex - num(doc, "innerRadius"), 3);
      };
      expect(await left("1.2", "2")).toEqual(0.4);
      expect(await left("2.4", "4")).toEqual(0.4);
      expect(await left("1.7", "3.1")).toEqual(0.4);
      expect(await left("1.62", "2")).toEqual(0.4);
      expect(await left("1.63", "2")).toEqual(0.403);
      expect(await left("2.4", "2")).toEqual(1.173);
    });
  });

  it("finds a cap whose thread does not belong to the tube", async () => {
    const wide = await load("capsule-holder");
    setAll(wide, { innerDiameter: "22" });
    const cap = await load("capsule-holder");
    expect(play(cap, wide)).toEqual({ min: -0.289, max: -0.289 });
  });
});

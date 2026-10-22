import { describe, expect, it } from "vitest";
import { TEMPLATES, templateFile, templateText } from "../../src/templates";
import { documentShapeProblem } from "../../src/document/documentShape";
import { migrateDocument } from "../../src/document/migrate";
import { commitParamExpr, recompute } from "../../src/params/engine";
import type { CadDocument } from "../../src/types";
import printerInline from "../../src/templates/printer.stpz?inline";
import printer3000Inline from "../fixtures/printer_3000.stpz?inline";

async function load(id: string): Promise<CadDocument> {
  return JSON.parse(await templateText(id)) as CadDocument;
}

describe("built-in templates", () => {
  it("have unique ids", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it("are each a document or a STEP, and only the printer is a STEP", () => {
    expect(TEMPLATES.map((t) => [t.id, t.source])).toEqual([
      ["wall-bracket", "document"],
      ["box-with-lid", "document"],
      ["printer", "step"],
      ["plate", "document"],
      ["pinned-lever", "document"],
    ]);
  });

  for (const t of TEMPLATES.filter((x) => x.source === "document")) {
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
    await expect(templateFile("nope")).rejects.toThrow("no example file called nope");
  });

  it("will not open a STEP example as a document", async () => {
    await expect(templateText("printer")).rejects.toThrow("3D printer example is a STEP file");
  });

  it("reads a STEP example into a file named after it", async () => {
    const asked: string[] = [];
    const bytes = new Uint8Array([0x1f, 0x8b, 8, 0, 7, 3]);
    const file = await templateFile("printer", async (url) => {
      asked.push(String(url));
      return new Response(bytes);
    });
    expect(asked).toEqual([expect.stringMatching(/printer\.stpz/)]);
    expect([file.name, [...new Uint8Array(await file.arrayBuffer())]]).toEqual(["printer.stpz", [...bytes]]);
  });

  it("says plainly when a STEP example cannot be read", async () => {
    const missing = async () => new Response("", { status: 404 });
    const offline = async () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(templateFile("printer", missing)).rejects.toThrow("the example file printer.stpz could not be read");
    await expect(templateFile("printer", offline)).rejects.toThrow("the example file printer.stpz could not be read");
  });
});

describe("the printer STEP files", () => {
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

  it("ships a gzipped AP214 printer with named parts in subassemblies and at most 512 KB", async () => {
    const gz = bytesOf(printerInline);
    expect(gz.length).toBeLessThanOrEqual(512 * 1024);
    expect(await facts(gz)).toEqual({
      gzip: [0x1f, 0x8b],
      header: "ISO-10303-21;",
      groups: GROUPS,
      vendor: [],
      colours: true,
    });
  });

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

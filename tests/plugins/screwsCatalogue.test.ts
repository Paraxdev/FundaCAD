// The fastener catalogue as data: every entry complete and buildable on paper, sizes in order, ids
// unique, and the samples the geometry tests measure kept in step with the tables.
//
// UPDATE_SCREW_SAMPLES=1 npx vitest run tests/plugins/screwsCatalogue.test.ts rewrites the samples.

import { describe, expect, it } from "vitest";
import manifest from "../../plugins/FundaCAD.Screws/manifest.json";
import {
  FAMILIES, HOLES, catalogueSize, drivesOf, expand, formatInch, itemsOf, kindOf, lengthsFor, pitchesFor,
  specRows, threadLengthFor, threadSize,
} from "../../plugins/FundaCAD.Screws/catalogue";
import { KINDS, PARTS, getPath, missingFields, specProblems, type FastenerSpec } from "../../plugins/FundaCAD.Screws/spec";
import { exportLibrary, parseLibraryFile, type UserFastener } from "../../plugins/FundaCAD.Screws/library";
import { NO_FILTERS, filterEntries, groupEntries, listEntries, parseQuery } from "../../plugins/FundaCAD.Screws/search";

import CORPUS from "../golden/corpus/corpus_screws_ops.json";

describe("the fastener catalogue", () => {
  it("is large, and says how large", () => {
    const n = catalogueSize();
    console.log(`fastener catalogue: ${FAMILIES.length} families, ${n} items`);
    expect(FAMILIES.length).toBeGreaterThanOrEqual(32);
    expect(n).toBeGreaterThan(2000);
  });

  it("has no duplicate family ids or item keys", () => {
    const ids = FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = FAMILIES.flatMap((f) => itemsOf(f).map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of FAMILIES) {
      const sizes = f.sizes.map((r) => r.size);
      expect(new Set(sizes).size, f.id).toBe(sizes.length);
    }
  });

  it("gives every size every column its family maps, and a thread and holes to go with it", () => {
    for (const f of FAMILIES) {
      for (const row of f.sizes) {
        for (const col of Object.keys(f.columns)) {
          expect(typeof row[col], `${f.id} ${row.size} ${col}`).toBe("number");
        }
        expect(threadSize(f, row.size), `${f.id} ${row.size} thread`).toBeDefined();
        expect(pitchesFor(f, row.size).length, `${f.id} ${row.size} pitch`).toBeGreaterThan(0);
        expect(HOLES[row.size], `${f.id} ${row.size} holes`).toBeDefined();
        if (f.lengths || row.lengths) expect(lengthsFor(f, row).length, `${f.id} ${row.size} lengths`).toBeGreaterThan(0);
      }
    }
  });

  it("lists sizes in increasing order, with head sizes growing with them", () => {
    for (const f of FAMILIES) {
      const d = f.sizes.map((r) => threadSize(f, r.size)!.d);
      for (let i = 1; i < d.length; i++) expect(d[i]!, `${f.id} ${f.sizes[i]!.size}`).toBeGreaterThan(d[i - 1]!);
      for (const col of Object.keys(f.columns)) {
        if (!["dk", "s", "a", "f", "d2", "od", "m", "h", "k"].includes(col)) continue;
        const v = f.sizes.map((r) => Number(r[col]));
        for (let i = 1; i < v.length; i++) expect(v[i]!, `${f.id} ${f.sizes[i]!.size} ${col}`).toBeGreaterThanOrEqual(v[i - 1]! * 0.9);
      }
    }
  });

  it("expands every item, every length and drive, into a spec with nothing missing and nothing impossible", () => {
    let checked = 0;
    for (const f of FAMILIES) {
      for (const item of itemsOf(f)) {
        const spec = expand(item);
        expect(specProblems(spec), spec.name).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBe(catalogueSize());
  });

  it("names an item by standard, size and length", () => {
    expect(expand({ familyId: "iso4762", size: "M3", length: 10 }).name).toBe("ISO 4762 M3x10");
    expect(expand({ familyId: "iso7045", size: "M4", length: 12, drive: "pozidriv" }).name).toBe("ISO 7045 M4x12 PZ");
    expect(expand({ familyId: "asmeSocketCap", size: "#10", length: 0.5 }).name).toBe("ASME B18.3 #10-24 UNC x 1/2");
    expect(expand({ familyId: "iso4032", size: "M8", pitch: 1 }).name).toBe("ISO 4032 M8x1");
    expect(expand({ familyId: "heatset", size: "M3", length: 5.7 }).name).toBe("Heat-set insert M3x5.7");
  });

  it("follows the thread length rules", () => {
    const f = FAMILIES.find((x) => x.id === "iso4014")!;
    const row = f.sizes.find((r) => r.size === "M10")!;
    expect(threadLengthFor(f.threadLength, row, 10, 1.5, 100)).toBe(26);
    expect(threadLengthFor(f.threadLength, row, 10, 1.5, 150)).toBe(32);
    const shcs = expand({ familyId: "iso4762", size: "M6", length: 25 });
    expect(shcs.thread!.length).toBe(25);
    expect(expand({ familyId: "iso4762", size: "M6", length: 60 }).thread!.length).toBe(24);
    const csk = expand({ familyId: "iso10642", size: "M3", length: 8 });
    expect(csk.thread!.length).toBeCloseTo(8 - 1.86, 9);
  });

  it("formats inch lengths as fractions", () => {
    expect(formatInch(0.625)).toBe("5/8");
    expect(formatInch(1.25)).toBe("1-1/4");
    expect(formatInch(2)).toBe("2");
  });

  it("describes every family's defining type and drive with a type the fields file knows", () => {
    for (const f of FAMILIES) {
      const kind = kindOf(f);
      expect(KINDS[kind], f.id).toBeDefined();
      for (const part of KINDS[kind].parts) {
        const spec = expand(itemsOf(f)[0]!);
        const type = getPath(spec, `${part}.type`) as string;
        expect(PARTS[part][type], `${f.id} ${part} ${type}`).toBeDefined();
      }
      for (const d of drivesOf(f)) expect(PARTS.drive[d], `${f.id} drive ${d}`).toBeDefined();
    }
  });

  it("builds a spec table with the standard, the dimensions, the thread and the holes", () => {
    const rows = specRows(expand({ familyId: "iso4762", size: "M3", length: 10 }), { size: "M3", volume: 200 });
    const labels = rows.map((r) => r.label.trim());
    for (const want of ["Standard", "Head diameter", "Head height", "Across flats", "Thread", "Pitch", "Clearance hole", "Tap drill", "Counterbore", "Mass (steel)"]) {
      expect(labels, want).toContain(want);
    }
    expect(rows.find((r) => r.label === "Mass (steel)")!.value).toBe("1.57 g");
  });

  // The screws golden (tests/golden/screws_ops.golden.json) was frozen from
  // these specs, every family at its smallest and largest size and length. A
  // catalogue change that moves one leaves the golden answering for a fastener
  // the library no longer makes, so it has to be re-recorded with the change.
  it("still expands to the specs the screws golden was frozen from", () => {
    const samples: FastenerSpec[] = [];
    for (const f of FAMILIES) {
      const rows = [f.sizes[0]!, f.sizes[f.sizes.length - 1]!];
      for (const row of new Set(rows)) {
        const ls = lengthsFor(f, row);
        const lengths = ls.length ? [...new Set([ls[0]!, ls[ls.length - 1]!])] : [undefined];
        for (const length of lengths) {
          samples.push(expand({ familyId: f.id, size: row.size, ...(length !== undefined ? { length } : {}) }));
        }
      }
    }
    const frozen = (CORPUS.shapes as { name: string; params: unknown }[])
      .filter((s) => s.name.startsWith("sample_"))
      .map((s) => s.params);
    expect(frozen.length).toBeGreaterThan(100);
    expect(JSON.parse(JSON.stringify(samples))).toEqual(frozen);
  });

  it("is a manifest with a shape generator and no feature type of its own", () => {
    expect(manifest.id).toBe("FundaCAD.Screws");
    expect(manifest.geometryWasm).toBe("geometry.wasm");
    expect(manifest.shapeGenerators).toEqual(["fastener"]);
    expect((manifest as { featureTypes?: string[] }).featureTypes).toBeUndefined();
  });
});

describe("a user-defined fastener", () => {
  const good = (): FastenerSpec => ({
    kind: "screw", units: "mm", name: "Long M4 thumb",
    head: { type: "knurled", diameter: 16, height: 9.5, collarDiameter: 8, collarHeight: 3.5 },
    drive: { type: "none" }, point: { type: "chamfer" },
    thread: { type: "metric", diameter: 4, pitch: 0.7, length: 30, hand: "right", modelled: false },
    length: 30,
  });

  it("is accepted when complete", () => {
    expect(specProblems(good())).toEqual([]);
  });

  it("names every missing field", () => {
    const s = good();
    delete s.head!["collarDiameter"];
    delete s.length;
    s.name = "";
    expect(missingFields(s)).toEqual(["a name", "head collar diameter", "length (under the head, overall for countersunk)"]);
    expect(specProblems(s)[0]).toMatch(/^Missing: a name, head collar diameter/);
  });

  it("refuses what cannot exist", () => {
    const s = good();
    s.head!["diameter"] = 3;
    s.thread!.length = 40;
    const problems = specProblems(s);
    expect(problems).toContain("the head must be wider than the shank");
    expect(problems).toContain("the thread cannot be longer than the shank");
  });

  it("round-trips through a library file, and an incomplete entry is left out and said why", () => {
    const items: UserFastener[] = [{ id: "a", spec: good(), created: 1, updated: 1 }];
    const text = exportLibrary(items);
    expect(parseLibraryFile(text)).toEqual({ specs: [good()], problems: [] });
    const broken = JSON.parse(text) as { fasteners: FastenerSpec[] };
    delete broken.fasteners[0]!.thread;
    const parsed = parseLibraryFile(JSON.stringify(broken));
    expect(parsed.specs).toEqual([]);
    expect(parsed.problems[0]).toMatch(/^Long M4 thumb: Missing: thread type/);
    expect(parseLibraryFile("{}").problems).toEqual(["the file is not a fastener library"]);
  });
});

describe("searching the library", () => {
  it("matches a size exactly, so M2 is not M20", () => {
    const entries = listEntries([]);
    const m2 = filterEntries(entries, { ...NO_FILTERS, query: "M2" });
    expect(m2.length).toBeGreaterThan(0);
    expect(m2.every((e) => e.size === "M2")).toBe(true);
  });

  it("reads a length out of the size and words out of the rest", () => {
    expect(parseQuery("m3x10 socket")).toEqual({ words: ["socket"], size: "M3", length: 10 });
    const hits = filterEntries(listEntries([]), { ...NO_FILTERS, query: "M3x10 cap" });
    expect(hits.map((e) => e.familyId)).toContain("iso4762");
    expect(hits.every((e) => e.lengths.includes(10))).toBe(true);
  });

  it("filters by system, drive and standard, and groups by category", () => {
    const entries = listEntries([]);
    const inch = filterEntries(entries, { ...NO_FILTERS, system: "inch" });
    expect(inch.every((e) => e.system === "inch")).toBe(true);
    const torx = filterEntries(entries, { ...NO_FILTERS, drive: "torx" });
    expect(new Set(torx.map((e) => e.familyId))).toEqual(new Set(["iso14583"]));
    const groups = groupEntries(filterEntries(entries, { ...NO_FILTERS, query: "M3" }));
    expect(groups[0]!.category).toBe("Socket screws");
  });

  it("lists a user fastener first, under Custom", () => {
    const spec = expand({ familyId: "iso4762", size: "M3", length: 10 });
    const entries = listEntries([{ id: "x", spec: { ...spec, name: "My M3" }, created: 0, updated: 0 }]);
    expect(entries[0]!.category).toBe("Custom");
    expect(filterEntries(entries, { ...NO_FILTERS, query: "my" })[0]!.customId).toBe("x");
  });
});

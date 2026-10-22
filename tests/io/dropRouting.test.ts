// Files dragged onto the window from the desktop: which one opens, which ones
// import, and which are refused, decided from the names alone.

import { describe, expect, it, vi, beforeEach } from "vitest";

const calls: string[] = [];
let discard = true;
let openOutcome = "ok";
vi.mock("../../src/app/documentActions", () => ({
  mayDiscard: vi.fn(async () => {
    calls.push("ask");
    return discard;
  }),
  // Home is closed here, tests/io/dropOverHome.test.ts drops over it.
  placeImport: async (_e: unknown, _names: string[], run: () => Promise<void>) => {
    await run();
    return true;
  },
}));
vi.mock("../../src/io/files", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/io/files")>();
  return {
    ...real,
    openDocumentAtPath: vi.fn(async (_s: unknown, path: string) => {
      calls.push(`open ${path}`);
      return openOutcome;
    }),
    openDocumentBytes: vi.fn(async (_s: unknown, file: File) => {
      calls.push(`open bytes ${file.name}`);
      return openOutcome;
    }),
    importPath: vi.fn(async (_s: unknown, _g: unknown, path: string) => {
      calls.push(`import ${path}`);
    }),
    importFileBytes: vi.fn(async (_s: unknown, _g: unknown, file: File) => {
      calls.push(`import bytes ${file.name}`);
    }),
    reportError: vi.fn(async (msg: string) => {
      calls.push(`error ${msg}`);
    }),
  };
});

vi.mock("../../src/ui/environmentImport", () => ({
  importEnvironmentFile: vi.fn(async (_s: unknown, file: File) => {
    calls.push(`environment ${file.name}`);
    return file.name.startsWith("huge") ? `${file.name} is too big.` : null;
  }),
}));

import { IMPORT_EXTS } from "../../src/io/files";
import { DOC_EXTS } from "../../src/io/documentExt";
import { planDrop, routeDroppedName } from "../../src/io/dropRouting";
import { takeDroppedFiles, type DroppedFile } from "../../src/io/desktopDrop";

const confText = Object.values(
  import.meta.glob("../../src-tauri/tauri.conf.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0] as string;

const engine = { store: {}, sketch: { hasUncommittedEdits: false }, geometry: {} } as never;

beforeEach(() => {
  calls.length = 0;
  discard = true;
  openOutcome = "ok";
});

describe("routeDroppedName", () => {
  it("imports a DXF drawing in any case", () => {
    expect(IMPORT_EXTS).toContain("dxf");
    expect(routeDroppedName("plate.DXF")).toBe("import");
  });

  it("imports an SVG logo", () => {
    expect(IMPORT_EXTS).toContain("svg");
    expect(routeDroppedName("logo.SVG")).toBe("import");
  });

  it("imports every format the import picker accepts, in any case", () => {
    for (const ext of IMPORT_EXTS) {
      expect(routeDroppedName(`part.${ext}`)).toBe("import");
      expect(routeDroppedName(`PART.${ext.toUpperCase()}`)).toBe("import");
    }
    expect(routeDroppedName("a.FCStd")).toBe("import");
    expect(routeDroppedName(String.raw`C:\Users\me\b.Stl`)).toBe("import");
    expect(routeDroppedName(String.raw`C:\docs.funda\notes`)).toBe("reject");
  });

  it("opens every document extension", () => {
    for (const ext of DOC_EXTS) expect(routeDroppedName(`doc.${ext}`)).toBe("open");
    expect(routeDroppedName("Bracket.FUNDA")).toBe("open");
  });

  it("refuses what it cannot read, rather than calling it STEP", () => {
    for (const name of ["notes.txt", "noext", "x.funda.bak", "trailing.", "archive.zip"]) {
      expect(routeDroppedName(name)).toBe("reject");
    }
  });
});

describe("planDrop", () => {
  it("opens the first document, skips the others, imports in drop order", () => {
    const plan = planDrop(["b.stl", "a.funda", "c.step", "d.fundab", "e.txt", "f.3mf"], (n) => n);
    expect(plan).toEqual({
      open: "a.funda",
      imports: ["b.stl", "c.step", "f.3mf"],
      environments: [],
      skipped: ["d.fundab"],
      rejected: ["e.txt"],
    });
  });

  it("sends a panorama to the environment instead of refusing it", () => {
    expect(routeDroppedName("room.hdr")).toBe("environment");
    expect(routeDroppedName("Sky.EXR")).toBe("environment");
    expect(planDrop(["room.hdr", "b.stl"], (n) => n).environments).toEqual(["room.hdr"]);
  });
});

const named = (...names: string[]): DroppedFile[] => names.map((name) => ({ name, path: `D:/in/${name}` }));

describe("takeDroppedFiles", () => {
  it("opens the document first, then imports into it", async () => {
    await takeDroppedFiles(engine, named("b.stl", "a.funda"));
    expect(calls).toEqual(["ask", "open D:/in/a.funda", "import D:/in/b.stl"]);
  });

  it("imports several files one after another in drop order", async () => {
    await takeDroppedFiles(engine, named("one.stl", "two.3mf", "three.step"));
    expect(calls).toEqual(["import D:/in/one.stl", "import D:/in/two.3mf", "import D:/in/three.step"]);
  });

  it("reads File objects when there is no path", async () => {
    const file = new File(['{"features":[]}'], "a.funda");
    const stl = new File(["solid x\nendsolid x\n"], "b.stl");
    await takeDroppedFiles(engine, [
      { name: "a.funda", file },
      { name: "b.stl", path: null, file: stl },
    ]);
    expect(calls).toEqual(["ask", "open bytes a.funda", "import bytes b.stl"]);
  });

  it("lights with a dropped panorama and says nothing could not be read", async () => {
    const hdr = new File(["#?RADIANCE"], "room.hdr");
    await takeDroppedFiles(engine, [{ name: "room.hdr", path: "D:/in/room.hdr", file: hdr }]);
    expect(calls).toEqual(["environment room.hdr"]);
  });

  it("passes on the environment's refusal", async () => {
    const hdr = new File(["#?RADIANCE"], "huge.hdr");
    await takeDroppedFiles(engine, [{ name: "huge.hdr", file: hdr }]);
    expect(calls).toEqual(["environment huge.hdr", "error huge.hdr is too big."]);
  });

  it("names every refused file and does nothing else when all are refused", async () => {
    await takeDroppedFiles(engine, named("a.txt", "b.docx"));
    expect(calls).toEqual(["error Nothing was imported, FundaCAD cannot read a.txt, b.docx."]);
  });

  it("imports nothing when the dropped document does not open", async () => {
    for (const outcome of ["unreadable", "newerFormat"]) {
      calls.length = 0;
      openOutcome = outcome;
      await takeDroppedFiles(engine, named("a.funda", "b.stl"));
      expect(calls).toEqual(["ask", "open D:/in/a.funda"]);
      calls.length = 0;
      await takeDroppedFiles(engine, [{ name: "a.funda", file: new File(["x"], "a.funda") }, ...named("b.stl")]);
      expect(calls).toEqual(["ask", "open bytes a.funda"]);
    }
  });

  it("drops the whole drop when the discard prompt is cancelled", async () => {
    discard = false;
    await takeDroppedFiles(engine, named("a.funda", "b.stl"));
    expect(calls).toEqual(["ask"]);
  });
});

describe("tauri.conf.json", () => {
  it("keeps dragDropEnabled false, or every in-page drag dies in the app", () => {
    const conf = JSON.parse(confText);
    expect(conf.app.windows[0].dragDropEnabled).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";

const h = vi.hoisted(() => ({ asked: [] as string[], answers: [] as (string | null)[] }));
vi.mock("../../src/ui/choice", () => ({
  choose: async (question: string, options: { label: string }[]) => {
    h.asked.push(`${question} [${options.map((o) => o.label).join(", ")}]`);
    return h.answers.shift() ?? null;
  },
}));

import { importedName, importFromHome, isBlankDocument, placeImport } from "../../src/app/documentActions";

const geometry = {
  rebuild: () => new Promise<never>(() => {}),
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
  async cancel() {
    return true;
  },
} as unknown as GeometryBackend;

const EMPTY = { parameters: {}, features: [] } as unknown as CadDocument;
const ASSEMBLY: Feature[] = [
  { id: "sk1", type: "sketch", plane: "XZ", entities: [] },
  { id: "ex1", type: "extrude", sketch: "sk1", distance: 7.3 },
  { id: "sk2", type: "sketch", plane: "YZ", entities: [] },
  { id: "ex2", type: "extrude", sketch: "sk2", distance: 12.6 },
  { id: "imp1", type: "import", format: "step", name: "bearing", source: "C:/parts/bearing.step" },
] as unknown as Feature[];

function rig(o: { features?: Feature[]; path?: string; dirty?: boolean; sketch?: "open" | "edits" } = {}) {
  setActivePinia(createPinia());
  const home = new Home({} as HomeCallbacks);
  home.open();
  const store = new DocumentStore(geometry, { ...EMPTY, features: o.features ?? [] } as CadDocument);
  if (o.path) store.markSaved(o.path);
  if (o.dirty) store.addFeature({ id: "sk9", type: "sketch", plane: "XY", entities: [] } as unknown as Feature);
  const resetCamera = vi.fn();
  const e = {
    store,
    sketch: { active: !!o.sketch, hasUncommittedEdits: o.sketch === "edits" },
    viewport: { resetCamera },
  } as unknown as Engine;
  const ran: string[][] = [];
  // Stands in for the caller's import loop, one import feature per file.
  const importing =
    (names: string[], land = true) =>
    async () => {
      ran.push(names);
      if (!land) return;
      for (const n of names) {
        store.addFeature({
          id: `imp_${importedName(n)}`,
          type: "import",
          format: "step",
          name: importedName(n),
          source: `D:/downloads/${n}`,
        } as unknown as Feature);
      }
    };
  return { e, store, ran, importing, resetCamera };
}

const ids = (store: DocumentStore) => store.document.features.map((f) => f.id);

beforeEach(() => {
  h.asked = [];
  h.answers = [];
});

describe("importedName", () => {
  it.each([
    ["printer.step", "printer"],
    ["frame.stp.gz", "frame"],
    ["printer.stpz", "printer"],
    ["Housing v2.STEP", "Housing v2"],
    ["gear.3mf", "gear"],
    ["bracket.zip", "bracket"],
    ["notes", "notes"],
  ])("%s is %s", (file, name) => {
    expect(importedName(file)).toBe(name);
  });
});

describe("isBlankDocument", () => {
  it("is blank with no features, no unsaved work, no path and no open sketch", () => {
    expect(isBlankDocument(rig().e)).toBe(true);
  });

  it.each([
    ["one feature", { features: ASSEMBLY.slice(0, 1) }],
    ["no features but unsaved work", { dirty: true }],
    ["no features but a path", { path: "E:/jigs/empty.funda" }],
    ["an open sketch with edits", { sketch: "edits" as const }],
    ["an open sketch with none", { sketch: "open" as const }],
  ])("is not blank with %s", (_what, o) => {
    const { e, store } = rig(o);
    if ("dirty" in o) store.removeFeature("sk9");
    expect(isBlankDocument(e)).toBe(false);
  });
});

describe("importFromHome", () => {
  it("imports into the blank document behind Home with no question and names it after the file", async () => {
    const { e, store, ran, importing } = rig();
    expect(await importFromHome(e, ["printer.step"], importing(["printer.step"]))).toBe(true);
    expect(h.asked).toEqual([]);
    expect(ran).toEqual([["printer.step"]]);
    expect(ids(store)).toEqual(["imp_printer"]);
    expect(store.fileName).toBe("printer");
    expect(store.filePath).toBeNull();
    expect(homeIsOpen()).toBe(false);
  });

  it("names the document from the first of several files", async () => {
    const { e, store, importing } = rig();
    await importFromHome(e, ["frame.stp.gz", "motor.step"], importing(["frame.stp.gz", "motor.step"]));
    expect(store.fileName).toBe("frame");
    expect(ids(store)).toEqual(["imp_frame", "imp_motor"]);
  });

  it("leaves the blank document Untitled when nothing landed", async () => {
    const { e, store, ran, importing } = rig();
    expect(await importFromHome(e, ["broken.step"], importing(["broken.step"], false))).toBe(true);
    expect(ran).toHaveLength(1);
    expect(store.fileName).toBe("Untitled");
    expect(isBlankDocument(e)).toBe(true);
  });

  it("adds to the document with work in it when asked to, keeping every feature", async () => {
    const { e, store, ran, importing } = rig({ features: ASSEMBLY, path: "E:/jigs/Bracket.funda", dirty: true });
    const before = structuredClone(store.document.features);
    h.answers = ["add"];
    expect(await importFromHome(e, ["motor.step"], importing(["motor.step"]))).toBe(true);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain("motor.step");
    expect(h.asked[0]).toMatch(/\[Add to Bracket, New document, Cancel\]$/);
    expect(ran).toEqual([["motor.step"]]);
    expect(store.document.features.slice(0, before.length)).toEqual(before);
    expect(ids(store)).toEqual([...before.map((f) => f.id), "imp_motor"]);
    expect(store.dirty).toBe(true);
    expect(store.fileName).toBe("Bracket.funda");
    expect(homeIsOpen()).toBe(false);
  });

  it("asks once for many files, naming the first and the count", async () => {
    const { e, store, ran, importing } = rig({ features: ASSEMBLY, path: "E:/jigs/Bracket.funda" });
    h.answers = ["add"];
    const files = ["motor.step", "rail.step", "nut.step"];
    await importFromHome(e, files, importing(files));
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain("motor.step and 2 more");
    expect(h.asked[0]).toContain("with them");
    expect(ran).toEqual([files]);
    expect(ids(store).slice(-3)).toEqual(["imp_motor", "imp_rail", "imp_nut"]);
  });

  it("starts a new document named after the file once unsaved work may be discarded", async () => {
    const { e, store, ran, importing, resetCamera } = rig({
      features: ASSEMBLY,
      path: "E:/jigs/Bracket.funda",
      dirty: true,
    });
    h.answers = ["new", "discard"];
    expect(await importFromHome(e, ["motor.step"], importing(["motor.step"]))).toBe(true);
    expect(h.asked).toHaveLength(2);
    expect(h.asked[1]).toMatch(/^Discard unsaved changes.*\[Discard, Cancel\]$/);
    expect(ran).toEqual([["motor.step"]]);
    expect(ids(store)).toEqual(["imp_motor"]);
    expect([store.fileName, store.filePath]).toEqual(["motor", null]);
    expect(resetCamera).toHaveBeenCalledOnce();
    expect(homeIsOpen()).toBe(false);
  });

  it("changes nothing when the discard is refused", async () => {
    const { e, store, ran, importing } = rig({ features: ASSEMBLY, path: "E:/jigs/Bracket.funda", dirty: true });
    const before = structuredClone(store.document.features);
    h.answers = ["new", "cancel"];
    expect(await importFromHome(e, ["motor.step"], importing(["motor.step"]))).toBe(false);
    expect(ran).toEqual([]);
    expect(store.document.features).toEqual(before);
    expect([store.fileName, store.dirty]).toEqual(["Bracket.funda", true]);
    expect(homeIsOpen()).toBe(true);
  });

  it("asks no discard question for a new document over a clean saved one", async () => {
    const { e, store, importing } = rig({ features: ASSEMBLY, path: "E:/jigs/Bracket.funda" });
    h.answers = ["new"];
    await importFromHome(e, ["motor.step"], importing(["motor.step"]));
    expect(h.asked).toHaveLength(1);
    expect([ids(store), store.fileName]).toEqual([["imp_motor"], "motor"]);
  });

  it("goes back to Untitled when nothing landed in the new document", async () => {
    const { e, store, importing } = rig({ features: ASSEMBLY, path: "E:/jigs/Bracket.funda" });
    h.answers = ["new"];
    await importFromHome(e, ["broken.step"], importing(["broken.step"], false));
    expect([ids(store), store.fileName]).toEqual([[], "Untitled"]);
  });

  it.each([
    ["Cancel", "cancel"],
    ["Esc", null],
  ])("changes nothing on %s at the first question", async (_how, answer) => {
    const { e, store, ran, importing } = rig({ features: ASSEMBLY, path: "E:/jigs/Bracket.funda", dirty: true });
    const before = structuredClone(store.document.features);
    h.answers = [answer];
    expect(await importFromHome(e, ["motor.step"], importing(["motor.step"]))).toBe(false);
    expect(ran).toEqual([]);
    expect(h.asked).toHaveLength(1);
    expect(store.document.features).toEqual(before);
    expect(store.fileName).toBe("Bracket.funda");
    expect(homeIsOpen()).toBe(true);
  });
});

describe("placeImport", () => {
  it("imports into the open document with no question when Home is closed", async () => {
    const { e, store, ran, importing } = rig({ features: ASSEMBLY, path: "E:/jigs/Bracket.funda", dirty: true });
    new Home({} as HomeCallbacks).close();
    expect(await placeImport(e, ["motor.step"], importing(["motor.step"]))).toBe(true);
    expect(h.asked).toEqual([]);
    expect(ran).toEqual([["motor.step"]]);
    expect(ids(store).at(-1)).toBe("imp_motor");
    expect(store.fileName).toBe("Bracket.funda");
  });

  it("hands the import to Home's question when Home is up", async () => {
    const { e, ran, importing } = rig({ features: ASSEMBLY, path: "E:/jigs/Bracket.funda" });
    h.answers = ["cancel"];
    expect(await placeImport(e, ["motor.step"], importing(["motor.step"]))).toBe(false);
    expect(h.asked).toHaveLength(1);
    expect(ran).toEqual([]);
  });
});

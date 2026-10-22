import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";
import { importFileBytes, importPath } from "../../src/io/files";

vi.stubGlobal("window", globalThis);

const h = vi.hoisted(() => ({
  answers: [] as (string | null)[],
  asked: [] as string[],
  imported: [] as string[],
  reported: [] as string[],
  told: [] as string[],
  // The maker's edit while the file is read, and while the import's first build runs (after it landed).
  reading: null as null | ((store: DocumentStore) => void),
  building: null as null | ((store: DocumentStore) => void),
  land: true,
  cancel: false,
  file: null as null | (() => Promise<File>),
  store: null as null | DocumentStore,
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async (question: string) => {
    h.asked.push(question);
    return h.answers.shift() ?? null;
  },
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (msg: string, o: { kind?: string } = {}) => void (o.kind === "error" ? h.reported : h.told).push(msg),
}));
vi.mock("../../src/templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/templates")>()),
  templateFile: (id: string) =>
    h.file ? h.file() : Promise.resolve(new File([new Uint8Array([31, 139])], `${id}.stpz`)),
}));

import { hasUnsavedWork, importFromHome, newFromTemplate } from "../../src/app/documentActions";

const SAVED: Feature[] = [
  { id: "sk1", type: "sketch", plane: "XZ", entities: [] },
  { id: "ex1", type: "extrude", sketch: "sk1", distance: 7.3, operation: "new" },
] as unknown as Feature[];

const importOf = (doc: CadDocument) => doc.features.find((f) => f.type === "import");

async function read(name: string) {
  h.imported.push(name);
  h.reading?.(h.store!);
  if (!h.land) return { ok: false as const, message: "the file has no solids" };
  return { ok: true as const, name: "printer", geom: "brep", solid: true, color: "#c0392b" };
}

const geometry = {
  async rebuild(doc: CadDocument) {
    const imp = importOf(doc);
    const edit = imp ? h.building : null;
    if (edit) {
      // The maker's input comes in a later task than the import's own writes, as the engine reply does.
      await new Promise((r) => setTimeout(r, 0));
      h.building = null;
      edit(h.store!);
    }
    if (imp && h.cancel) return { ok: false as const, cancelled: true, error: { message: "cancelled" } };
    const result: RebuildResult = {
      mesh: { positions: [], indices: [], faceIds: [] },
      edges: [],
      bbox: { min: [-5, -24, 0], max: [392, 402, 414] },
      bodies: imp ? [{ id: "body3", name: "Frame", faceStart: 0, faceCount: 6, faceOwners: [imp.id] }] : [],
    };
    return { ok: true as const, result };
  },
  async importBytes(name: string) {
    return read(name);
  },
  async importGeometry(path: string) {
    return read(path.split("/").pop()!);
  },
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
  async cancel() {
    return true;
  },
} as unknown as GeometryBackend;

function rig(o: { dirty?: boolean } = {}) {
  setActivePinia(createPinia());
  new Home({} as HomeCallbacks).open();
  const store = new DocumentStore(geometry, { parameters: {}, features: SAVED } as unknown as CadDocument);
  h.store = store;
  store.markSaved("D:/jigs/Bracket.funda");
  if (o.dirty) store.addFeature({ id: "sk2", type: "sketch", plane: "XY", entities: [] } as unknown as Feature);
  const resetCamera = vi.fn();
  const e = {
    store,
    sketch: { hasUncommittedEdits: false },
    viewport: { resetCamera },
    geometry,
    frameNextModel: vi.fn(),
  } as unknown as Engine;
  return { e, store, resetCamera };
}

function seen(store: DocumentStore) {
  return {
    features: store.document.features.map((f) => f.type),
    name: store.fileName,
    path: store.filePath,
    dirty: store.dirty,
    home: homeIsOpen(),
    imported: h.imported,
    reported: h.reported,
  };
}

const environment = (s: DocumentStore) => s.setDocumentEnvironment({ preset: "studio" } as never);
const rename = (s: DocumentStore) => s.renameFeature(importOf(s.document)!.id, "Frame on the bench");
const material = (s: DocumentStore) => void s.addMaterial({ name: "PETG orange" });
const opens =
  (path: string, o: { dirty?: boolean } = {}) =>
  (s: DocumentStore) => {
    s.load(JSON.stringify({ parameters: {}, features: SAVED, version: 10 }));
    s.markSaved(path);
    if (o.dirty) s.addFeature({ id: "sk4", type: "sketch", plane: "XY", entities: [] } as unknown as Feature);
  };
const sketch = (s: DocumentStore) =>
  s.addFeature({ id: "sk3", type: "sketch", plane: "YZ", entities: [] } as unknown as Feature);

beforeEach(() => {
  Object.assign(h, {
    answers: [],
    asked: [],
    imported: [],
    reported: [],
    told: [],
    reading: null,
    building: null,
    land: true,
    cancel: false,
    file: null,
    store: null,
  });
});

describe("the 3D printer example", () => {
  it("imports printer.stpz once into a new document named after the card, coloured, and ends clean", async () => {
    const { e, store, resetCamera } = rig();
    await newFromTemplate(e, "printer");
    expect(seen(store)).toEqual({
      features: ["import"],
      name: "3D printer",
      path: null,
      dirty: false,
      home: false,
      imported: ["printer.stpz"],
      reported: [],
    });
    expect(store.bodyMaterialId("body3")).toBeDefined();
    expect(resetCamera.mock.calls).toEqual([[false]]);
    expect(h.asked).toEqual([]);
    // The import and its colours are one step, and taking it back is a change.
    store.undo();
    expect([store.document.features.length, store.bodyMaterialId("body3"), store.dirty]).toEqual([0, undefined, true]);
  });

  it.each([
    ["a feature", sketch, ["sketch", "import"]],
    ["the environment", environment, ["import"]],
    ["the material library", material, ["import"]],
  ])("stays dirty when the maker changes %s while the file is read", async (_what, edit, features) => {
    const { e, store } = rig();
    h.reading = edit;
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features, name: "3D printer", dirty: true });
  });

  it.each([
    ["renames the import", rename, "Frame on the bench"],
    ["changes the environment", environment, "printer"],
    ["adds a material", material, "printer"],
    ["adds a feature", sketch, "printer"],
  ])("stays dirty when the maker %s after the import landed, while it builds", async (_what, edit, name) => {
    const { e, store } = rig();
    h.building = edit;
    await newFromTemplate(e, "printer");
    expect(h.building).toBeNull();
    expect(seen(store)).toMatchObject({ name: "3D printer", dirty: true, reported: [] });
    expect((importOf(store.document) as { name?: string } | undefined)?.name).toBe(name);
  });

  it("keeps an open sketch's edits as unsaved work once the import is in", async () => {
    const { e, store } = rig();
    h.reading = () => void ((e.sketch as { hasUncommittedEdits: boolean }).hasUncommittedEdits = true);
    await newFromTemplate(e, "printer");
    expect([store.dirty, hasUnsavedWork(e)]).toEqual([false, true]);
  });

  it("asks before replacing unsaved work and does nothing when refused", async () => {
    const { e, store } = rig({ dirty: true });
    h.answers = ["cancel"];
    await newFromTemplate(e, "printer");
    expect(h.asked).toEqual(["Discard unsaved changes and start a new document?"]);
    expect(seen(store)).toEqual({
      features: ["sketch", "extrude", "sketch"],
      name: "Bracket.funda",
      path: "D:/jigs/Bracket.funda",
      dirty: true,
      home: true,
      imported: [],
      reported: [],
    });
  });

  it("replaces unsaved work once the maker discards it", async () => {
    const { e, store } = rig({ dirty: true });
    h.answers = ["discard"];
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features: ["import"], name: "3D printer", dirty: false });
  });

  it("goes back to a blank untitled document and shows the error when the import fails", async () => {
    const { e, store } = rig();
    h.land = false;
    await expect(newFromTemplate(e, "printer")).resolves.toBeUndefined();
    expect(seen(store)).toEqual({
      features: [],
      name: "Untitled",
      path: null,
      dirty: false,
      home: false,
      imported: ["printer.stpz"],
      reported: ["Couldn't import printer.stpz: the file has no solids"],
    });
  });

  it("goes back to a blank untitled document when its build is cancelled, and Redo brings the import back", async () => {
    const { e, store } = rig();
    h.cancel = true;
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features: [], name: "Untitled", dirty: false, reported: [] });
    h.cancel = false;
    store.redo();
    expect(seen(store)).toMatchObject({ features: ["import"], dirty: true });
  });

  it("keeps a change made before the build was cancelled", async () => {
    const { e, store } = rig();
    h.cancel = true;
    h.reading = environment;
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features: [], name: "3D printer", dirty: true });
  });

  it("says so when the example file cannot be read", async () => {
    const { e, store } = rig();
    h.file = () => Promise.reject(new Error("the example file printer.stpz could not be read"));
    await expect(newFromTemplate(e, "printer")).resolves.toBeUndefined();
    expect(seen(store)).toMatchObject({
      features: [],
      imported: [],
      reported: [expect.stringContaining("printer.stpz")],
    });
  });

  it("still opens a document example as its untitled copy", async () => {
    const { e, store } = rig();
    await newFromTemplate(e, "box-with-lid");
    expect(seen(store)).toMatchObject({ name: "Box with a lid", path: null, dirty: false, imported: [] });
    expect(store.document.features.map((f) => f.id)).toEqual([
      "boxOutline",
      "box",
      "cavityOutline",
      "cavity",
      "lidOutline",
      "lid",
      "lipOutline",
      "lip",
    ]);
  });
});

const motor = () => new File([new Uint8Array([73, 83, 79])], "motor.step");
const dropped = (name: string) => `${name} was not imported, another document was opened while it was read.`;

describe("a document opened while an import reads", () => {
  const gear = { name: "Gear.funda", path: "D:/jigs/Gear.funda", home: false, reported: [] };

  it.each([
    ["clean", false, ["sketch", "extrude"]],
    ["with unsaved work", true, ["sketch", "extrude", "sketch"]],
  ])("keeps the 3D printer example out of an opened document %s", async (_what, dirty, features) => {
    const { e, store } = rig();
    h.reading = opens("D:/jigs/Gear.funda", { dirty });
    await newFromTemplate(e, "printer");
    expect(seen(store)).toEqual({ ...gear, features, dirty, imported: ["printer.stpz"] });
    expect(h.told).toEqual([dropped("printer.stpz")]);
  });

  it("keeps the 3D printer example out of a document opened while its file is fetched", async () => {
    const { e, store } = rig();
    h.file = async () => {
      opens("D:/jigs/Gear.funda")(h.store!);
      return new File([new Uint8Array([31, 139])], "printer.stpz");
    };
    await newFromTemplate(e, "printer");
    expect(seen(store)).toEqual({ ...gear, features: ["sketch", "extrude"], dirty: false, imported: [] });
    expect(h.told).toEqual([dropped("printer.stpz")]);
  });

  it("keeps it out of the last of two documents opened one after the other", async () => {
    const { e, store } = rig();
    h.reading = (s) => {
      opens("D:/jigs/Gear.funda")(s);
      opens("D:/jigs/Hinge.funda")(s);
    };
    await newFromTemplate(e, "printer");
    expect(seen(store)).toEqual({
      ...gear,
      features: ["sketch", "extrude"],
      name: "Hinge.funda",
      path: "D:/jigs/Hinge.funda",
      dirty: false,
      imported: ["printer.stpz"],
    });
    expect(h.told).toEqual([dropped("printer.stpz")]);
  });

  it.each([
    ["a dropped STEP", () => importFileBytes(h.store!, geometry, motor())],
    ["a STEP opened by path", () => importPath(h.store!, geometry, "D:/parts/motor.step")],
  ])("keeps %s out of it", async (_how, run) => {
    const { store } = rig();
    h.reading = opens("D:/jigs/Gear.funda");
    await run();
    expect(seen(store)).toEqual({
      ...gear,
      features: ["sketch", "extrude"],
      dirty: false,
      home: true,
      imported: ["motor.step"],
    });
    expect(h.told).toEqual([dropped("motor.step")]);
  });

  it.each([
    ["a dropped STEP", () => importFileBytes(h.store!, geometry, motor())],
    ["a STEP opened by path", () => importPath(h.store!, geometry, "D:/parts/motor.step")],
  ])("still lands %s when nothing else was opened", async (_how, run) => {
    const { store } = rig();
    await run();
    expect(seen(store)).toEqual({
      features: ["sketch", "extrude", "import"],
      name: "Bracket.funda",
      path: "D:/jigs/Bracket.funda",
      dirty: true,
      home: true,
      imported: ["motor.step"],
      reported: [],
    });
    expect(h.told).toEqual([]);
  });

  it("lands the next import into the document that was opened", async () => {
    const { e, store } = rig();
    h.reading = opens("D:/jigs/Gear.funda");
    await newFromTemplate(e, "printer");
    h.reading = null;
    await importFileBytes(store, geometry, motor());
    expect(seen(store)).toEqual({
      ...gear,
      features: ["sketch", "extrude", "import"],
      dirty: true,
      imported: ["printer.stpz", "motor.step"],
    });
    expect(h.told).toEqual([dropped("printer.stpz")]);
  });
});

describe("a cancelled import", () => {
  it("opened from Home over a blank document leaves it blank, untitled and clean", async () => {
    const { e, store } = rig();
    store.newDocument();
    h.cancel = true;
    await importFromHome(e, ["motor.step"], () => importFileBytes(store, geometry, motor()));
    expect(seen(store)).toMatchObject({ features: [], name: "Untitled", dirty: false, imported: ["motor.step"] });
    expect(store.canRedo).toBe(true);
  });

  it("into a saved document leaves it as it was saved", async () => {
    const { store } = rig();
    h.cancel = true;
    await importFileBytes(store, geometry, motor());
    expect(seen(store)).toMatchObject({ features: ["sketch", "extrude"], name: "Bracket.funda", dirty: false });
  });

  it("into a document with unsaved work leaves it unsaved", async () => {
    const { store } = rig({ dirty: true });
    h.cancel = true;
    await importFileBytes(store, geometry, motor());
    expect(seen(store)).toMatchObject({ features: ["sketch", "extrude", "sketch"], dirty: true });
  });

  it("keeps the document unsaved when the maker changed it while the import read", async () => {
    const { store } = rig();
    h.cancel = true;
    h.reading = environment;
    await importFileBytes(store, geometry, motor());
    expect(seen(store)).toMatchObject({ features: ["sketch", "extrude"], dirty: true });
  });

  it.each([
    ["the environment", environment],
    ["the material library", material],
  ])("keeps the document unsaved when the maker changed %s after the import landed", async (_what, edit) => {
    const { store } = rig();
    h.cancel = true;
    h.building = edit;
    await importFileBytes(store, geometry, motor());
    expect(h.building).toBeNull();
    expect(seen(store)).toEqual({
      features: ["sketch", "extrude"],
      name: "Bracket.funda",
      path: "D:/jigs/Bracket.funda",
      dirty: true,
      home: true,
      imported: ["motor.step"],
      reported: [],
    });
  });

  it.each([
    ["the environment", environment],
    ["the material library", material],
  ])("keeps the 3D printer example unsaved when the maker changed %s after it landed", async (_what, edit) => {
    const { e, store } = rig();
    h.cancel = true;
    h.building = edit;
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features: [], name: "3D printer", dirty: true, reported: [] });
  });
});

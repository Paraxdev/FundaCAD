import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";
import { cancelledImportPath, importFileBytes, importPath } from "../../src/io/files";

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
  // Files that fail to read even when `land` is set.
  fails: [] as string[],
  cancel: false,
  // The engine stops a read when cancelled, as an open does, unless the read had already finished.
  stopsOnCancel: true,
  hold: {} as Record<string, Promise<void>>,
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
vi.mock("../../src/templates", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/templates")>();
  return {
    ...original,
    TEMPLATES: [
      ...original.TEMPLATES,
      { id: "printer", name: "3D printer", caption: "", hint: "", icon: "assembly", source: "step" },
    ],
    templateFile: (id: string) =>
      h.file ? h.file() : Promise.resolve(new File([new Uint8Array([31, 139])], `${id}.stpz`)),
  };
});

import { hasUnsavedWork, importFromHome, isBlankDocument, newFromTemplate } from "../../src/app/documentActions";

const SAVED: Feature[] = [
  { id: "sk1", type: "sketch", plane: "XZ", entities: [] },
  { id: "ex1", type: "extrude", sketch: "sk1", distance: 7.3, operation: "new" },
] as unknown as Feature[];

const importOf = (doc: CadDocument) => doc.features.find((f) => f.type === "import");

const reads: { cancelled: boolean }[] = [];

async function read(name: string) {
  h.imported.push(name);
  const pending = { cancelled: false };
  reads.push(pending);
  h.reading?.(h.store!);
  await h.hold[name];
  reads.splice(reads.indexOf(pending), 1);
  if (pending.cancelled && h.stopsOnCancel) return { ok: false as const, cancelled: true, message: "cancelled" };
  if (!h.land || h.fails.includes(name)) return { ok: false as const, message: "the file has no solids" };
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
    const top = reads.at(-1);
    if (top) top.cancelled = true;
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
  reads.length = 0;
  Object.assign(h, {
    answers: [],
    asked: [],
    imported: [],
    reported: [],
    told: [],
    reading: null,
    building: null,
    land: true,
    fails: [],
    cancel: false,
    stopsOnCancel: true,
    hold: {},
    file: null,
    store: null,
  });
});

describe("a STEP example", () => {
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

  it("keeps a change made before the build was cancelled, in an untitled document", async () => {
    const { e, store } = rig();
    h.cancel = true;
    h.reading = environment;
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features: [], name: "Untitled", dirty: true });
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

  // The open cancels the read, and the engine says cancelled, unless the read had finished before the cancel landed.
  const replies = [
    ["cancelled", true],
    ["finished", false],
  ] as const;

  const opened = [
    ["clean", false, ["sketch", "extrude"]],
    ["with unsaved work", true, ["sketch", "extrude", "sketch"]],
  ] as const;

  it.each(
    opened.flatMap(([what, dirty, features]) =>
      replies.map(([r, stops]) => [what, r, dirty, features, stops] as const),
    ),
  )("keeps a STEP example out of an opened document %s, its read %s", async (_what, _r, dirty, features, stops) => {
    const { e, store } = rig();
    h.stopsOnCancel = stops;
    h.reading = opens("D:/jigs/Gear.funda", { dirty });
    await newFromTemplate(e, "printer");
    expect(seen(store)).toEqual({ ...gear, features, dirty, imported: ["printer.stpz"] });
    expect(h.told).toEqual([dropped("printer.stpz")]);
  });

  it("keeps a STEP example out of a document opened while its file is fetched", async () => {
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

  const steps = [
    ["a dropped STEP", () => importFileBytes(h.store!, geometry, motor())],
    ["a STEP opened by path", () => importPath(h.store!, geometry, "D:/parts/motor.step")],
  ] as const;

  it.each(steps.flatMap(([how, run]) => replies.map(([reply, stops]) => [how, reply, run, stops] as const)))(
    "keeps %s out of it, its read %s",
    async (_how, _reply, run, stops) => {
      const { store } = rig();
      const retry = cancelledImportPath();
      h.stopsOnCancel = stops;
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
      expect(cancelledImportPath()).toBe(retry);
    },
  );

  it.each(steps)("still lands %s when nothing else was opened", async (_how, run) => {
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
  ])("keeps a STEP example's document unsaved when the maker changed %s after it landed", async (_what, edit) => {
    const { e, store } = rig();
    h.cancel = true;
    h.building = edit;
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features: [], name: "Untitled", dirty: true, reported: [] });
  });
});

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};
function held(name: string) {
  let release!: () => void;
  h.hold[name] = new Promise((r) => (release = r));
  return async () => {
    release();
    await flush();
  };
}
const dropMotor = (e: Engine) => importFromHome(e, ["motor.step"], () => importFileBytes(e.store, geometry, motor()));

describe("a STEP dropped on a blank Home", () => {
  it("leaves a 3D printer example clicked during its read in place when the STEP read ends first", async () => {
    const { e, store } = rig();
    store.newDocument();
    const releaseMotor = held("motor.step");
    const releasePrinter = held("printer.stpz");
    const drop = dropMotor(e);
    await flush();
    new Home({} as HomeCallbacks).open();
    const example = newFromTemplate(e, "printer");
    await flush();
    await releaseMotor();
    await releasePrinter();
    await Promise.all([drop, example]);
    expect(seen(store)).toEqual({
      features: ["import"],
      name: "3D printer",
      path: null,
      dirty: false,
      home: false,
      imported: ["motor.step", "printer.stpz"],
      reported: [],
    });
    expect(h.told).toEqual([dropped("motor.step")]);
  });

  it("leaves an empty saved document opened during its read as it was opened", async () => {
    const { e, store } = rig();
    store.newDocument();
    h.reading = (s) => {
      s.load(JSON.stringify({ parameters: {}, features: [], version: 10 }));
      s.markSaved("D:/jigs/Empty.funda");
    };
    await dropMotor(e);
    expect(seen(store)).toEqual({
      features: [],
      name: "Empty.funda",
      path: "D:/jigs/Empty.funda",
      dirty: false,
      home: false,
      imported: ["motor.step"],
      reported: [],
    });
    expect(h.told).toEqual([dropped("motor.step")]);
  });

  it("goes back to a blank untitled document when its read fails and nothing else was opened", async () => {
    const { e, store } = rig();
    store.newDocument();
    h.land = false;
    await dropMotor(e);
    expect(seen(store)).toEqual({
      features: [],
      name: "Untitled",
      path: null,
      dirty: false,
      home: false,
      imported: ["motor.step"],
      reported: ["Couldn't import motor.step: the file has no solids"],
    });
    expect(h.told).toEqual([]);
  });
});

describe("a STEP example while its file is read", () => {
  it("is not a blank document", async () => {
    const { e } = rig();
    const blank: boolean[] = [];
    h.reading = () => blank.push(isBlankDocument(e));
    await newFromTemplate(e, "printer");
    expect([blank, isBlankDocument(e)]).toEqual([[false], false]);
  });

  it("is blank again once its read failed", async () => {
    const { e } = rig();
    h.land = false;
    await newFromTemplate(e, "printer");
    expect(isBlankDocument(e)).toBe(true);
  });

  it("leaves a new document opened during the read blank", async () => {
    const { e } = rig();
    const blank: boolean[] = [];
    h.reading = (s) => {
      s.newDocument();
      blank.push(isBlankDocument(e));
    };
    await newFromTemplate(e, "printer");
    expect([blank, isBlankDocument(e), h.told]).toEqual([[true], true, [dropped("printer.stpz")]]);
  });

  it.each([
    ["add", { features: ["import", "import"], name: "3D printer", imported: ["printer.stpz", "motor.step"] }, []],
    [
      "new",
      { features: ["import"], name: "motor", imported: ["printer.stpz", "motor.step"] },
      [dropped("printer.stpz")],
    ],
  ])("asks where a STEP dropped on Home goes, answered %s", async (answer, landed, told) => {
    const { e, store } = rig();
    const releasePrinter = held("printer.stpz");
    const example = newFromTemplate(e, "printer");
    await flush();
    new Home({} as HomeCallbacks).open();
    h.answers = [answer];
    const drop = dropMotor(e);
    await flush();
    await releasePrinter();
    await Promise.all([example, drop]);
    expect(h.asked).toEqual(["Add motor.step to 3D printer, or start a new document with it?"]);
    expect(seen(store)).toEqual({ ...landed, path: null, dirty: true, home: false, reported: [] });
    expect(h.told).toEqual(told);
  });
});

describe("an opening import that fails while a file added to its document is still read", () => {
  const dropStep = (e: Engine, name: string) =>
    importFromHome(e, [name], () => importFileBytes(e.store, geometry, new File([new Uint8Array([73])], name)));

  const openings = [
    ["a STEP example", "printer.stpz", (e: Engine) => newFromTemplate(e, "printer")],
    ["a STEP dropped on a blank Home", "a.step", (e: Engine) => (e.store.newDocument(), dropStep(e, "a.step"))],
  ] as const;

  it.each(openings)("keeps the added file, in an untitled document, after %s fails", async (_what, first, open) => {
    const { e, store } = rig();
    h.fails = [first];
    const releaseFirst = held(first);
    const releaseAdded = held("b.step");
    const opening = open(e);
    await flush();
    new Home({} as HomeCallbacks).open();
    h.answers = ["add"];
    const added = dropStep(e, "b.step");
    await flush();
    await releaseFirst();
    await releaseAdded();
    await Promise.all([opening, added]);
    expect(seen(store)).toEqual({
      features: ["import"],
      name: "Untitled",
      path: null,
      dirty: true,
      home: false,
      imported: [first, "b.step"],
      reported: [`Couldn't import ${first}: the file has no solids`],
    });
    expect(h.told).toEqual([]);
  });

  it.each(openings)(
    "keeps the added file, in an untitled document, when %s fails after it",
    async (_what, first, open) => {
      const { e, store } = rig();
      h.fails = [first];
      const releaseFirst = held(first);
      const opening = open(e);
      await flush();
      new Home({} as HomeCallbacks).open();
      h.answers = ["add"];
      await dropStep(e, "b.step");
      await releaseFirst();
      await opening;
      expect(seen(store)).toEqual({
        features: ["import"],
        name: "Untitled",
        path: null,
        dirty: true,
        home: false,
        imported: [first, "b.step"],
        reported: [`Couldn't import ${first}: the file has no solids`],
      });
      expect(h.told).toEqual([]);
    },
  );
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";

const h = vi.hoisted(() => ({
  answers: [] as (string | null)[],
  asked: [] as string[],
  imported: [] as string[],
  reported: [] as string[],
  during: null as null | ((store: DocumentStore) => void),
  land: true,
  file: null as null | (() => Promise<File>),
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async (question: string) => {
    h.asked.push(question);
    return h.answers.shift() ?? null;
  },
}));
vi.mock("../../src/io/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/io/files")>()),
  reportError: async (msg: string) => void h.reported.push(msg),
  // Stands in for the import a dropped file takes: the maker's edit, if any, lands while it reads.
  importFileBytes: async (store: DocumentStore, _g: unknown, file: File) => {
    h.imported.push(file.name);
    h.during?.(store);
    if (!h.land) return void h.reported.push(`Couldn't import ${file.name}: the file has no solids`);
    store.addFeature(IMPORT);
  },
}));
vi.mock("../../src/templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/templates")>()),
  templateFile: (id: string) =>
    h.file ? h.file() : Promise.resolve(new File([new Uint8Array([31, 139])], `${id}.stpz`)),
}));

import { newFromTemplate } from "../../src/app/documentActions";

const IMPORT = { id: "printer", type: "import", format: "step", name: "printer", source: "printer.stpz" } as Feature;
const SAVED: Feature[] = [
  { id: "sk1", type: "sketch", plane: "XZ", entities: [] },
  { id: "ex1", type: "extrude", sketch: "sk1", distance: 7.3, operation: "new" },
] as unknown as Feature[];

const geometry = {
  rebuild: () => new Promise<never>(() => {}),
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
  store.markSaved("D:/jigs/Bracket.funda");
  if (o.dirty) store.addFeature({ id: "sk2", type: "sketch", plane: "XY", entities: [] } as unknown as Feature);
  const resetCamera = vi.fn();
  const e = { store, sketch: { hasUncommittedEdits: false }, viewport: { resetCamera }, geometry } as unknown as Engine;
  return { e, store, resetCamera };
}

function seen(store: DocumentStore) {
  return {
    features: store.document.features.map((f) => f.id),
    name: store.fileName,
    path: store.filePath,
    dirty: store.dirty,
    home: homeIsOpen(),
    imported: h.imported,
    reported: h.reported,
  };
}

beforeEach(() => {
  Object.assign(h, { answers: [], asked: [], imported: [], reported: [], during: null, land: true, file: null });
});

describe("the 3D printer example", () => {
  it("imports printer.stpz once into a new document named after the card, and ends clean", async () => {
    const { e, store, resetCamera } = rig();
    await newFromTemplate(e, "printer");
    expect(seen(store)).toEqual({
      features: ["printer"],
      name: "3D printer",
      path: null,
      dirty: false,
      home: false,
      imported: ["printer.stpz"],
      reported: [],
    });
    expect(resetCamera.mock.calls).toEqual([[false]]);
    expect(h.asked).toEqual([]);
  });

  it("stays dirty when the maker adds a feature while the import runs", async () => {
    const { e, store } = rig();
    h.during = (s) => s.addFeature({ id: "sk3", type: "sketch", plane: "YZ", entities: [] } as unknown as Feature);
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features: ["sk3", "printer"], name: "3D printer", dirty: true });
  });

  it("stays dirty when the maker changes something that is no feature while the import runs", async () => {
    const { e, store } = rig();
    h.during = (s) => s.setDocumentEnvironment({ preset: "studio" } as never);
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features: ["printer"], dirty: true });
  });

  it("stays dirty when an open sketch has edits once the import is in", async () => {
    const { e, store } = rig();
    h.during = () => void ((e.sketch as { hasUncommittedEdits: boolean }).hasUncommittedEdits = true);
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ features: ["printer"], dirty: true });
  });

  it("leaves a document opened during the import alone", async () => {
    const { e, store } = rig();
    h.during = (s) => {
      s.load(JSON.stringify({ parameters: {}, features: SAVED, version: 10 }));
      s.markSaved("D:/jigs/Gear.funda");
      s.addFeature({ id: "sk4", type: "sketch", plane: "XY", entities: [] } as unknown as Feature);
    };
    await newFromTemplate(e, "printer");
    expect(seen(store)).toMatchObject({ name: "Gear.funda", path: "D:/jigs/Gear.funda", dirty: true });
  });

  it("asks before replacing unsaved work and does nothing when refused", async () => {
    const { e, store } = rig({ dirty: true });
    h.answers = ["cancel"];
    await newFromTemplate(e, "printer");
    expect(h.asked).toEqual(["Discard unsaved changes and start a new document?"]);
    expect(seen(store)).toEqual({
      features: ["sk1", "ex1", "sk2"],
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
    expect(seen(store)).toMatchObject({ features: ["printer"], name: "3D printer", dirty: false });
  });

  it("keeps the empty document and shows the error when the import fails", async () => {
    const { e, store } = rig();
    h.land = false;
    await expect(newFromTemplate(e, "printer")).resolves.toBeUndefined();
    expect(seen(store)).toEqual({
      features: [],
      name: "3D printer",
      path: null,
      dirty: false,
      home: false,
      imported: ["printer.stpz"],
      reported: ["Couldn't import printer.stpz: the file has no solids"],
    });
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

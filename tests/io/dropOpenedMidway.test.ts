import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";

vi.stubGlobal("window", globalThis);

const h = vi.hoisted(() => ({
  answers: [] as (string | null)[],
  read: [] as string[],
  reported: [] as string[],
  told: [] as string[],
  // What the maker does while the named file is read, and which files fail to read.
  reading: {} as Record<string, (store: DocumentStore) => void>,
  unreadable: [] as string[],
  store: null as null | DocumentStore,
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async () => h.answers.shift() ?? null,
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (msg: string, o: { kind?: string } = {}) => void (o.kind === "error" ? h.reported : h.told).push(msg),
}));
vi.mock("../../src/ui/environmentImport", () => ({
  importEnvironmentFile: async (_s: unknown, file: File) => {
    h.read.push(file.name);
    h.reading[file.name]?.(h.store!);
    return null;
  },
}));

import { takeDroppedFiles, type DroppedFile } from "../../src/io/desktopDrop";

const SAVED: Feature[] = [
  { id: "sk1", type: "sketch", plane: "XZ", entities: [] },
  { id: "ex1", type: "extrude", sketch: "sk1", distance: 7.3, operation: "new" },
] as unknown as Feature[];

async function read(name: string) {
  h.read.push(name);
  h.reading[name]?.(h.store!);
  if (h.unreadable.includes(name)) return { ok: false as const, message: "the file has no solids" };
  return { ok: true as const, name, geom: "brep", solid: true };
}

const geometry = {
  async rebuild() {
    const result: RebuildResult = {
      mesh: { positions: [], indices: [], faceIds: [] },
      edges: [],
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      bodies: [],
    };
    return { ok: true as const, result };
  },
  importBytes: async (name: string) => read(name),
  importGeometry: async (path: string) => read(path.split("/").pop()!),
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
  async cancel() {
    return true;
  },
} as unknown as GeometryBackend;

function rig(homeUp: boolean) {
  setActivePinia(createPinia());
  const home = new Home({} as HomeCallbacks);
  if (homeUp) home.open();
  const store = new DocumentStore(geometry, { parameters: {}, features: SAVED } as unknown as CadDocument);
  h.store = store;
  store.markSaved("D:/jigs/Bracket.funda");
  const e = {
    store,
    geometry,
    sketch: { active: false, hasUncommittedEdits: false },
    viewport: { resetCamera: () => {} },
  } as unknown as Engine;
  return { e, store };
}

function seen(store: DocumentStore) {
  return {
    features: store.document.features.map((f) => f.type),
    name: store.fileName,
    dirty: store.dirty,
    home: homeIsOpen(),
    read: h.read,
    reported: h.reported,
    told: h.told,
  };
}

const opensGear = (s: DocumentStore) => {
  s.load(JSON.stringify({ parameters: {}, features: SAVED, version: 10 }));
  s.markSaved("D:/jigs/Gear.funda");
};

const step = (name: string): DroppedFile => ({ name, path: `D:/parts/${name}` });
const bytes = (name: string): DroppedFile => ({ name, path: null, file: new File([new Uint8Array([73])], name) });
const hdri = (name: string): DroppedFile => ({ name, path: null, file: new File(["x"], name) });

beforeEach(() => {
  Object.assign(h, { answers: [], read: [], reported: [], told: [], reading: {}, unreadable: [], store: null });
});

// The maker reaches the drop with Home closed, or over Home answering Add to or New document.
const ways = [
  ["with Home closed", false, []],
  ["over Home, added to the document", true, ["add"]],
  ["over Home, into a new document", true, ["new"]],
] as const;

const gear = { features: ["sketch", "extrude"], name: "Gear.funda", dirty: false, home: false, reported: [] };

describe("a drop of several files when another document is opened while the first is read", () => {
  it.each(ways)("leaves the rest out of it %s, named in one warning", async (_way, homeUp, answers) => {
    const { e, store } = rig(homeUp);
    h.answers = [...answers];
    h.reading["a.step"] = opensGear;
    await takeDroppedFiles(e, [step("a.step"), step("b.step")]);
    expect(seen(store)).toEqual({
      ...gear,
      read: ["a.step"],
      told: ["a.step and b.step were not imported, another document was opened while they were read."],
    });
  });

  it("leaves dropped bytes and the environment out too", async () => {
    const { e, store } = rig(false);
    h.reading["a.step"] = opensGear;
    await takeDroppedFiles(e, [bytes("a.step"), bytes("b.stl"), hdri("studio.hdr")]);
    expect(seen(store)).toEqual({
      ...gear,
      read: ["a.step"],
      told: ["a.step, b.stl and studio.hdr were not imported, another document was opened while they were read."],
    });
  });

  it("names only the files after it when the one being read failed anyway", async () => {
    const { e, store } = rig(false);
    h.reading["a.step"] = opensGear;
    h.unreadable = ["a.step"];
    await takeDroppedFiles(e, [step("a.step"), step("b.step")]);
    expect(seen(store)).toEqual({
      ...gear,
      read: ["a.step"],
      reported: ["Couldn't import a.step: the file has no solids"],
      told: ["b.step was not imported, another document was opened while it was read."],
    });
  });

  it("keeps what landed before the open in the first document and leaves the rest out", async () => {
    const { e, store } = rig(false);
    let before: string[] = [];
    h.reading["b.step"] = (s) => {
      before = s.document.features.map((f) => f.type);
      opensGear(s);
    };
    await takeDroppedFiles(e, [step("a.step"), step("b.step"), step("c.step")]);
    expect(before).toEqual(["sketch", "extrude", "import"]);
    expect(seen(store)).toEqual({
      ...gear,
      read: ["a.step", "b.step"],
      told: ["b.step and c.step were not imported, another document was opened while they were read."],
    });
  });

  it("leaves the environment out when the document is opened while it is the one read", async () => {
    const { e, store } = rig(false);
    h.reading["b.step"] = opensGear;
    await takeDroppedFiles(e, [step("b.step"), hdri("studio.hdr")]);
    expect(seen(store)).toEqual({
      ...gear,
      read: ["b.step"],
      told: ["b.step and studio.hdr were not imported, another document was opened while they were read."],
    });
  });
});

describe("a drop of several files when nothing else is opened", () => {
  it.each(ways)("lands every file in the document %s, with no warning", async (_way, homeUp, answers) => {
    const { e, store } = rig(homeUp);
    h.answers = [...answers];
    await takeDroppedFiles(e, [step("a.step"), step("b.step"), hdri("studio.hdr")]);
    const intoNew = answers[0] === "new";
    expect(seen(store)).toEqual({
      features: intoNew ? ["import", "import"] : ["sketch", "extrude", "import", "import"],
      name: intoNew ? "a" : "Bracket.funda",
      dirty: true,
      home: false,
      read: ["a.step", "b.step", "studio.hdr"],
      reported: [],
      told: [],
    });
  });
});

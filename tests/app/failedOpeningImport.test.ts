import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";
import { importFileBytes, importInTurn } from "../../src/io/files";

vi.stubGlobal("window", globalThis);

const h = vi.hoisted(() => ({
  answers: [] as (string | null)[],
  asked: [] as string[],
  imported: [] as string[],
  reported: [] as string[],
  told: [] as string[],
  fails: [] as string[],
  hold: {} as Record<string, Promise<void>>,
  // The unit question of a glTF stays up until the test answers it.
  unitAnswered: null as null | Promise<void>,
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async (question: string) => {
    h.asked.push(question);
    if (question.startsWith("What unit") && h.unitAnswered) await h.unitAnswered;
    return h.answers.shift() ?? null;
  },
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (msg: string, o: { kind?: string } = {}) => void (o.kind === "error" ? h.reported : h.told).push(msg),
}));
vi.mock("../../src/templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/templates")>()),
  templateFile: (id: string) => Promise.resolve(new File([new Uint8Array([31, 139])], `${id}.stpz`)),
}));

import { importFromHome, isBlankDocument, newFromTemplate } from "../../src/app/documentActions";

const SAVED: Feature[] = [
  { id: "sk1", type: "sketch", plane: "XZ", entities: [] },
  { id: "ex1", type: "extrude", sketch: "sk1", distance: 7.3, operation: "new" },
] as unknown as Feature[];

const importOf = (doc: CadDocument) => doc.features.find((f) => f.type === "import");

async function read(name: string) {
  h.imported.push(name);
  await h.hold[name];
  if (h.fails.includes(name)) return { ok: false as const, message: "the file has no solids" };
  return { ok: true as const, name, geom: "brep", solid: true };
}

const geometry = {
  async rebuild(doc: CadDocument) {
    const imp = importOf(doc);
    const result: RebuildResult = {
      mesh: { positions: [], indices: [], faceIds: [] },
      edges: [],
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      bodies: imp ? [{ id: "body3", name: "Frame", faceStart: 0, faceCount: 6, faceOwners: [imp.id] }] : [],
    };
    return { ok: true as const, result };
  },
  importBytes: async (name: string) => read(name),
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
  cancel: async () => true,
} as unknown as GeometryBackend;

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
function unitQuestion() {
  let answer!: () => void;
  h.unitAnswered = new Promise((r) => (answer = r));
  return async () => {
    answer();
    await flush();
  };
}

function rig() {
  setActivePinia(createPinia());
  new Home({} as HomeCallbacks).open();
  const store = new DocumentStore(geometry, { parameters: {}, features: SAVED } as unknown as CadDocument);
  store.markSaved("D:/jigs/Bracket.funda");
  const e = {
    store,
    sketch: { active: false, hasUncommittedEdits: false },
    viewport: { resetCamera: () => {} },
    geometry,
    frameNextModel: () => {},
  } as unknown as Engine;
  return { e, store };
}

const fileOf = (name: string) => new File([new Uint8Array([73])], name);
const add = (store: DocumentStore, name: string) => importFileBytes(store, geometry, fileOf(name));
const dropOnHome = (e: Engine, name: string) => importFromHome(e, [name], () => add(e.store, name));

const seen = (store: DocumentStore) => ({
  features: store.document.features.map((f) => f.type),
  name: store.fileName,
  path: store.filePath,
  dirty: store.dirty,
  home: homeIsOpen(),
  imported: h.imported,
  reported: h.reported,
  told: h.told,
});

const failed = (name: string) => `Couldn't import ${name}: the file has no solids`;
const dropped = (name: string) => `${name} was not imported, another document was opened while it was read.`;

beforeEach(() => {
  Object.assign(h, {
    answers: [],
    asked: [],
    imported: [],
    reported: [],
    told: [],
    fails: [],
    hold: {},
    unitAnswered: null,
  });
});

const openings = [
  ["the 3D printer example", "printer.stpz", (e: Engine) => newFromTemplate(e, "printer")],
  ["a STEP dropped on a blank Home", "a.step", (e: Engine) => (e.store.newDocument(), dropOnHome(e, "a.step"))],
] as const;

describe("an opening import whose read fails", () => {
  it.each(openings)("after %s keeps a glTF added during the read that still asks its unit", async (_w, first, open) => {
    const { e, store } = rig();
    h.fails = [first];
    const endFirst = held(first);
    const opening = open(e);
    await flush();
    const answerUnit = unitQuestion();
    h.answers = ["mm"];
    const added = add(store, "b.glb");
    await flush();
    await endFirst();
    await answerUnit();
    await Promise.all([opening, added]);
    expect(seen(store)).toEqual({
      features: ["import"],
      name: "Untitled",
      path: null,
      dirty: true,
      home: false,
      imported: [first, "b.glb"],
      reported: [failed(first)],
      told: [],
    });
  });

  it.each(openings)("after %s keeps the rest of a batch added during the read", async (_w, first, open) => {
    const { e, store } = rig();
    h.fails = [first, "b.step"];
    const endFirst = held(first);
    const opening = open(e);
    await flush();
    const answerUnit = unitQuestion();
    h.answers = ["mm"];
    const batch = importInTurn(store, [
      { name: "b.step", run: () => importFileBytes(store, geometry, fileOf("b.step"), undefined, { batched: true }) },
      { name: "c.glb", run: () => importFileBytes(store, geometry, fileOf("c.glb"), undefined, { batched: true }) },
    ]);
    await flush();
    await endFirst();
    await answerUnit();
    await Promise.all([opening, batch]);
    expect(seen(store)).toEqual({
      features: ["import"],
      name: "Untitled",
      path: null,
      dirty: true,
      home: false,
      imported: [first, "b.step", "c.glb"],
      reported: [failed("b.step"), failed(first)],
      told: [],
    });
  });

  it.each(openings)("after %s leaves a sketch started during the read open", async (_w, first, open) => {
    const { e, store } = rig();
    h.fails = [first];
    const endFirst = held(first);
    const opening = open(e);
    await flush();
    (e.sketch as { active: boolean }).active = true;
    let opens = 0;
    store.onOpen(() => opens++);
    await endFirst();
    await opening;
    expect({ opens, ...seen(store) }).toEqual({
      opens: 0,
      features: [],
      name: "Untitled",
      path: null,
      dirty: false,
      home: false,
      imported: [first],
      reported: [failed(first)],
      told: [],
    });
  });

  it.each(openings)("after %s leaves an untouched document as a new one would be", async (_w, first, open) => {
    const { e, store } = rig();
    h.fails = [first];
    const endFirst = held(first);
    const opening = open(e);
    await flush();
    let opens = 0;
    store.onOpen(() => opens++);
    await endFirst();
    await opening;
    const fresh = new DocumentStore(geometry, { parameters: {}, features: SAVED } as unknown as CadDocument);
    fresh.newDocument();
    const state = (s: DocumentStore) => ({
      saved: JSON.parse(s.toJSON()) as unknown,
      name: s.fileName,
      path: s.filePath,
      dirty: s.dirty,
      undo: s.canUndo,
      redo: s.canRedo,
    });
    expect({ opens, blank: isBlankDocument(e), ...state(store) }).toEqual({ opens: 0, blank: true, ...state(fresh) });
  });
});

describe("a Home drop while a file added to a failed opening import is still read", () => {
  it.each([
    ["add", { features: ["import", "import"], name: "Untitled", told: [] }],
    ["new", { features: ["import"], name: "c", told: [dropped("b.step")] }],
  ])("asks where it goes, answered %s", async (answer, landed) => {
    const { e, store } = rig();
    store.newDocument();
    h.fails = ["a.step"];
    const endFirst = held("a.step");
    const endAdded = held("b.step");
    const opening = dropOnHome(e, "a.step");
    await flush();
    const added = add(store, "b.step");
    await flush();
    await endFirst();
    await opening;
    const blankWhileRead = isBlankDocument(e);
    new Home({} as HomeCallbacks).open();
    h.answers = [answer];
    const third = dropOnHome(e, "c.step");
    await flush();
    await endAdded();
    await Promise.all([added, third]);
    expect({ blankWhileRead, asked: h.asked, ...seen(store) }).toEqual({
      blankWhileRead: false,
      asked: ["Add c.step to Untitled, or start a new document with it?"],
      ...landed,
      path: null,
      dirty: true,
      home: false,
      imported: ["a.step", "b.step", "c.step"],
      reported: [failed("a.step")],
    });
  });
});

describe("a document while a file is read into it", () => {
  it("is not blank, and is again once the read ended without a feature", async () => {
    const { e, store } = rig();
    store.newDocument();
    h.fails = ["x.step"];
    const end = held("x.step");
    const reading = add(store, "x.step");
    await flush();
    const during = { blank: isBlankDocument(e), running: store.importRunning };
    await end();
    await reading;
    expect({ during, after: { blank: isBlankDocument(e), running: store.importRunning } }).toEqual({
      during: { blank: false, running: true },
      after: { blank: true, running: false },
    });
  });

  it("counts only the reads begun since the last open, as an open drops the others", async () => {
    const { e, store } = rig();
    store.newDocument();
    const endOld = held("x.step");
    const old = add(store, "x.step");
    await flush();
    store.newDocument();
    const afterOpen = { blank: isBlankDocument(e), running: store.importRunning };
    const endNew = held("y.step");
    const fresh = add(store, "y.step");
    await flush();
    const newRead = { blank: isBlankDocument(e), running: store.importRunning };
    await endOld();
    const oldEnded = store.importRunning;
    await endNew();
    await Promise.all([old, fresh]);
    expect({ afterOpen, newRead, oldEnded, running: store.importRunning, told: h.told }).toEqual({
      afterOpen: { blank: true, running: false },
      newRead: { blank: false, running: true },
      oldEnded: true,
      running: false,
      told: [dropped("x.step")],
    });
  });
});

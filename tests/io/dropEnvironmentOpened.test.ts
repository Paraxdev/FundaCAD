import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";
import { encodeRgbe } from "../../src/viewport/hdrImage";
import { createEnvLibrary, memoryKv, type KvStore } from "../../src/ui/environmentLibrary";
import { installEnvironmentSync, useEnvLibrary } from "../../src/ui/environmentImport";
import { renderPrefs, setRenderPref } from "../../src/ui/renderPrefs";

vi.stubGlobal("window", globalThis);

const h = vi.hoisted(() => ({
  answers: [] as string[],
  reported: [] as string[],
  told: [] as string[],
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async () => h.answers.shift() ?? null,
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (msg: string, o: { kind?: string } = {}) => void (o.kind === "error" ? h.reported : h.told).push(msg),
}));

import { takeDroppedFiles } from "../../src/io/desktopDrop";

const SAVED: Feature[] = [
  { id: "sk1", type: "sketch", plane: "XZ", entities: [] },
  { id: "ex1", type: "extrude", sketch: "sk1", distance: 7.3, operation: "new" },
] as unknown as Feature[];

// A read waits for the test to let it end, and fails when told to.
const reading = { done: Promise.resolve(), fails: false };
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
  importGeometry: async (path: string) => {
    await reading.done;
    if (reading.fails) return { ok: false as const, message: "the file has no solids" };
    return { ok: true as const, name: path, geom: "brep", solid: true };
  },
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
  cancel: async () => true,
} as unknown as GeometryBackend;

function studio(): File {
  const w = 8;
  const data = new Float32Array(w * 4 * 4).fill(0.5);
  return new File([encodeRgbe({ width: w, height: 4, data }) as Uint8Array<ArrayBuffer>], "studio.hdr");
}

// The library keeps the panorama only once the test lets it, and says when it got there.
let storing: { reach: () => void; gate: Promise<void> } | null = null;
function heldKv(): KvStore {
  const kv = memoryKv();
  return {
    ...kv,
    put: async (table, key, value) => {
      if (table === "hdrs" && storing) {
        storing.reach();
        await storing.gate;
      }
      return kv.put(table, key, value);
    },
  };
}
function holdStoring() {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  storing = { reach, gate: new Promise<void>((r) => (open = r)) };
  return { reached, open };
}

let offSync: () => void = () => {};

function rig(homeUp: boolean) {
  setActivePinia(createPinia());
  const home = new Home({} as HomeCallbacks);
  if (homeUp) home.open();
  const store = new DocumentStore(geometry, { parameters: {}, features: SAVED } as unknown as CadDocument);
  store.markSaved("D:/jigs/Bracket.funda");
  offSync = installEnvironmentSync(store);
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
    environment: store.documentEnvironment?.hdr?.name ?? null,
    look: renderPrefs().environment.startsWith("hdr:") ? "panorama" : renderPrefs().environment,
    home: homeIsOpen(),
    reported: h.reported,
    told: h.told,
  };
}

const opensGear = (s: DocumentStore) => {
  s.load(JSON.stringify({ parameters: {}, features: SAVED, version: 10 }));
  s.markSaved("D:/jigs/Gear.funda");
};

const ways = [
  ["with Home closed", false, []],
  ["over Home, added to the document", true, ["add"]],
  ["over Home, into a new document", true, ["new"]],
] as const;

beforeEach(() => {
  Object.assign(h, { answers: [], reported: [], told: [] });
  storing = null;
  Object.assign(reading, { done: Promise.resolve(), fails: false });
  setRenderPref("environment", "studio");
  useEnvLibrary(createEnvLibrary(heldKv()));
});

afterEach(() => {
  offSync();
  useEnvLibrary(null);
  setRenderPref("environment", "studio");
});

describe("the environment at the end of a dropped batch", () => {
  it.each(ways)("is left out of a document opened while its panorama is stored, %s", async (_way, homeUp, answers) => {
    const { e, store } = rig(homeUp);
    h.answers = [...answers];
    const held = holdStoring();
    const drop = takeDroppedFiles(e, [
      { name: "a.step", path: "D:/parts/a.step" },
      { name: "studio.hdr", file: studio() },
    ]);
    await held.reached;
    opensGear(store);
    held.open();
    await drop;
    // The look a document carries is written after the open, in its own turn.
    await new Promise((r) => setTimeout(r, 0));
    expect(seen(store)).toEqual({
      features: ["sketch", "extrude"],
      name: "Gear.funda",
      dirty: false,
      environment: null,
      look: "studio",
      home: false,
      reported: [],
      told: ["studio.hdr was not imported, another document was opened while it was read."],
    });
  });

  it.each(ways)(
    "lights the document it was dropped on when nothing else is opened, %s",
    async (_way, homeUp, answers) => {
      const { e, store } = rig(homeUp);
      h.answers = [...answers];
      await takeDroppedFiles(e, [
        { name: "a.step", path: "D:/parts/a.step" },
        { name: "studio.hdr", file: studio() },
      ]);
      const intoNew = answers[0] === "new";
      expect(seen(store)).toEqual({
        features: intoNew ? ["import"] : ["sketch", "extrude", "import"],
        name: intoNew ? "a" : "Bracket.funda",
        dirty: true,
        environment: "studio.hdr",
        look: "panorama",
        home: false,
        reported: [],
        told: [],
      });
    },
  );
});

const dropped = (name: string) => `${name} was not imported, another document was opened while it was read.`;

describe("an environment dropped on its own", () => {
  it("is left out of a document opened while the environment code loads", async () => {
    const { e, store } = rig(false);
    const drop = takeDroppedFiles(e, [{ name: "studio.hdr", file: studio() }]);
    opensGear(store);
    await drop;
    await new Promise((r) => setTimeout(r, 0));
    expect(seen(store)).toEqual({
      features: ["sketch", "extrude"],
      name: "Gear.funda",
      dirty: false,
      environment: null,
      look: "studio",
      home: false,
      reported: [],
      told: [dropped("studio.hdr")],
    });
  });

  it.each([
    ["fails", true, { features: [], name: "Untitled", reported: ["Couldn't import a.step: the file has no solids"] }],
    ["lands", false, { features: ["import"], name: "a", reported: [] }],
  ])(
    "lights the document a STEP dropped on a blank Home is opening when that read %s while the panorama is stored",
    async (_end, fails, after) => {
      const { e, store } = rig(true);
      store.newDocument();
      let endRead!: () => void;
      reading.done = new Promise((r) => (endRead = r));
      reading.fails = fails;
      const opening = takeDroppedFiles(e, [{ name: "a.step", path: "D:/parts/a.step" }]);
      await new Promise((r) => setTimeout(r, 0));
      const held = holdStoring();
      const lighting = takeDroppedFiles(e, [{ name: "studio.hdr", file: studio() }]);
      await held.reached;
      endRead();
      await opening;
      held.open();
      await lighting;
      await new Promise((r) => setTimeout(r, 0));
      expect(seen(store)).toEqual({
        ...after,
        dirty: true,
        environment: "studio.hdr",
        look: "panorama",
        home: false,
        told: [],
      });
    },
  );
});

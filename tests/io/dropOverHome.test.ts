import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";

const h = vi.hoisted(() => ({
  events: [] as string[],
  answers: [] as (string | null)[],
  store: null as unknown as { addFeature: (f: never) => void },
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async () => {
    h.events.push("ask");
    return h.answers.shift() ?? null;
  },
}));
vi.mock("../../src/io/files", async (orig) => ({
  ...(await orig<typeof import("../../src/io/files")>()),
  importPath: async (_s: unknown, _g: unknown, path: string) => {
    h.events.push(`import ${path}`);
    const name = path.split("/").pop()!.split(".")[0]!;
    h.store.addFeature({ id: `imp_${name}`, type: "import", format: "step", name, source: path } as never);
  },
  importFileBytes: async (_s: unknown, _g: unknown, file: File) => void h.events.push(`import bytes ${file.name}`),
  openDocumentAtPath: async (_s: unknown, path: string) => {
    h.events.push(`open ${path}`);
    return "ok";
  },
  openDocumentBytes: async () => "ok",
  openDocument: async () => {},
  reportError: async (m: string) => void h.events.push(`error: ${m}`),
}));
vi.mock("../../src/ui/environmentImport", () => ({
  importEnvironmentFile: async (_s: unknown, file: File) => {
    h.events.push(`environment ${file.name}`);
    return null;
  },
}));

import { takeDroppedFiles, type DroppedFile } from "../../src/io/desktopDrop";

const geometry = {
  rebuild: () => new Promise<never>(() => {}),
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
  async cancel() {
    return true;
  },
} as unknown as GeometryBackend;

const WORK = [
  { id: "sk1", type: "sketch", plane: "XZ", entities: [] },
  { id: "ex1", type: "extrude", sketch: "sk1", distance: 4.7 },
] as unknown as Feature[];

function rig(o: { homeUp?: boolean; blank?: boolean } = {}) {
  setActivePinia(createPinia());
  const home = new Home({} as HomeCallbacks);
  if (o.homeUp ?? true) home.open();
  const store = new DocumentStore(geometry, {
    parameters: {},
    features: o.blank ? [] : WORK,
  } as unknown as CadDocument);
  if (!o.blank) store.markSaved("E:/jigs/Bracket.funda");
  h.store = store;
  const e = {
    store,
    geometry,
    sketch: { active: false, hasUncommittedEdits: false },
    viewport: { resetCamera: () => void h.events.push("reset camera") },
  } as unknown as Engine;
  return { e, store };
}

const step = (name: string, dir = "D:/downloads"): DroppedFile => ({ name, path: `${dir}/${name}` });
const hdri = (name: string): DroppedFile => ({ name, path: null, file: new File(["x"], name) });
const ids = (store: DocumentStore) => store.document.features.map((f) => f.id);

beforeEach(() => {
  h.events = [];
  h.answers = [];
});

describe("a drop over Home", () => {
  it("asks once for two parts over work and puts both in the new document, in drop order", async () => {
    const { e, store } = rig();
    h.answers = ["new"];
    await takeDroppedFiles(e, [step("motor.step"), step("rail.stp", "D:/cad")]);
    expect(h.events).toEqual(["ask", "reset camera", "import D:/downloads/motor.step", "import D:/cad/rail.stp"]);
    expect([ids(store), store.fileName, homeIsOpen()]).toEqual([["imp_motor", "imp_rail"], "motor", false]);
  });

  it("fills a blank document with no question", async () => {
    const { e, store } = rig({ blank: true });
    await takeDroppedFiles(e, [step("printer.step")]);
    expect(h.events).toEqual(["import D:/downloads/printer.step"]);
    expect([ids(store), store.fileName]).toEqual([["imp_printer"], "printer"]);
  });

  it("drops everything on Cancel", async () => {
    const { e, store } = rig();
    h.answers = ["cancel"];
    await takeDroppedFiles(e, [step("motor.step"), hdri("studio.hdr")]);
    expect(h.events).toEqual(["ask"]);
    expect([ids(store), homeIsOpen()]).toEqual([["sk1", "ex1"], true]);
  });

  it("opens a dropped document as before and puts the part in it", async () => {
    const { e } = rig();
    await takeDroppedFiles(e, [step("motor.step"), step("frame.funda", "E:/jigs")]);
    expect(h.events).toEqual(["open E:/jigs/frame.funda", "import D:/downloads/motor.step"]);
    expect(homeIsOpen()).toBe(false);
  });

  it("applies an environment alone with no question", async () => {
    const { e, store } = rig();
    await takeDroppedFiles(e, [hdri("studio.hdr")]);
    expect(h.events).toEqual(["environment studio.hdr"]);
    expect([ids(store), homeIsOpen()]).toEqual([["sk1", "ex1"], false]);
  });

  it("takes an environment along with the part into a new document", async () => {
    const { e, store } = rig();
    h.answers = ["new"];
    await takeDroppedFiles(e, [hdri("studio.hdr"), step("motor.step")]);
    expect(h.events).toEqual(["ask", "reset camera", "import D:/downloads/motor.step", "environment studio.hdr"]);
    expect(ids(store)).toEqual(["imp_motor"]);
  });
});

describe("a drop with Home closed", () => {
  it("imports into the open document with no question", async () => {
    const { e, store } = rig({ homeUp: false });
    await takeDroppedFiles(e, [step("motor.step")]);
    expect(h.events).toEqual(["import D:/downloads/motor.step"]);
    expect([ids(store), store.fileName]).toEqual([["sk1", "ex1", "imp_motor"], "Bracket.funda"]);
  });
});

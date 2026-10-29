// A document read to replace the open one takes Rust and engine time. Whatever happens to the open document while
// it reads, a New, another Open or an edit, must not be thrown away by the slow read landing late.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { Feature } from "../../src/types";

const host = vi.hoisted(() => ({
  reads: [] as { path: string; release: (text: string) => void }[],
  toasts: [] as { message: string; kind: string | undefined }[],
  asked: [] as string[],
  answer: "discard" as string | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { path: string }) => {
    if (cmd === "container_is_container") return Promise.resolve(true);
    return new Promise((resolve) =>
      host.reads.push({
        path: args.path,
        release: (document: string) => resolve({ document, repairedShards: 0, usedBackupIndex: false }),
      }),
    );
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: async () => {} }));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, opts: { kind?: string } = {}) => host.toasts.push({ message, kind: opts.kind }),
  dismissToast: () => {},
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async (title: string) => {
    host.asked.push(title);
    return host.answer;
  },
}));
vi.mock("../../src/io/recentFiles", () => ({ noteRecent() {}, forgetRecent() {}, getRecentFiles: () => [] }));
vi.mock("../../src/io/recovery", () => ({ clearRecovery: async () => {} }));
vi.mock("../../src/io/thumbnails", () => ({
  captureAfterOpen() {},
  captureThumbnail: async () => null,
  storeThumbnail: async () => {},
}));

const docText = (param: string) => JSON.stringify({ version: 9, parameters: { [param]: 1 }, features: [] });

function setup(features: Feature[] = []) {
  const geometry = {
    async rebuild() {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
  const store = new DocumentStore(geometry, { parameters: {}, features });
  store.markSaved("D:/work/Bracket.funda");
  return { store };
}

async function reading(path: string) {
  await vi.waitFor(() => expect(host.reads.some((r) => r.path === path)).toBe(true));
  return host.reads.find((r) => r.path === path)!;
}

function state(store: DocumentStore) {
  return {
    parameters: store.document.parameters,
    path: store.filePath,
    dirty: store.dirty,
    toasts: host.toasts,
    asked: host.asked,
  };
}

// The leak check every test ends with: another document opened afterwards is exactly that document.
async function opensNextCleanly(store: DocumentStore) {
  const { openDocumentAtPath } = await import("../../src/io/files");
  const before = { toasts: [...host.toasts], asked: [...host.asked] };
  const next = openDocumentAtPath(store, "D:/work/Cog.funda");
  (await reading("D:/work/Cog.funda")).release(docText("cog"));
  expect({ outcome: await next, ...state(store) }).toEqual({
    outcome: "ok",
    parameters: { cog: 1 },
    path: "D:/work/Cog.funda",
    dirty: false,
    ...before,
  });
}

describe("a document still being read when the open one changes", () => {
  beforeEach(() => {
    host.reads = [];
    host.toasts = [];
    host.asked = [];
    host.answer = "discard";
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });

  it("opens with no question when nothing changed while it read", async () => {
    const { openDocumentAtPath } = await import("../../src/io/files");
    const { store } = setup();
    const p = openDocumentAtPath(store, "D:/work/Gear.funda");
    (await reading("D:/work/Gear.funda")).release(docText("gear"));
    expect({ outcome: await p, ...state(store) }).toEqual({
      outcome: "ok",
      parameters: { gear: 1 },
      path: "D:/work/Gear.funda",
      dirty: false,
      toasts: [],
      asked: [],
    });
    await opensNextCleanly(store);
  });

  it("is not opened over a New made while it read, and says so", async () => {
    const { openDocumentAtPath } = await import("../../src/io/files");
    const { store } = setup();
    const p = openDocumentAtPath(store, "D:/work/Gear.funda");
    const read = await reading("D:/work/Gear.funda");
    store.newDocument();
    store.setParam("drawn", 4);
    read.release(docText("gear"));
    expect({ outcome: await p, ...state(store) }).toEqual({
      outcome: "dropped",
      parameters: { drawn: 4 },
      path: null,
      dirty: true,
      toasts: [{ message: "Gear.funda was not opened, another document was started while it was read.", kind: "info" }],
      asked: [],
    });
    host.answer = "discard";
    await opensNextCleanly(store);
  });

  it("gives way to a later open, silently, whichever read finishes first", async () => {
    const { openDocumentAtPath } = await import("../../src/io/files");
    for (const firstDone of ["earlier", "later"] as const) {
      host.reads = [];
      const { store } = setup();
      const earlier = openDocumentAtPath(store, "D:/work/Gear.funda");
      const gear = await reading("D:/work/Gear.funda");
      const later = openDocumentAtPath(store, "D:/work/Wheel.funda");
      const wheel = await reading("D:/work/Wheel.funda");
      if (firstDone === "earlier") {
        gear.release(docText("gear"));
        expect(await earlier).toBe("dropped");
        wheel.release(docText("wheel"));
      } else {
        wheel.release(docText("wheel"));
        expect(await later).toBe("ok");
        gear.release(docText("gear"));
      }
      expect({ firstDone, outcomes: [await earlier, await later], ...state(store) }).toEqual({
        firstDone,
        outcomes: ["dropped", "ok"],
        parameters: { wheel: 1 },
        path: "D:/work/Wheel.funda",
        dirty: false,
        toasts: [],
        asked: [],
      });
      await opensNextCleanly(store);
    }
  });

  it("asks again about an edit made while it read, and keeps the edit on Cancel", async () => {
    const { openDocumentAtPath } = await import("../../src/io/files");
    const { store } = setup();
    host.answer = "cancel";
    const p = openDocumentAtPath(store, "D:/work/Gear.funda");
    const read = await reading("D:/work/Gear.funda");
    store.setParam("width", 30);
    read.release(docText("gear"));
    expect({ outcome: await p, ...state(store) }).toEqual({
      outcome: "dropped",
      parameters: { width: 30 },
      path: "D:/work/Bracket.funda",
      dirty: true,
      toasts: [],
      asked: ["Bracket.funda changed while Gear.funda was read. Discard those changes and open Gear.funda?"],
    });
    host.answer = "discard";
    await opensNextCleanly(store);
  });

  it("opens over an edit made while it read once the user says Discard", async () => {
    const { openDocumentAtPath } = await import("../../src/io/files");
    const { store } = setup();
    // Read as the document ends: Discard gave its work up, so its crash snapshot is dropped with it.
    let givenUp: boolean | null = null;
    store.session.own(() => (givenUp = store.givenUp));
    const p = openDocumentAtPath(store, "D:/work/Gear.funda");
    const read = await reading("D:/work/Gear.funda");
    store.setParam("width", 30);
    read.release(docText("gear"));
    expect({ outcome: await p, givenUp, ...state(store) }).toEqual({
      outcome: "ok",
      givenUp: true,
      parameters: { gear: 1 },
      path: "D:/work/Gear.funda",
      dirty: false,
      toasts: [],
      asked: ["Bracket.funda changed while Gear.funda was read. Discard those changes and open Gear.funda?"],
    });
    await opensNextCleanly(store);
  });

  // A derived commit (a projection refresh, a measured field) is not a change the user made while it read.
  it("asks only for a user edit made while it read, not for a derived commit", async () => {
    const { openDocumentAtPath } = await import("../../src/io/files");
    const box = { id: "box1", type: "box", width: 12.5, depth: 7.25, height: 3.5 } as unknown as Feature;
    for (const userEdit of [false, true]) {
      host.reads = [];
      host.asked = [];
      host.answer = "cancel";
      const { store } = setup([box]);
      store.setParam("width", 30);
      await vi.waitFor(() => expect(store.dirty).toBe(true));
      const p = openDocumentAtPath(store, "D:/work/Gear.funda");
      const read = await reading("D:/work/Gear.funda");
      store.deriveFeature("box1", { depth: 9.75 } as Partial<Feature>);
      store.deriveFeature("box1", { height: 4.125 } as Partial<Feature>);
      if (userEdit) store.setParam("depth", 17);
      await vi.waitFor(() => expect(store.document.parameters.depth).toBe(userEdit ? 17 : undefined));
      read.release(docText("gear"));
      expect({ outcome: await p, ...state(store) }).toEqual(
        userEdit
          ? {
              outcome: "dropped",
              parameters: { width: 30, depth: 17 },
              path: "D:/work/Bracket.funda",
              dirty: true,
              toasts: [],
              asked: [expect.stringContaining("changed while Gear.funda was read")],
            }
          : {
              outcome: "ok",
              parameters: { gear: 1 },
              path: "D:/work/Gear.funda",
              dirty: false,
              toasts: [],
              asked: [],
            },
      );
      host.answer = "discard";
      await opensNextCleanly(store);
    }
  });

  // A Discard answered for an open that did not land must not drop the crash snapshot of the document that stayed.
  it("keeps the document's work given up only when the open it was asked for lands", async () => {
    const { openDocumentAtPath } = await import("../../src/io/files");
    const runs: unknown[] = [];
    for (const [text, laterAnswer] of [
      ["{ not a document", false],
      [docText("gear"), false],
      ["{ not a document", true],
    ] as const) {
      host.reads = [];
      const { store } = setup();
      store.setParam("width", 30);
      await vi.waitFor(() => expect(store.dirty).toBe(true));
      let givenUpAtEnd: boolean | null = null;
      store.session.own(() => (givenUpAtEnd = store.givenUp));
      store.markGivenUp();
      const p = openDocumentAtPath(store, "D:/work/Gear.funda");
      const read = await reading("D:/work/Gear.funda");
      if (laterAnswer) store.markGivenUp();
      read.release(text);
      runs.push({ outcome: await p, givenUp: store.givenUp, givenUpAtEnd });
      host.answer = "discard";
      await opensNextCleanly(store);
    }
    expect(runs).toEqual([
      { outcome: "unreadable", givenUp: false, givenUpAtEnd: null },
      { outcome: "ok", givenUp: false, givenUpAtEnd: true },
      { outcome: "unreadable", givenUp: true, givenUpAtEnd: null },
    ]);
  });
});

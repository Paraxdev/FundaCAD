import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  answers: [] as (string | null)[],
  asked: [] as string[],
  gate: null as Promise<void> | null,
}));
vi.mock("../../src/ui/choice", () => ({
  choose: vi.fn(async (title: string) => {
    host.asked.push(title);
    return host.answers.shift() ?? null;
  }),
}));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));
vi.mock("../../src/templates", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/templates")>();
  return {
    ...real,
    templateText: async (id: string) => {
      if (host.gate) await host.gate;
      return real.templateText(id);
    },
  };
});

import { newFromTemplate } from "../../src/app/documentActions";
import type { Engine } from "../../src/app/engine";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";

function engine(dirty: boolean) {
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
  const store = new DocumentStore(geometry, { parameters: {}, features: [] });
  store.markSaved("D:/work/Bracket.funda");
  if (dirty) store.setParam("width", 31.5);
  const frameNextModel = vi.fn();
  const e = { store, sketch: { hasUncommittedEdits: false }, frameNextModel } as unknown as Engine;
  return { e, store, frameNextModel };
}

function gate() {
  let open!: () => void;
  host.gate = new Promise<void>((r) => (open = r));
  return () => {
    host.gate = null;
    open();
  };
}

function state(store: DocumentStore, frameNextModel: ReturnType<typeof vi.fn>) {
  return {
    template: store.document.features.length > 0,
    parameters: store.document.parameters,
    fileName: store.fileName,
    dirty: store.dirty,
    framed: frameNextModel.mock.calls.length,
    asked: host.asked.length,
  };
}

describe("newFromTemplate", () => {
  beforeEach(() => {
    host.answers = [];
    host.asked = [];
    host.gate = null;
  });

  it("loads the template as an untitled document named after it, and a second template after it", async () => {
    const { e, store, frameNextModel } = engine(false);
    await newFromTemplate(e, "plate");
    const first = state(store, frameNextModel);
    const plate = store.document.features.map((f) => f.id);
    await newFromTemplate(e, "plate");
    expect({ first, again: state(store, frameNextModel), same: store.document.features.map((f) => f.id) }).toEqual({
      first: { template: true, parameters: expect.any(Object), fileName: "Plate", dirty: false, framed: 1, asked: 0 },
      again: { template: true, parameters: expect.any(Object), fileName: "Plate", dirty: false, framed: 2, asked: 0 },
      same: plate,
    });
  });

  it("does nothing when the unsaved work is kept", async () => {
    host.answers = ["cancel"];
    const { e, store, frameNextModel } = engine(true);
    await vi.waitFor(() => expect(store.dirty).toBe(true));
    await newFromTemplate(e, "plate");
    expect(state(store, frameNextModel)).toEqual({
      template: false,
      parameters: { width: 31.5 },
      fileName: "Bracket.funda",
      dirty: true,
      framed: 0,
      asked: 1,
    });
  });

  it("is not loaded over a New made while it read", async () => {
    const { e, store, frameNextModel } = engine(false);
    const release = gate();
    const p = newFromTemplate(e, "plate");
    await vi.waitFor(() => expect(store.sessions.lastOpening).toBe(1));
    store.newDocument();
    store.setParam("drawn", 4.25);
    release();
    await p;
    await vi.waitFor(() => expect(store.document.parameters).toEqual({ drawn: 4.25 }));
    expect(state(store, frameNextModel)).toEqual({
      template: false,
      parameters: { drawn: 4.25 },
      fileName: expect.not.stringMatching(/Plate/),
      dirty: true,
      framed: 0,
      asked: 0,
    });
  });

  it("asks about an edit made while it read, keeps it on Cancel and loads over it on Discard", async () => {
    const runs: unknown[] = [];
    for (const second of ["cancel", "discard"]) {
      host.asked = [];
      host.answers = ["discard", second];
      const { e, store, frameNextModel } = engine(true);
      await vi.waitFor(() => expect(store.dirty).toBe(true));
      const release = gate();
      const p = newFromTemplate(e, "plate");
      await vi.waitFor(() => expect(store.sessions.lastOpening).toBe(1));
      store.setParam("depth", 18.5);
      await vi.waitFor(() => expect(store.document.parameters.depth).toBe(18.5));
      release();
      await p;
      const s = state(store, frameNextModel);
      runs.push(second === "cancel" ? s : { ...s, parameters: "template" });
    }
    expect(runs).toEqual([
      {
        template: false,
        parameters: { width: 31.5, depth: 18.5 },
        fileName: "Bracket.funda",
        dirty: true,
        framed: 0,
        asked: 2,
      },
      { template: true, parameters: "template", fileName: "Plate", dirty: false, framed: 1, asked: 2 },
    ]);
  });
});

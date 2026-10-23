// An import waiting on its unit question has not reached its read yet, but it still lands in the open document, so
// an assistant's doc_open and a plugin's doc_set are refused until it has landed.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore, EMPTY_DOCUMENT } from "../../src/document/store";
import { LiveSessionHost } from "../../src/live/liveSession";
import { appHost } from "../../src/plugins/broker/appHost";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";
import { box } from "../document/storeKit";

vi.stubGlobal("window", globalThis);
const unit = vi.hoisted(() => ({ answer: null as null | ((u: string) => void) }));
vi.mock("../../src/ui/choice", () => ({
  choose: () => new Promise((r) => (unit.answer = r as (u: string) => void)),
  listModal: async () => {},
}));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));

const { importPath } = await import("../../src/io/files");

class Backend {
  reply: Record<string, unknown> | null = { ok: true, guests: [], proposals: [] };
  async session() {
    return this.reply;
  }
  async rebuild() {
    return { ok: true, result: { bodies: [], errors: [] } } as never;
  }
  async importGeometry(_p: string, _f: string, onStarted?: (id: string) => void) {
    onStarted?.("imp1");
    return { ok: true, geom: "h1", name: "chair", solid: true, faces: 6 };
  }
  async init() {}
  onStatus() {
    return () => {};
  }
  get connected() {
    return true;
  }
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const ids = (store: DocumentStore) => store.document.features.map((f) => f.id);

describe("an import on its unit question while another document is proposed", () => {
  it("an assistant's doc_open is refused and the import lands in the user's document", async () => {
    const geo = new Backend() as unknown as GeometryBackend & Backend;
    const store = new DocumentStore(geo, EMPTY_DOCUMENT);
    store.addFeature(box("mine", 10));
    const host = new LiveSessionHost(store, geo, () => true);
    host.start();
    await host.tick();
    const importing = importPath(store, geo, "C:/m/chair.glb");
    await flush();
    const runningWhileAsked = store.importRunning;
    geo.reply = {
      ok: true,
      guests: ["an assistant"],
      proposals: [
        {
          id: "p1",
          name: "an assistant",
          note: null,
          replaces: true,
          doc: store.session.id,
          document: { parameters: {}, features: [box("other-file", 5)] },
        },
      ],
    };
    await host.tick();
    geo.reply = { ok: true, guests: [], proposals: [] };
    unit.answer!("mm");
    await importing;
    await flush();
    const after = ids(store);
    const runningAfter = store.importRunning;
    await host.stop();
    expect({
      runningWhileAsked,
      mine: after[0],
      other: after.includes("other-file"),
      n: after.length,
      runningAfter,
    }).toEqual({ runningWhileAsked: true, mine: "mine", other: false, n: 2, runningAfter: false });
  });

  it("a plugin's doc_set is refused and the import lands in the user's document", async () => {
    const geo = new Backend() as unknown as GeometryBackend & Backend;
    const store = new DocumentStore(geo, EMPTY_DOCUMENT);
    store.addFeature(box("mine", 10));
    const importing = importPath(store, geo, "C:/m/chair.glb");
    await flush();
    const h = appHost({ store });
    const set = await Promise.resolve(
      h.perform(
        "doc_set" as never,
        {
          document: { parameters: {}, features: [box("other-file", 5)] } as unknown as CadDocument,
        } as never,
      ),
    ).then(
      () => "ok",
      (e: Error) => e.message,
    );
    unit.answer!("mm");
    await importing;
    await flush();
    const after = ids(store);
    expect({ set, mine: after[0], n: after.length }).toEqual({
      set: expect.stringContaining("an import is still being read"),
      mine: "mine",
      n: 2,
    });
  });
});

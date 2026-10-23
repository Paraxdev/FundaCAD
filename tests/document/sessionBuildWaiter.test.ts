// A waiter on a later build of the document (a separated body's look, a re-picked face's extent) stops with its
// document: the next document's builds never reach it, while a plain build listener keeps hearing every document.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { RebuildReply } from "../../src/types";
import { box } from "./storeKit";

vi.stubGlobal("window", globalThis);

const okBackend = {
  async rebuild(): Promise<RebuildReply> {
    return {
      ok: true,
      result: {
        mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
        edges: [],
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
        bodies: [{ id: "body1", name: "body1", faceStart: 0, faceCount: 1 }],
      },
    };
  },
  async init() {},
  onStatus: () => () => {},
  async cancel() {
    return true;
  },
  connected: true,
} as unknown as GeometryBackend;

describe("build waiters and the document session", () => {
  it("a session waiter hears its own document's builds and none of the next documents'", async () => {
    const store = new DocumentStore(okBackend, { parameters: {}, features: [] });
    const heard = { waiter: [] as string[], plain: [] as string[] };
    const tag = () => store.document.features.map((f) => f.id).join(",") || "empty";
    store.onSessionBuild((s) => {
      if (!s.building) heard.waiter.push(tag());
    });
    store.onBuild((s) => {
      if (!s.building) heard.plain.push(tag());
    });
    heard.waiter.length = 0;
    heard.plain.length = 0;
    store.addFeature(box("a-plate", 40));
    await store.whenBuilt();
    store.newDocument();
    store.addFeature(box("b-plate", 20));
    await store.whenBuilt();
    store.newDocument();
    store.addFeature(box("c-plate", 10));
    await store.whenBuilt();
    expect({ waiter: [...new Set(heard.waiter)], plain: [...new Set(heard.plain)] }).toEqual({
      waiter: ["a-plate"],
      plain: ["a-plate", "empty", "b-plate", "c-plate"],
    });
  });

  it("a waiter unsubscribed by its owner before the document ends hears nothing more", async () => {
    const store = new DocumentStore(okBackend, { parameters: {}, features: [] });
    const heard: number[] = [];
    const off = store.onSessionBuild((s) => {
      if (!s.building) heard.push(store.document.features.length);
    });
    off();
    store.addFeature(box("a-plate", 40));
    await store.whenBuilt();
    store.newDocument();
    expect(heard).toEqual([0]);
  });
});

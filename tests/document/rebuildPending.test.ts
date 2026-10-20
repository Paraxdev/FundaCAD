import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";

vi.stubGlobal("window", globalThis);

const backend = {
  async rebuild() { return { ok: false, error: { message: "stub" } }; },
  async init() {},
  onStatus() { return () => {}; },
  connected: true,
} as unknown as GeometryBackend;

afterEach(() => vi.useRealTimers());

describe("rebuildPending", () => {
  it("is true while an edit waits out the debounce", () => {
    vi.useFakeTimers();
    const store = new DocumentStore(backend, { parameters: { w: 1 }, features: [] });
    expect(store.rebuildPending).toBe(false);
    store.mutate((d) => { d.parameters.w = 2; });
    expect(store.rebuildPending).toBe(true);
    vi.advanceTimersByTime(200);
    expect(store.rebuildPending).toBe(false);
  });
});

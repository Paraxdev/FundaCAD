// A recovered snapshot stays on disk until its work is safe somewhere else or given up: saved, written again as the
// untitled snapshot, or dropped by Discard or Don't save. Then it is not offered again at the next start.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { stubBackend, box } from "../document/storeKit";

const host = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: Record<string, unknown> }[],
  snapshot: "",
  pick: "recover" as string | null,
  lockedSlot: "",
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    host.invoked.push({ cmd, args });
    if (cmd === "recovery_list") return [[recoveredSlot(), 1000]];
    if (cmd === "recovery_read") return host.snapshot;
    if (cmd === "recovery_clear" && args.slot === host.lockedSlot) throw new Error("file locked");
    return null;
  },
}));
vi.mock("../../src/ui/choice", () => ({ choose: async () => host.pick }));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));

const { installAutosave, checkRecovery, clearRecovery, slotFor } = await import("../../src/io/recovery");
const { mayDiscard } = await import("../../src/app/documentActions");
const recoveredSlot = () => slotFor("D:/parts/a.funda");

const noSketch = { hasUncommittedEdits: false } as never;

async function recovered() {
  const crashed = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  crashed.addFeature(box("a-plate", 40));
  host.snapshot = JSON.stringify({ source: "D:/parts/a.funda", savedAt: Date.now(), doc: crashed.toObject() });
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  installAutosave(store);
  await checkRecovery(store);
  await vi.advanceTimersByTimeAsync(0);
  return store;
}

async function clears(act: () => Promise<unknown> | void) {
  host.invoked = [];
  await act();
  await vi.advanceTimersByTimeAsync(0);
  return host.invoked.filter((c) => c.cmd === "recovery_clear").map((c) => c.args.slot);
}

describe("a snapshot the user recovered", () => {
  beforeEach(() => {
    host.pick = "recover";
    host.lockedSlot = "";
    vi.useFakeTimers();
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is kept while the recovered work lives only in memory", async () => {
    const store = await recovered();
    const idle = await clears(() => vi.advanceTimersByTimeAsync(10_000));
    expect({ features: store.document.features.map((f) => f.id), idle }).toEqual({ features: ["a-plate"], idle: [] });
  });

  it("is dropped when the recovered work is discarded", async () => {
    const store = await recovered();
    host.pick = "discard";
    const dropped = await clears(async () => {
      if (await mayDiscard({ store, sketch: noSketch }, "Discard?")) store.newDocument();
    });
    expect(dropped).toContain(recoveredSlot());
  });

  it("is dropped when the recovered work is saved to another path", async () => {
    await recovered();
    const dropped = await clears(() => clearRecovery("D:/parts/b.funda"));
    expect(dropped).toEqual([slotFor("D:/parts/b.funda"), slotFor(null), recoveredSlot()]);
  });

  it("is dropped once an edit of the recovered work is written as the untitled snapshot", async () => {
    const store = await recovered();
    const written = await clears(async () => {
      store.addFeature(box("a-more", 5));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const order = host.invoked.map((c) => `${c.cmd} ${String(c.args?.slot)}`);
    expect({ written, order }).toEqual({
      written: [recoveredSlot()],
      order: [`recovery_write ${slotFor(null)}`, `recovery_clear ${recoveredSlot()}`],
    });
  });

  it("is kept when another document replaces it unasked and that one is saved", async () => {
    const store = await recovered();
    store.newDocument();
    await vi.advanceTimersByTimeAsync(0);
    const later = await clears(() => clearRecovery("D:/parts/c.funda"));
    expect(later).toEqual([slotFor("D:/parts/c.funda"), slotFor(null)]);
  });

  it("is cleared on the next snapshot when it was locked, without counting as an autosave failure", async () => {
    const store = await recovered();
    host.lockedSlot = recoveredSlot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const locked = await clears(async () => {
      store.addFeature(box("a-more", 5));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    host.lockedSlot = "";
    const retried = await clears(async () => {
      store.addFeature(box("a-last", 5));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect({ locked, retried, warned: warn.mock.calls.map((c) => c[0]) }).toEqual({
      locked: [recoveredSlot()],
      retried: [recoveredSlot()],
      warned: [],
    });
  });
});

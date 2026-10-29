// A Move drag let go of but not entered counts as unsaved work, and the snapshot enters it first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { stubBackend, box } from "../document/storeKit";

const host = vi.hoisted(() => ({ disk: new Map<string, string>() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const slot = args.slot as string;
    if (cmd === "recovery_write") host.disk.set(slot, args.json as string);
    else if (cmd === "recovery_clear") host.disk.delete(slot);
  },
}));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));

const { installAutosave, slotFor } = await import("../../src/io/recovery");

const PATH = "D:/parts/bracket.funda";

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
    for (let j = 0; j < 20; j++) await Promise.resolve();
  }
};
const idle = async () => {
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
};
const onDisk = () =>
  Object.fromEntries(
    [...host.disk].map(([slot, json]) => [
      slot,
      (JSON.parse(json) as { doc: { features: { id: string }[] } }).doc.features.map((f) => f.id),
    ]),
  );

// Mirrors MoveTool: Enter appends the move, a drag under the hand is left alone.
function heldMove(store: DocumentStore) {
  const watchers = new Set<() => void>();
  const set = (on: boolean) => {
    edit.pending = on;
    for (const fn of watchers) fn();
  };
  const edit = {
    pending: false,
    dragging: false,
    entered: 0,
    onHeldChange(fn: () => void) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    confirmHeld() {
      if (edit.dragging || !edit.pending) return;
      edit.entered++;
      store.addFeature(box("move1", 12.5));
      set(false);
    },
    letGo() {
      edit.dragging = false;
      set(true);
    },
    escape: () => set(false),
  };
  return edit;
}

function savedPlate() {
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  const autosave = installAutosave(store);
  store.addFeature(box("plate", 41.5, 6.25));
  store.markSaved(PATH);
  const move = heldMove(store);
  autosave.watchHeld(move);
  return { store, move };
}

describe("autosave and a Move drag let go of but not entered", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host.disk.clear();
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });
  afterEach(() => vi.useRealTimers());

  it("enters a held drag on a clean document and snapshots the moved body", async () => {
    const { store, move } = savedPlate();
    move.letGo();
    await idle();
    expect({ entered: move.entered, dirty: store.dirty, disk: onDisk() }).toEqual({
      entered: 1,
      dirty: true,
      disk: { [slotFor(PATH)]: ["plate", "move1"] },
    });
  });

  it("leaves a drag under the hand alone and enters it after the next quiet period", async () => {
    const { move } = savedPlate();
    move.letGo();
    move.dragging = true;
    await idle();
    expect({ entered: move.entered, disk: onDisk() }).toEqual({ entered: 0, disk: {} });
    move.dragging = false;
    await idle();
    expect({ entered: move.entered, disk: onDisk() }).toEqual({
      entered: 1,
      disk: { [slotFor(PATH)]: ["plate", "move1"] },
    });
  });

  it("writes nothing for a drag cancelled with Escape before the quiet period ends", async () => {
    const { store, move } = savedPlate();
    move.letGo();
    await vi.advanceTimersByTimeAsync(10_000);
    move.escape();
    await idle();
    expect({ entered: move.entered, dirty: store.dirty, disk: onDisk() }).toEqual({
      entered: 0,
      dirty: false,
      disk: {},
    });
  });

  it("writes nothing while nothing is held and the document is saved", async () => {
    const { store, move } = savedPlate();
    await idle();
    await idle();
    expect({ entered: move.entered, dirty: store.dirty, disk: onDisk() }).toEqual({
      entered: 0,
      dirty: false,
      disk: {},
    });
  });
});

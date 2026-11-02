// New and Open ask before throwing work away, and an open sketch's edits count
// as work although the store has no copy of them until the sketch is finished.

import { beforeEach, describe, expect, it, vi } from "vitest";

const choose = vi.fn();
vi.mock("../../src/ui/choice", () => ({ choose: (...a: unknown[]) => choose(...a) }));
const openDocument = vi.fn();
vi.mock("../../src/io/files", () => ({ openDocument: (...a: unknown[]) => openDocument(...a) }));
const closeHome = vi.fn();
vi.mock("../../src/ui/home", () => ({ closeHome: () => closeHome() }));
const cancelActiveTools = vi.fn();
vi.mock("../../src/app/toolBusy", () => ({ cancelActiveTools: () => cancelActiveTools() }));

import { createDocumentActions, hasUnsavedWork } from "../../src/app/documentActions";
import type { Engine } from "../../src/app/engine";

function fakeEngine(dirty: boolean, sketchEdits: boolean) {
  const calls: string[] = [];
  const e = {
    store: { dirty, newDocument: () => calls.push("new"), markGivenUp: () => calls.push("given up") },
    sketch: { hasUncommittedEdits: sketchEdits },
    viewport: { resetCamera: () => {} },
    geometry: {},
  };
  return { e: e as unknown as Engine, calls };
}

beforeEach(() => {
  choose.mockReset();
  openDocument.mockReset();
});

describe("unsaved work", () => {
  it("includes an open sketch's uncommitted edits", () => {
    expect(hasUnsavedWork(fakeEngine(false, false).e)).toBe(false);
    expect(hasUnsavedWork(fakeEngine(true, false).e)).toBe(true);
    expect(hasUnsavedWork(fakeEngine(false, true).e)).toBe(true);
  });
});

describe("New", () => {
  it("asks when only an open sketch has changes, and keeps them on Cancel", async () => {
    const { e, calls } = fakeEngine(false, true);
    choose.mockResolvedValue("cancel");
    await createDocumentActions(e).newDocument();
    expect(choose).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
  });

  it("starts the new document once the user discards", async () => {
    const { e, calls } = fakeEngine(false, true);
    choose.mockResolvedValue("discard");
    await createDocumentActions(e).newDocument();
    expect(calls).toEqual(["given up", "new"]);
  });

  it("does not ask when nothing would be lost", async () => {
    const { e, calls } = fakeEngine(false, false);
    await createDocumentActions(e).newDocument();
    expect(choose).not.toHaveBeenCalled();
    expect(calls).toEqual(["new"]);
  });

  it("dismissing the question keeps the work", async () => {
    const { e, calls } = fakeEngine(true, false);
    choose.mockResolvedValue(null);
    await createDocumentActions(e).newDocument();
    expect(calls).toEqual([]);
  });
});

describe("Open", () => {
  it("hands the open a question that asks only when an open sketch has changes", async () => {
    const quiet = fakeEngine(false, false).e;
    await createDocumentActions(quiet).openDoc();
    const mayReplace = openDocument.mock.calls[0]?.[2] as () => Promise<boolean>;
    expect(await mayReplace()).toBe(true);
    expect(choose).not.toHaveBeenCalled();

    const busy = fakeEngine(false, true);
    await createDocumentActions(busy.e).openDoc();
    const ask = openDocument.mock.calls[1]?.[2] as () => Promise<boolean>;
    choose.mockResolvedValue("cancel");
    const cancelled = { asked: await ask(), calls: [...busy.calls] };
    choose.mockResolvedValue("discard");
    expect({ cancelled, discarded: { asked: await ask(), calls: busy.calls } }).toEqual({
      cancelled: { asked: false, calls: [] },
      discarded: { asked: true, calls: ["given up"] },
    });
  });
});

describe("Undo and Redo", () => {
  it("close Home first, so the change shows on the document it is made to", () => {
    const calls: string[] = [];
    closeHome.mockReset();
    closeHome.mockImplementation(() => calls.push("close"));
    const e = {
      tools: { move: { cancel: () => {} }, extrude: { profileSketches: [] } },
      sketch: { undoEdit: () => false, redoEdit: () => false },
      ui: { panels: { undoStress: () => false, redoStress: () => false } },
      store: { undo: () => calls.push("undo"), redo: () => calls.push("redo"), document: { features: [] } },
    } as unknown as Engine;
    const a = createDocumentActions(e);
    a.doUndo();
    a.doRedo();
    expect(calls).toEqual(["close", "undo", "close", "redo"]);
  });

  it("with a Move drag not yet entered, Undo drops only that drag", () => {
    const calls: string[] = [];
    closeHome.mockReset();
    const e = {
      tools: { move: { pending: true, cancel: () => calls.push("drop drag") } },
      sketch: { undoEdit: () => false, redoEdit: () => false },
      ui: { panels: { undoStress: () => false, redoStress: () => false } },
      store: { undo: () => calls.push("undo"), redo: () => calls.push("redo"), document: { features: [] } },
    } as unknown as Engine;
    createDocumentActions(e).doUndo();
    expect(calls).toEqual(["drop drag"]);
  });

  it("while Stress is open take back and put back its setup steps, never the model's", () => {
    const calls: string[] = [];
    closeHome.mockReset();
    const e = {
      tools: { move: { cancel: () => {} }, extrude: { profileSketches: [] } },
      sketch: { undoEdit: () => false, redoEdit: () => false },
      ui: { panels: { undoStress: () => !!calls.push("stress undo"), redoStress: () => !!calls.push("stress redo") } },
      store: { undo: () => calls.push("undo"), redo: () => calls.push("redo"), document: { features: [] } },
    } as unknown as Engine;
    const a = createDocumentActions(e);
    a.doUndo();
    a.doRedo();
    expect(calls).toEqual(["stress undo", "stress redo"]);
  });

  it("go to the model once Stress is closed, and to an open sketch before Stress", () => {
    const calls: string[] = [];
    closeHome.mockReset();
    const undoStress = () => {
      calls.push("stress undo");
      return false;
    };
    const closed = {
      tools: { move: { cancel: () => {} }, extrude: { profileSketches: [] } },
      sketch: { undoEdit: () => false, redoEdit: () => false },
      ui: { panels: { undoStress } },
      store: { undo: () => calls.push("undo"), redo: () => calls.push("redo"), document: { features: [] } },
    } as unknown as Engine;
    createDocumentActions(closed).doUndo();
    const sketching = { ...closed, sketch: { undoEdit: () => !!calls.push("sketch undo") } } as unknown as Engine;
    createDocumentActions(sketching).doUndo();
    expect(calls).toEqual(["stress undo", "undo", "sketch undo"]);
  });
});

describe("a Move drag let go of but not yet entered", () => {
  it("counts as unsaved work, so New asks and Cancel keeps the drag", async () => {
    const { e, calls } = fakeEngine(false, false);
    (e as unknown as { tools: unknown }).tools = { move: { pending: true } };
    choose.mockResolvedValue("cancel");
    await createDocumentActions(e).newDocument();
    expect({ unsaved: hasUnsavedWork(e), asked: choose.mock.calls.length, calls }).toEqual({
      unsaved: true,
      asked: 1,
      calls: [],
    });
  });

  it("is written by Redo, which then has nothing left to redo", () => {
    const calls: string[] = [];
    closeHome.mockReset();
    const e = {
      tools: {
        move: { pending: true, cancel: () => calls.push("drop drag"), settle: () => calls.push("write drag") },
      },
      sketch: { undoEdit: () => false, redoEdit: () => calls.push("sketch redo") },
      ui: { panels: { undoStress: () => false, redoStress: () => false } },
      store: { undo: () => calls.push("undo"), redo: () => calls.push("redo"), document: { features: [] } },
    } as unknown as Engine;
    createDocumentActions(e).doRedo();
    expect(calls).toEqual(["write drag"]);
  });
});

describe("Undo and Redo under an open tool", () => {
  function engine(opts: {
    editing?: string;
    sketches?: string[];
    before: string[];
    undone: string[];
    redone?: string[];
  }) {
    cancelActiveTools.mockReset();
    const ids = { now: opts.before };
    return {
      tools: { move: { cancel: () => {} }, extrude: { profileSketches: opts.sketches ?? [] } },
      sketch: { undoEdit: () => false, redoEdit: () => false },
      ui: { panels: { undoStress: () => false, redoStress: () => false } },
      store: {
        editPreviewId: opts.editing ?? null,
        get document() {
          return { features: ids.now.map((id) => ({ id })) };
        },
        undo: () => (ids.now = opts.undone),
        redo: () => (ids.now = opts.redone ?? ids.now),
      },
    } as unknown as Engine;
  }
  const standDowns = () => cancelActiveTools.mock.calls.length;

  it("closes a tool re-editing the step the undo removed, not one re-editing a step that stays", () => {
    createDocumentActions(engine({ editing: "f7", before: ["b3", "f7"], undone: ["b3"] })).doUndo();
    expect(standDowns()).toBe(1);
    createDocumentActions(engine({ editing: "f7", before: ["b3", "f7", "f9"], undone: ["b3", "f7"] })).doUndo();
    expect(standDowns()).toBe(0);
  });

  it("closes an extrude when one of its sketches goes, with none, one or many picked", () => {
    createDocumentActions(engine({ sketches: [], before: ["b3", "s4"], undone: ["b3"] })).doUndo();
    expect(standDowns()).toBe(0);
    createDocumentActions(engine({ sketches: ["s4"], before: ["s4", "b3"], undone: ["s4"] })).doUndo();
    expect(standDowns()).toBe(0);
    createDocumentActions(engine({ sketches: ["s4"], before: ["b3", "s4"], undone: ["b3"] })).doUndo();
    expect(standDowns()).toBe(1);
    createDocumentActions(
      engine({ sketches: ["s4", "s6"], before: ["s4", "b3", "s6"], undone: ["s4", "b3"] }),
    ).doUndo();
    expect(standDowns()).toBe(1);
  });

  it("closes the tool when a redo removes the step it edits", () => {
    const e = engine({ editing: "f7", before: ["b3", "f7"], undone: [], redone: ["b3"] });
    createDocumentActions(e).doRedo();
    expect(standDowns()).toBe(1);
  });

  it("leaves alone an id that was never in the document, an open sketch's own profile", () => {
    createDocumentActions(engine({ sketches: ["__active__"], before: ["b3", "s4"], undone: ["b3"] })).doUndo();
    expect(standDowns()).toBe(0);
  });
});

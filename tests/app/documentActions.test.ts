// New and Open ask before throwing work away, and an open sketch's edits count
// as work although the store has no copy of them until the sketch is finished.

import { beforeEach, describe, expect, it, vi } from "vitest";

const choose = vi.fn();
vi.mock("../../src/ui/choice", () => ({ choose: (...a: unknown[]) => choose(...a) }));
const openDocument = vi.fn();
vi.mock("../../src/io/files", () => ({ openDocument: (...a: unknown[]) => openDocument(...a) }));

import { createDocumentActions, hasUnsavedWork } from "../../src/app/documentActions";
import type { Engine } from "../../src/app/engine";

function fakeEngine(dirty: boolean, sketchEdits: boolean) {
  const calls: string[] = [];
  const e = {
    store: { dirty, newDocument: () => calls.push("new") },
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
    expect(calls).toEqual(["new"]);
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

    const busy = fakeEngine(false, true).e;
    await createDocumentActions(busy).openDoc();
    const ask = openDocument.mock.calls[1]?.[2] as () => Promise<boolean>;
    choose.mockResolvedValue("cancel");
    expect(await ask()).toBe(false);
    choose.mockResolvedValue("discard");
    expect(await ask()).toBe(true);
  });
});

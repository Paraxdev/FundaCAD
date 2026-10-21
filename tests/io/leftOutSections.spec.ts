import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const toast = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(async () => {}), save: vi.fn(async () => null) }));
vi.mock("../../src/ui/toast", () => ({ toast: (...a: unknown[]) => toast(...a), dismissToast: vi.fn() }));

import { saveDocument } from "../../src/io/files";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function store(path: string, carried: { kind: number; name: string; hash: string }[]) {
  return {
    filePath: path as string | null,
    dirty: false,
    document: { features: [] },
    versionRepo: null,
    toObject: () => ({}),
    carriedSections: carried,
    markSaved: vi.fn(),
  };
}

describe("a save that cannot hold the sections a .fundab carried", () => {
  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = {};
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    toast.mockReset();
  });
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  const carried = [{ kind: 9, name: "futureIndex", hash: "ab" }];

  it("says which were left out when the file is JSON", async () => {
    await saveDocument(store("D:/parts/a.funda", carried) as any);
    await flush();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain("futureIndex");
    expect(toast.mock.calls[0][0]).toContain(".fundab");
  });

  it("says nothing when the file is a .fundab, which keeps them", async () => {
    await saveDocument(store("D:/parts/a.fundab", carried) as any);
    await flush();
    expect(toast).not.toHaveBeenCalled();
  });

  it("says nothing when the document carried none", async () => {
    await saveDocument(store("D:/parts/a.funda", []) as any);
    await flush();
    expect(toast).not.toHaveBeenCalled();
  });
});

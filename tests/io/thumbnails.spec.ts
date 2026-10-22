import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(async () => {}), save: vi.fn(async () => null) }));

import { saveDocument } from "../../src/io/files";
import { captureAfterOpen, setThumbnailSource } from "../../src/io/thumbnails";
import { installAutosave } from "../../src/io/recovery";
import { setLibrary, type DocumentLibrary } from "../../src/io/library";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fakeLib(cached: string | null = null) {
  const lib = {
    stat: vi.fn(async () => []),
    list: vi.fn(async () => ({ files: [], truncated: false })),
    pickFolder: vi.fn(async () => null),
    summary: vi.fn(async () => null),
    thumbs: vi.fn(async (paths: string[]) => paths.map(() => cached)),
    putThumb: vi.fn(async () => {}),
  } satisfies DocumentLibrary;
  setLibrary(lib);
  return lib;
}

function fakeStore(path = "D:/parts/a.funda") {
  return {
    filePath: path as string | null,
    dirty: false,
    document: { features: [] },
    versionRepo: null,
    toJSON: () => "{}",
    toObject: () => ({}),
    carriedSections: [] as { kind: number; name: string; hash: string }[],
    markSaved: vi.fn(),
  };
}

describe("the preview picture", () => {
  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = {};
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    setThumbnailSource(null);
    setLibrary(null);
    vi.useRealTimers();
  });

  it("is taken before the save's first await and stored once the file is written", async () => {
    const lib = fakeLib();
    const source = vi.fn(() => "data:image/jpeg;base64,AA");
    setThumbnailSource(source);
    const saving = saveDocument(fakeStore() as any);
    expect(source).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    await saving;
    await flush();
    expect(invoke).toHaveBeenCalledWith("container_save", expect.objectContaining({ path: "D:/parts/a.funda" }));
    expect(lib.putThumb).toHaveBeenCalledWith("D:/parts/a.funda", "data:image/jpeg;base64,AA");
  });

  it("is not stored when the write failed", async () => {
    const lib = fakeLib();
    setThumbnailSource(() => "data:image/jpeg;base64,AA");
    invoke.mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await saveDocument(fakeStore() as any);
    await flush();
    expect(lib.putThumb).not.toHaveBeenCalled();
  });

  it("a capture that throws does not stop the save", async () => {
    const lib = fakeLib();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setThumbnailSource(() => {
      throw new Error("no gpu");
    });
    const store = fakeStore();
    await saveDocument(store as any);
    expect(store.markSaved).toHaveBeenCalled();
    expect(lib.putThumb).not.toHaveBeenCalled();
  });

  it("is never taken by autosave", async () => {
    vi.useFakeTimers();
    fakeLib();
    const source = vi.fn(() => "data:image/jpeg;base64,AA");
    setThumbnailSource(source);
    let changed = () => {};
    const store = {
      ...fakeStore(),
      dirty: true,
      onDocChange: (fn: () => void) => {
        changed = fn;
      },
      onMeta: () => {},
    };
    installAutosave(store as any);
    changed();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke).toHaveBeenCalledWith("recovery_write", expect.anything());
    expect(source).not.toHaveBeenCalled();
  });
});

describe("the picture after an open", () => {
  function openedStore() {
    const build = new Set<(s: { building: boolean; result: unknown }) => void>();
    const open = new Set<() => void>();
    return {
      filePath: "D:/parts/a.funda" as string | null,
      dirty: false,
      onBuild(fn: (s: { building: boolean; result: unknown }) => void) {
        build.add(fn);
        fn({ building: false, result: { old: true } });
        return () => build.delete(fn);
      },
      onOpen(fn: () => void) {
        open.add(fn);
        return () => open.delete(fn);
      },
      built(result: unknown = {}) {
        for (const fn of [...build]) fn({ building: false, result });
      },
      opened() {
        for (const fn of [...open]) fn();
      },
    };
  }
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

  afterEach(() => {
    setThumbnailSource(null);
    setLibrary(null);
  });

  it("waits for the first build, then fills a missing picture", async () => {
    const lib = fakeLib(null);
    const source = vi.fn(() => "data:image/jpeg;base64,BB");
    setThumbnailSource(source);
    const store = openedStore();
    captureAfterOpen(store, "D:/parts/a.funda");
    await frame();
    expect(source).not.toHaveBeenCalled();
    store.built();
    await frame();
    await flush();
    expect(lib.putThumb).toHaveBeenCalledWith("D:/parts/a.funda", "data:image/jpeg;base64,BB");
  });

  it("leaves a fresh picture alone", async () => {
    const lib = fakeLib("data:image/jpeg;base64,OLD");
    const source = vi.fn(() => "x");
    setThumbnailSource(source);
    const store = openedStore();
    captureAfterOpen(store, "D:/parts/a.funda");
    store.built();
    await frame();
    await flush();
    expect(source).not.toHaveBeenCalled();
    expect(lib.putThumb).not.toHaveBeenCalled();
  });

  it("takes nothing once the document is edited, renamed or replaced", async () => {
    const lib = fakeLib(null);
    setThumbnailSource(() => "data:image/jpeg;base64,BB");
    const edited = openedStore();
    captureAfterOpen(edited, "D:/parts/a.funda");
    edited.dirty = true;
    edited.built();
    const replaced = openedStore();
    captureAfterOpen(replaced, "D:/parts/a.funda");
    replaced.opened();
    replaced.built();
    const copy = openedStore();
    captureAfterOpen(copy, "D:/parts/a.funda");
    copy.filePath = null;
    copy.built();
    await frame();
    await flush();
    expect(lib.putThumb).not.toHaveBeenCalled();
  });
});

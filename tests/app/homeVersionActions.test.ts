import { beforeEach, describe, expect, it, vi } from "vitest";

const choice = vi.hoisted(() => ({ pick: "discard" as string | null }));
vi.mock("../../src/ui/choice", () => ({ choose: vi.fn(async () => choice.pick) }));
const disk = vi.hoisted(() => ({ outcome: "ok" as string }));
vi.mock("../../src/io/files", () => ({
  openDocument: vi.fn(),
  openDocumentAtPath: vi.fn(async (store: { filePath: string | null }, path: string) => {
    if (disk.outcome === "ok") store.filePath = path;
    return disk.outcome;
  }),
}));

import { openAtVersion, openOnBranch } from "../../src/app/documentActions";
import { openDocumentAtPath } from "../../src/io/files";
import type { Engine } from "../../src/app/engine";

const repo = () => ({
  objects: {},
  versions: [
    { id: "v1", parent: null, branch: "main", message: "First: try", time: 1, tree: { features: [], rest: "" } },
    { id: "v2", parent: "v1", branch: "wide", message: "Wider", time: 2, tree: { features: [], rest: "" } },
  ],
  branches: { main: "v1", wide: "v2" },
  current: "main",
});

function fakeEngine(filePath: string | null = null, dirty = false, toolAtWork = false) {
  const calls: string[] = [];
  const store = {
    dirty,
    filePath,
    versionRepo: repo(),
    restoreVersion: vi.fn((id: string) => { calls.push(`restore ${id}`); }),
    switchVersionBranch: vi.fn((name: string) => { calls.push(`switch ${name}`); }),
    markOpenedWithoutPath: vi.fn((name: string) => { calls.push(`copy ${name}`); }),
  };
  vi.mocked(openDocumentAtPath).mockClear();
  const status: string[] = [];
  const e = {
    store,
    sketch: { hasUncommittedEdits: false },
    geometry: {},
    toolAtWork: () => toolAtWork,
    setStatus: (t: string) => { status.push(t); },
  } as unknown as Engine;
  return { e, store, calls, status };
}

describe("versions from Home", () => {
  beforeEach(() => { choice.pick = "discard"; disk.outcome = "ok"; });

  it("opens a closed file, then restores the version", async () => {
    const { e, calls } = fakeEngine();
    expect(await openAtVersion(e, "D:/p/part.funda", "v1", false)).toBe(true);
    expect(openDocumentAtPath).toHaveBeenCalledOnce();
    expect(calls).toEqual(["restore v1"]);
  });

  it("opens a copy at a version under a name that is safe on disk", async () => {
    const { e, calls } = fakeEngine();
    await openAtVersion(e, "D:/p/part.funda", "v1", true);
    expect(calls).toEqual(["restore v1", "copy part (First try)"]);
  });

  it("acts on the open document without reopening it", async () => {
    const { e, calls } = fakeEngine("D:/p/part.funda", true);
    await openAtVersion(e, "D:/p/part.funda", "v2", false);
    expect(openDocumentAtPath).not.toHaveBeenCalled();
    expect(calls).toEqual(["restore v2"]);
  });

  it("asks before a copy replaces unsaved work on the open document", async () => {
    choice.pick = "cancel";
    const { e, calls } = fakeEngine("D:/p/part.funda", true);
    expect(await openAtVersion(e, "D:/p/part.funda", "v2", true)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does nothing when the unsaved work is kept or the file does not open", async () => {
    choice.pick = "cancel";
    const kept = fakeEngine("D:/other.funda", true);
    expect(await openAtVersion(kept.e, "D:/p/part.funda", "v1", false)).toBe(false);
    expect(openDocumentAtPath).not.toHaveBeenCalled();
    expect(kept.calls).toEqual([]);
    choice.pick = "discard";
    disk.outcome = "unreadable";
    const failed = fakeEngine();
    expect(await openOnBranch(failed.e, "D:/p/part.funda", "wide")).toBe(false);
    expect(failed.calls).toEqual([]);
  });

  it("leaves the open document alone while a sketch or tool is at work on it", async () => {
    const { e, calls, status } = fakeEngine("D:/p/part.funda", false, true);
    expect(await openAtVersion(e, "D:/p/part.funda", "v2", false)).toBe(false);
    expect(await openAtVersion(e, "D:/p/part.funda", "v2", true)).toBe(false);
    expect(await openOnBranch(e, "D:/p/part.funda", "wide")).toBe(false);
    expect(calls).toEqual([]);
    expect(status[0]).toMatch(/^Finish the sketch or tool first/);
  });

  it("opens on a branch, switching only when the file is on another one", async () => {
    const { e, calls } = fakeEngine();
    expect(await openOnBranch(e, "D:/p/part.funda", "wide")).toBe(true);
    expect(await openOnBranch(e, "D:/p/part.funda", "main")).toBe(true);
    expect(await openOnBranch(e, "D:/p/part.funda", "nope")).toBe(false);
    expect(calls).toEqual(["switch wide"]);
  });
});

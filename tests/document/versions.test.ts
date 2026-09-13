import { describe, expect, it, vi } from "vitest";
import {
  commit,
  createBranch,
  diffTrees,
  emptyRepo,
  headOf,
  log,
  normalizeRepo,
  referencedGeometry,
  snapshotOf,
  switchBranch,
  type Snapshot,
} from "../../src/document/versions";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

vi.stubGlobal("window", globalThis);

const box = (id: string, length: number) => ({ id, type: "box", length, width: 10, height: 10 }) as unknown as Feature;
const snap = (...features: Feature[]): Snapshot => ({ parameters: {}, features });

describe("versions", () => {
  it("records versions newest first and brings back exactly what was saved", () => {
    const repo = emptyRepo();
    const a = commit(repo, snap(box("f1", 10)), "base", 1)!;
    const b = commit(repo, snap(box("f1", 10), box("f2", 5)), "add a block", 2)!;
    expect(log(repo).map((v) => v.message)).toEqual(["add a block", "base"]);
    expect(b.parent).toBe(a.id);
    expect(snapshotOf(repo, a.id).features).toEqual([box("f1", 10)]);
  });

  it("stores an unchanged feature once, and refuses an empty version", () => {
    const repo = emptyRepo();
    commit(repo, snap(box("f1", 10)), "one", 1);
    const objects = Object.keys(repo.objects).length;
    commit(repo, snap(box("f1", 10), box("f2", 5)), "two", 2);
    expect(Object.keys(repo.objects).length).toBe(objects + 1);
    expect(commit(repo, snap(box("f1", 10), box("f2", 5)), "same", 3)).toBeNull();
  });

  it("says what changed between two versions by feature", () => {
    const repo = emptyRepo();
    const a = commit(repo, snap(box("f1", 10), box("f2", 5)), "a", 1)!;
    const b = commit(repo, { parameters: { w: 3 }, features: [box("f1", 12), box("f3", 1)] }, "b", 2)!;
    expect(diffTrees(repo, a.tree, b.tree)).toEqual({ added: ["f3"], removed: ["f2"], changed: ["f1"], settings: true });
  });

  it("branches from any version, and each branch keeps its own newest version", () => {
    const repo = emptyRepo();
    const a = commit(repo, snap(box("f1", 10)), "base", 1)!;
    commit(repo, snap(box("f1", 20)), "longer", 2);
    const name = createBranch(repo, "short variant", a.id);
    expect(name).toBe("short-variant");
    switchBranch(repo, name);
    commit(repo, snap(box("f1", 5)), "shorter", 3);
    expect(log(repo).map((v) => v.message)).toEqual(["shorter", "base"]);
    expect(log(repo, "main").map((v) => v.message)).toEqual(["longer", "base"]);
    expect(() => createBranch(repo, "main", a.id)).toThrow();
  });

  it("keeps the geometry every version needs, and survives a round trip through a file", () => {
    const repo = emptyRepo();
    commit(repo, snap({ id: "i1", type: "import", format: "step", name: "p", geom: "abc" } as unknown as Feature), "imported", 1);
    commit(repo, snap(box("f1", 1)), "replaced", 2);
    expect(referencedGeometry(repo)).toEqual(["abc"]);
    const back = normalizeRepo(JSON.parse(JSON.stringify(repo)))!;
    expect(headOf(back)!.message).toBe("replaced");
    expect(normalizeRepo({ versions: "nope" })).toBeNull();
  });
});

describe("versions in the store", () => {
  const backend = () => ({
    async rebuild() { return new Promise<never>(() => {}); },
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
  }) as unknown as GeometryBackend;
  const doc = (): CadDocument => ({ parameters: {}, features: [box("f1", 10)] });

  it("saves, reports changes since, restores, and carries the versions in the saved file", () => {
    const store = new DocumentStore(backend(), doc());
    const v1 = store.saveVersion("first")!;
    expect(store.changesSinceVersion()).toMatchObject({ added: [], removed: [], changed: [] });
    store.addFeature(box("f2", 4));
    expect(store.changesSinceVersion()?.added).toEqual(["f2"]);
    store.saveVersion("second");

    store.restoreVersion(v1.id);
    expect(store.document.features.map((f) => f.id)).toEqual(["f1"]);
    expect(store.versionRepo?.versions).toHaveLength(2);

    const saved = JSON.parse(store.toJSON()) as CadDocument;
    const reopened = new DocumentStore(backend(), doc());
    reopened.load(JSON.stringify(saved));
    expect(reopened.versionRepo?.versions.map((v) => v.message)).toEqual(["first", "second"]);

    reopened.newDocument();
    expect(reopened.versionRepo).toBeNull();
  });

  it("branching moves onto the new branch at that version", () => {
    const store = new DocumentStore(backend(), doc());
    const v1 = store.saveVersion("base")!;
    store.addFeature(box("f2", 4));
    store.saveVersion("more");
    const name = store.branchFromVersion(v1.id, "lean");
    expect(store.versionRepo?.current).toBe(name);
    expect(store.document.features.map((f) => f.id)).toEqual(["f1"]);
    store.switchVersionBranch("main");
    expect(store.document.features.map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});

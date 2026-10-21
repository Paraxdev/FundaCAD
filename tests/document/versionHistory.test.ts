// A document's saved versions as the user meets them: saved, written to a file,
// opened again, restored, branched from, and a restore taken back with undo.
import { describe, expect, it, vi } from "vitest";
import {
  commit, createBranch, diffTrees, emptyRepo, headOf, isEmptyDiff, log, normalizeRepo, referencedGeometry,
  type Snapshot, type Version,
} from "../../src/document/versions";
import type { Feature } from "../../src/types";
import { box, env, opened, saved, study } from "./storeKit";

vi.stubGlobal("window", globalThis);

const snap = (...features: Feature[]): Snapshot => ({ parameters: {}, features });
const ids = (vs: readonly Version[]) => vs.map((v) => v.id);

function threeVersions() {
  const s = opened({ parameters: { w: 7.5 }, features: [box("f1", 10.5)] });
  const shots: Record<string, Snapshot> = {};
  const v1 = s.saveVersion("base")!;
  shots[v1.id] = s.workingSnapshot();
  s.addFeature(box("f2", 4.25, 2));
  const v2 = s.saveVersion("second block")!;
  shots[v2.id] = s.workingSnapshot();
  s.updateFeature("f1", { length: 12 } as Partial<Feature>);
  const v3 = s.saveVersion("longer base")!;
  shots[v3.id] = s.workingSnapshot();
  return { s, v1, v2, v3, shots };
}

describe("history of a reopened file", () => {
  it("comes back from the file whole", () => {
    const { s, v1, v2, v3 } = threeVersions();
    const r = opened(JSON.parse(JSON.stringify(saved(s))));
    expect(r.versionRepo).toEqual(s.versionRepo);
    expect(ids(log(r.versionRepo!))).toEqual([v3.id, v2.id, v1.id]);
    expect(r.changesSinceVersion()).toEqual({ added: [], removed: [], changed: [], settings: false });
  });

  it("restores every version as it was saved, and undo and redo step over each restore", () => {
    const { s, v1, v2, v3, shots } = threeVersions();
    const r = opened(JSON.parse(JSON.stringify(saved(s))));
    const repo = structuredClone(r.versionRepo);
    for (const v of [v1, v2, v3, v1]) {
      const features = structuredClone(r.document.features);
      r.restoreVersion(v.id);
      expect(r.workingSnapshot()).toEqual(shots[v.id]);
      expect(r.versionRepo).toEqual(repo);
      expect(r.canUndo).toBe(true);
      r.undo();
      expect(r.document.features).toEqual(features);
      r.redo();
      expect(r.workingSnapshot()).toEqual(shots[v.id]);
    }
  });

  it("branches from an old version and keeps the branch it is on through a reopen", () => {
    const { s, v1, v2, v3, shots } = threeVersions();
    const r = opened(JSON.parse(s.toJSON()));
    expect(r.branchFromVersion(v1.id, "  lean  base ")).toBe("lean-base");
    expect(r.workingSnapshot()).toEqual(shots[v1.id]);
    r.addFeature(box("f3", 2.5, 1.5));
    const v4 = r.saveVersion("lean")!;
    expect([v4.parent, v4.branch]).toEqual([v1.id, "lean-base"]);
    const again = opened(JSON.parse(r.toJSON()));
    expect(again.versionRepo!.current).toBe("lean-base");
    expect(again.versionRepo!.branches).toEqual({ main: v3.id, "lean-base": v4.id });
    expect(ids(log(again.versionRepo!))).toEqual([v4.id, v1.id]);
    expect(ids(log(again.versionRepo!, "main"))).toEqual([v3.id, v2.id, v1.id]);
    again.switchVersionBranch("main");
    expect(again.workingSnapshot()).toEqual(shots[v3.id]);
  });
});

describe("what a version records", () => {
  it("records a change to one of two features, and only that feature's object is new", () => {
    const s = opened({ features: [box("f1", 10.5), box("f2", 4.25)] });
    const a = s.saveVersion("two blocks")!;
    s.updateFeature("f2", { length: 6 } as Partial<Feature>);
    expect(s.changesSinceVersion()).toEqual({ added: [], removed: [], changed: ["f2"], settings: false });
    const b = s.saveVersion("longer f2")!;
    expect(b).not.toBeNull();
    expect(b.tree.features[0]).toBe(a.tree.features[0]);
    expect(b.tree.features[1]).not.toBe(a.tree.features[1]);
    expect(b.tree.rest).toBe(a.tree.rest);
  });

  it("has nothing to compare against before the first version", () => {
    expect(opened({ features: [box("f1", 10.5)] }).changesSinceVersion()).toBeNull();
  });

  it("finds exactly no change right after a save, also with a study, an environment and a palette", () => {
    const s = opened({ features: [box("f1", 10.5)], stress: study, environment: env(1.5) });
    s.setPaletteSlot(2, { color: "#2a7f3c" });
    s.saveVersion("one");
    expect(s.changesSinceVersion()).toEqual({ added: [], removed: [], changed: [], settings: false });
    expect(s.saveVersion("same again")).toBeNull();
    expect(s.versionRepo!.versions).toHaveLength(1);
  });

  it("counts a study, an environment or a palette colour as a settings change", () => {
    const changes: [string, (s: ReturnType<typeof opened>) => void][] = [
      ["study", (s) => s.setStressStudy(study)],
      ["environment", (s) => s.setDocumentEnvironment(env(2.25))],
      ["palette", (s) => s.setPaletteSlot(1, { color: "#7a1f5c" })],
    ];
    for (const [what, change] of changes) {
      const s = opened({ features: [box("f1", 10.5)] });
      s.saveVersion("one");
      change(s);
      expect(s.changesSinceVersion(), what).toEqual({ added: [], removed: [], changed: [], settings: true });
    }
  });

  it("isEmptyDiff is true only when nothing at all changed", () => {
    const none = { added: [], removed: [], changed: [], settings: false };
    expect(isEmptyDiff(none)).toBe(true);
    for (const d of [{ added: ["f1"] }, { removed: ["f2"] }, { changed: ["f3"] }, { settings: true }]) {
      expect(isEmptyDiff({ ...none, ...d }), JSON.stringify(d)).toBe(false);
    }
  });
});

describe("versions in a repo", () => {
  it("gives every version its own id, even when made in the same millisecond", () => {
    const repo = emptyRepo();
    const made = [box("f1", 1), box("f1", 2), box("f1", 1), box("f1", 2)].map((f) => commit(repo, snap(f), "m", 5)!);
    expect(new Set(ids(made)).size).toBe(4);
    expect(made.map((v) => v.parent)).toEqual([null, made[0]!.id, made[1]!.id, made[2]!.id]);
  });

  it("names a version with no message Saved version and trims one with spaces", () => {
    const repo = emptyRepo();
    expect(commit(repo, snap(box("f1", 1)), "   ", 1)!.message).toBe("Saved version");
    expect(commit(repo, snap(box("f1", 2)), "  wider lid ", 2)!.message).toBe("wider lid");
  });

  it("tidies a branch name and refuses a blank or taken one", () => {
    const repo = emptyRepo();
    const a = commit(repo, snap(box("f1", 1)), "a", 1)!;
    expect(createBranch(repo, " lean ", a.id)).toBe("lean");
    expect(() => createBranch(repo, "lean", a.id)).toThrow(/already/);
    expect(() => createBranch(repo, "   ", a.id)).toThrow(/name/);
    expect(repo.branches).toEqual({ main: a.id, lean: a.id });
  });

  it("finds the first of two versions with one id", () => {
    const repo = emptyRepo();
    const v = commit(repo, snap(box("f1", 10.5)), "a", 1)!;
    const raw = JSON.parse(JSON.stringify(repo));
    raw.versions = [{ ...v, message: "first" }, { ...v, message: "second" }];
    expect(headOf(normalizeRepo(raw)!)!.message).toBe("first");
  });

  it("diffs a tree against itself as unchanged, and against nothing as all added", () => {
    const repo = emptyRepo();
    const a = commit(repo, snap(box("f1", 1), box("f2", 3.5)), "a", 1)!;
    expect(diffTrees(repo, a.tree, a.tree)).toEqual({ added: [], removed: [], changed: [], settings: false });
    expect(diffTrees(repo, null, a.tree)).toEqual({ added: ["f1", "f2"], removed: [], changed: [], settings: false });
  });

  it("lists the geometry of imports only", () => {
    const repo = emptyRepo();
    commit(repo, snap(
      { id: "x", type: "box", geom: "h-box" } as unknown as Feature,
      { id: "i1", type: "import", geom: "h-import" } as unknown as Feature,
      { id: "i2", type: "import", geom: 7 } as unknown as Feature,
    ), "a", 1);
    expect(referencedGeometry(repo)).toEqual(["h-import"]);
    expect(referencedGeometry(emptyRepo())).toEqual([]);
  });

  it("lists a history whose parents form a cycle once, without walking it forever", () => {
    const tree = { features: [], rest: "r" };
    const repo = normalizeRepo({ objects: {}, branches: { main: "a" }, current: "main", versions: [
      { id: "a", parent: "b", branch: "main", message: "a", time: 1, tree },
      { id: "b", parent: "a", branch: "main", message: "b", time: 2, tree },
    ] })!;
    // A read counter turns an endless walk into a throw before it eats the memory.
    let reads = 0;
    const guarded = {
      ...repo,
      get versions() {
        if (++reads > 1000) throw new Error("log walked the cycle more than 1000 times");
        return repo.versions;
      },
    };
    expect(ids(log(guarded))).toEqual(["a", "b"]);
  });
});

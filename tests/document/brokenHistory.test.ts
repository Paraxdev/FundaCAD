// A file whose saved versions are damaged still opens: what can be trusted is
// kept, the rest is dropped, and the document itself is never lost to it.
import { describe, expect, it, vi } from "vitest";
import { commit, emptyRepo, normalizeRepo, referencedGeometry, snapshotOf, type VersionRepo } from "../../src/document/versions";
import { box, opened, saved } from "./storeKit";

vi.stubGlobal("window", globalThis);

function goodRepo() {
  const repo = emptyRepo();
  const a = commit(repo, { parameters: {}, features: [box("f1", 10.5)] }, "a", 1)!;
  const b = commit(repo, { parameters: { w: 3 }, features: [box("f1", 10.5), box("f2", 4.25)] }, "b", 2)!;
  repo.branches.lean = a.id;
  return { repo: JSON.parse(JSON.stringify(repo)) as VersionRepo, a, b };
}

type Raw = Record<string, any>;
const cases: [string, (raw: Raw) => void, (good: VersionRepo) => VersionRepo][] = [
  ["null and number rows", (r) => r.versions.unshift(null, 5), (g) => g],
  ["a row without a tree", (r) => r.versions.push({ id: "y", branch: "main" }), (g) => g],
  ["a tree without features", (r) => r.versions.push({ id: "w", branch: "main", tree: { rest: "r" } }), (g) => g],
  ["a tree without rest", (r) => r.versions.push({ id: "u", branch: "main", tree: { features: [] } }), (g) => g],
  ["a numeric id", (r) => r.versions.push({ id: 7, branch: "main", tree: { features: [], rest: "r" } }), (g) => g],
  ["a numeric branch", (r) => r.versions.push({ id: "z", branch: 5, tree: { features: [], rest: "r" } }), (g) => g],
  ["a branch to a missing version", (r) => (r.branches.ghost = "zzz"), (g) => g],
  ["a branch that is not an id", (r) => (r.branches.odd = 5), (g) => g],
  ["current on a branch other than main", (r) => (r.current = "lean"), (g) => ({ ...g, current: "lean" })],
  ["current on a missing branch", (r) => (r.current = "gone"), (g) => g],
  ["current that is not a name", (r) => (r.current = 3), (g) => g],
  [
    "current on a missing branch with main gone",
    (r) => { delete r.branches.main; r.current = "gone"; },
    (g) => ({ ...g, branches: { lean: g.branches.lean! }, current: "lean" }),
  ],
  ["no branches at all", (r) => delete r.branches, (g) => ({ ...g, branches: {}, current: "main" })],
  ["an objects table that is text", (r) => (r.objects = "ab"), (g) => ({ ...g, objects: {} })],
];

describe("a file with a damaged history", () => {
  for (const [what, damage, expected] of cases) {
    it(`opens with ${what}, keeping what can be trusted`, () => {
      const { repo } = goodRepo();
      const raw = structuredClone(repo) as Raw;
      damage(raw);
      const s = opened({ features: [box("f1", 11)], versions: raw });
      const want = expected(repo);
      expect(s.versionRepo).toEqual(want);
      expect(s.document.features).toEqual([box("f1", 11)]);
      expect(saved(s).versions).toEqual(want);
      expect(opened(saved(s)).versionRepo).toEqual(want);
    });
  }

  it("restores and saves on from a history whose current branch was missing", () => {
    const { repo, b } = goodRepo();
    const s = opened({ features: [box("f1", 11)], versions: { ...repo, current: "gone" } });
    s.restoreVersion(b.id);
    expect(s.document.features).toEqual([box("f1", 10.5), box("f2", 4.25)]);
    s.addFeature(box("f3", 2.5, 1.5));
    const v = s.saveVersion("on main")!;
    expect([v.parent, v.branch]).toEqual([b.id, "main"]);
  });

  it("starts a fresh line when the only branch points at nothing", () => {
    const { repo, a, b } = goodRepo();
    const s = opened({ features: [box("f1", 11)], versions: { ...repo, branches: { main: "gone" } } });
    expect([s.versionRepo!.branches, s.versionRepo!.current]).toEqual([{}, "main"]);
    const v = s.saveVersion("again")!;
    expect(v.parent).toBeNull();
    expect(s.versionRepo!.versions.map((x) => x.id)).toEqual([a.id, b.id, v.id]);
    expect(s.versionRepo!.branches).toEqual({ main: v.id });
  });

  it("says why when a version's feature object is missing", () => {
    const { repo, a } = goodRepo();
    const raw = structuredClone(repo);
    delete raw.objects[a.tree.features[0]!];
    const s = opened({ features: [box("f1", 11)], versions: raw });
    expect(() => s.restoreVersion(a.id)).toThrow(/missing a feature/);
    expect(s.document.features).toEqual([box("f1", 11)]);
  });

  it("drops object entries that are not text, so the geometry a save keeps is still listed", () => {
    const repo = emptyRepo();
    const imp = { id: "i1", type: "import", geom: "h-import" } as never;
    const a = commit(repo, { parameters: {}, features: [box("f1", 10.5), imp] }, "a", 1)!;
    const raw = structuredClone(repo) as Raw;
    raw.objects.junk = 5;
    raw.objects.odd = { geom: "h-odd" };
    raw.objects[a.tree.features[0]!] = null;
    const s = opened({ features: [box("f1", 11)], versions: raw });
    const { [a.tree.features[0]!]: _dropped, ...kept } = repo.objects;
    expect(s.versionRepo!.objects).toEqual(kept);
    expect(referencedGeometry(s.versionRepo!)).toEqual(["h-import"]);
    expect(() => s.restoreVersion(a.id)).toThrow(/missing a feature/);
  });

  it("carries a history with no readable row whole, until the first version saved here", () => {
    const raw = { versions: [null, { id: "y" }], branches: { main: "y" }, current: "main", objects: { h: "x" } };
    const s = opened({ features: [box("f1", 11)], versions: raw });
    expect(s.versionRepo).toBeNull();
    expect(s.hasUnreadVersions()).toBe(true);
    expect(saved(s).versions).toEqual(raw);
    const v = s.saveVersion("first here")!;
    expect(s.hasUnreadVersions()).toBe(false);
    expect((saved(s).versions as VersionRepo).versions.map((x) => x.id)).toEqual([v.id]);
  });

  it("writes no history back for a file with versions: null", () => {
    expect("versions" in saved(opened({ versions: null }))).toBe(false);
  });

  it("reads nothing from a history that is not an object", () => {
    for (const raw of [null, undefined, 5, "main", true]) expect(normalizeRepo(raw), String(raw)).toBeNull();
    expect(normalizeRepo({ versions: [] })).toBeNull();
  });

  it("still restores every version of a history read back from a file", () => {
    const { repo, a, b } = goodRepo();
    const back = normalizeRepo(JSON.parse(JSON.stringify(repo)))!;
    expect(back).toEqual(repo);
    expect(snapshotOf(back, a.id)).toEqual({ parameters: {}, features: [box("f1", 10.5)] });
    expect(snapshotOf(back, b.id)).toEqual({ parameters: { w: 3 }, features: [box("f1", 10.5), box("f2", 4.25)] });
  });
});

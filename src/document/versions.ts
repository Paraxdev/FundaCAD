// Versions kept inside the document, git-like: a version points at a tree of content-hashed objects (one per feature
// plus the rest), a branch names its newest version. No merge: two branches of a part are two designs.

import { contentHash } from "./contentHash";
import type { CadDocument, Feature } from "../types";

export interface VersionTree {
  // object hash per feature, in history order
  features: string[];
  // object hash of everything that is not a feature
  rest: string;
}

export interface Version {
  id: string;
  parent: string | null;
  branch: string;
  message: string;
  // ms since the epoch
  time: number;
  tree: VersionTree;
}

export interface VersionRepo {
  objects: Record<string, string>;
  versions: Version[];
  // branch name -> newest version id on it
  branches: Record<string, string>;
  // the branch new versions go on
  current: string;
}

export const MAIN_BRANCH = "main";

export function emptyRepo(): VersionRepo {
  return { objects: {}, versions: [], branches: {}, current: MAIN_BRANCH };
}

export type Snapshot = Omit<CadDocument, "versions">;

function put(repo: VersionRepo, value: unknown): string {
  const text = JSON.stringify(value);
  const hash = contentHash(text);
  repo.objects[hash] ??= text;
  return hash;
}

export function treeOf(repo: VersionRepo, snapshot: Snapshot): VersionTree {
  const { features, ...rest } = snapshot;
  return { features: (features ?? []).map((f) => put(repo, f)), rest: put(repo, rest) };
}

function sameTree(a: VersionTree, b: VersionTree): boolean {
  return (
    a.rest === b.rest && a.features.length === b.features.length && a.features.every((h, i) => h === b.features[i])
  );
}

export function versionById(repo: VersionRepo, id: string): Version | undefined {
  return repo.versions.find((v) => v.id === id);
}

export function headOf(repo: VersionRepo, branch = repo.current): Version | undefined {
  const id = repo.branches[branch];
  return id ? versionById(repo, id) : undefined;
}

// Null when identical to the branch's newest version: an empty version is noise.
export function commit(repo: VersionRepo, snapshot: Snapshot, message: string, time: number): Version | null {
  const scratch: VersionRepo = { ...repo, objects: { ...repo.objects } };
  const tree = treeOf(scratch, snapshot);
  const head = headOf(repo);
  if (head && sameTree(head.tree, tree)) return null;
  Object.assign(repo.objects, scratch.objects);
  const version: Version = {
    id: contentHash(`${head?.id ?? ""}|${repo.current}|${time}|${message}|${tree.rest}|${tree.features.join(",")}`),
    parent: head?.id ?? null,
    branch: repo.current,
    message: message.trim() || "Saved version",
    time,
    tree,
  };
  repo.versions.push(version);
  repo.branches[repo.current] = version.id;
  return version;
}

export function restOf(repo: VersionRepo, v: Version): Omit<Snapshot, "features"> {
  return JSON.parse(repo.objects[v.tree.rest] ?? "{}") as Omit<Snapshot, "features">;
}

export function snapshotOf(repo: VersionRepo, id: string): Snapshot {
  const v = versionById(repo, id);
  if (!v) throw new Error(`no version ${id}`);
  const rest = restOf(repo, v);
  const features = v.tree.features.map((h) => {
    const text = repo.objects[h];
    if (text === undefined) throw new Error(`version ${id} is missing a feature`);
    return JSON.parse(text) as Feature;
  });
  return { ...rest, features };
}

// Newest first.
export function log(repo: VersionRepo, branch = repo.current): Version[] {
  const out: Version[] = [];
  let v = headOf(repo, branch);
  const seen = new Set<string>();
  while (v && !seen.has(v.id)) {
    out.push(v);
    seen.add(v.id);
    v = v.parent ? versionById(repo, v.parent) : undefined;
  }
  return out;
}

// The name is tidied and must be new.
export function createBranch(repo: VersionRepo, name: string, from: string): string {
  const clean = name.trim().replace(/\s+/g, "-");
  if (!clean) throw new Error("a branch needs a name");
  if (repo.branches[clean]) throw new Error(`there is already a branch called ${clean}`);
  if (!versionById(repo, from)) throw new Error(`no version ${from}`);
  repo.branches[clean] = from;
  return clean;
}

export function switchBranch(repo: VersionRepo, name: string): Version {
  const head = headOf(repo, name);
  if (!head) throw new Error(`no branch called ${name}`);
  repo.current = name;
  return head;
}

export interface VersionDiff {
  added: string[];
  removed: string[];
  changed: string[];
  // parameters, visibility, materials and the rest outside the features
  settings: boolean;
}

export function diffTrees(repo: VersionRepo, a: VersionTree | null, b: VersionTree): VersionDiff {
  const idsOf = (tree: VersionTree | null) => {
    const m = new Map<string, string>();
    for (const h of tree?.features ?? []) {
      const id = (JSON.parse(repo.objects[h] ?? "{}") as { id?: string }).id;
      if (id) m.set(id, h);
    }
    return m;
  };
  const before = idsOf(a);
  const after = idsOf(b);
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id));
  return { added, removed, changed, settings: a !== null && a.rest !== b.rest };
}

export function diffAgainstWorking(repo: VersionRepo, id: string, working: Snapshot): VersionDiff {
  const v = versionById(repo, id);
  const scratch: VersionRepo = { ...repo, objects: { ...repo.objects } };
  const tree = treeOf(scratch, working);
  return diffTrees(scratch, v?.tree ?? null, tree);
}

export function isEmptyDiff(d: VersionDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length && !d.settings;
}

// So a saved container keeps what an older version needs to rebuild.
export function referencedGeometry(repo: VersionRepo): string[] {
  const out = new Set<string>();
  for (const text of Object.values(repo.objects)) {
    if (!text.includes('"geom"')) continue;
    try {
      const f = JSON.parse(text) as { type?: string; geom?: string };
      if (f.type === "import" && typeof f.geom === "string") out.add(f.geom);
    } catch {
      /* not a feature object */
    }
  }
  return [...out];
}

export function normalizeRepo(raw: unknown): VersionRepo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<VersionRepo>;
  // Only text is kept: referencedGeometry reads every object on each .fundab save.
  const objects =
    r.objects && typeof r.objects === "object"
      ? Object.fromEntries(Object.entries(r.objects).filter(([, text]) => typeof text === "string"))
      : {};
  const versions = Array.isArray(r.versions)
    ? r.versions.filter(
        (v): v is Version =>
          !!v &&
          typeof v.id === "string" &&
          typeof v.branch === "string" &&
          !!v.tree &&
          Array.isArray(v.tree.features) &&
          typeof v.tree.rest === "string",
      )
    : [];
  if (!versions.length) return null;
  const ids = new Set(versions.map((v) => v.id));
  const branches: Record<string, string> = {};
  for (const [name, id] of Object.entries(r.branches ?? {}))
    if (typeof id === "string" && ids.has(id)) branches[name] = id;
  const current =
    typeof r.current === "string" && branches[r.current] ? r.current : (Object.keys(branches)[0] ?? MAIN_BRANCH);
  return { objects, versions, branches, current };
}

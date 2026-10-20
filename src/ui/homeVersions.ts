import type { DocSummary, VersionRow } from "../io/library";
import type { VersionRepo } from "../document/versions";
import { displayName } from "./homeList";

/** The open document's history in the shape a closed file's summary has. */
export function liveSummary(repo: Readonly<VersionRepo> | null): DocSummary {
  if (!repo) return { format: "funda", versions: [], branches: {}, current: "main" };
  return {
    format: "funda",
    versions: repo.versions.map(({ id, parent, branch, message, time }) => ({ id, parent, branch, message, time })),
    branches: { ...repo.branches },
    current: repo.current,
  };
}

/** Newest first, following parents from the branch's newest version, as the Versions panel lists them. */
export function branchLog(s: DocSummary, branch: string): VersionRow[] {
  const byId = new Map(s.versions.map((v) => [v.id, v]));
  const out: VersionRow[] = [];
  const seen = new Set<string>();
  let v = byId.get(s.branches[branch] ?? "");
  while (v && !seen.has(v.id)) {
    out.push(v);
    seen.add(v.id);
    v = v.parent ? byId.get(v.parent) : undefined;
  }
  return out;
}

/** The current branch first, then the others by name. */
export function branchNames(s: DocSummary): string[] {
  const rest = Object.keys(s.branches).filter((b) => b !== s.current).sort((a, b) => a.localeCompare(b));
  return s.branches[s.current] ? [s.current, ...rest] : rest;
}

const UNSAFE = /[\\/:*?"<>|]/g;

/** The title of a copy opened at a version, safe as a file name. */
export function copyName(path: string, message: string): string {
  const what = message.trim() || "copy";
  return `${displayName(path)} (${what})`.replace(UNSAFE, "").slice(0, 60).trim();
}

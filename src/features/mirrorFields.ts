export type MirrorFieldKey = "objects" | "line";

export interface MirrorFields<L> {
  objects: readonly string[];
  line: L | null;
  // The line's own object id, so one entity is never in both fields.
  lineId: string | null;
  active: MirrorFieldKey;
}

export function startFields<L>(pre: readonly string[]): MirrorFields<L> {
  const objects = [...new Set(pre)];
  return { objects, line: null, lineId: null, active: objects.length ? "line" : "objects" };
}

/** Toggles `id`; a plain pick (`keep` false) moves on to the line field while that is still empty. */
export function pickObject<L>(f: MirrorFields<L>, id: string, keep: boolean): MirrorFields<L> {
  const had = f.objects.includes(id);
  const objects = had ? f.objects.filter((o) => o !== id) : [...f.objects, id];
  const clearsLine = !had && f.lineId === id;
  const line = clearsLine ? null : f.line;
  const lineId = clearsLine ? null : f.lineId;
  const advance = !keep && !had && line === null && f.active === "objects";
  return { objects, line, lineId, active: advance ? "line" : f.active };
}

/** Adds every id not yet picked, then moves on as a plain pick does. */
export function addObjects<L>(f: MirrorFields<L>, ids: readonly string[]): MirrorFields<L> {
  const fresh = ids.filter((id) => !f.objects.includes(id));
  if (!fresh.length) return f;
  const clearsLine = f.lineId !== null && fresh.includes(f.lineId);
  const line = clearsLine ? null : f.line;
  const lineId = clearsLine ? null : f.lineId;
  const advance = line === null && f.active === "objects";
  return { objects: [...f.objects, ...fresh], line, lineId, active: advance ? "line" : f.active };
}

export function pickLine<L>(f: MirrorFields<L>, line: L, lineId: string | null): MirrorFields<L> {
  const objects = lineId === null ? f.objects : f.objects.filter((o) => o !== lineId);
  return { ...f, objects, line, lineId };
}

export function activate<L>(f: MirrorFields<L>, k: MirrorFieldKey): MirrorFields<L> {
  return f.active === k ? f : { ...f, active: k };
}

export function switchField<L>(f: MirrorFields<L>): MirrorFields<L> {
  return { ...f, active: f.active === "objects" ? "line" : "objects" };
}

export function clearField<L>(f: MirrorFields<L>, k: MirrorFieldKey): MirrorFields<L> {
  return k === "objects" ? { ...f, objects: [], active: k } : { ...f, line: null, lineId: null, active: k };
}

export function isReady(f: MirrorFields<unknown>): boolean {
  return f.objects.length > 0 && f.line !== null;
}

export function countLabel(n: number, one: string, many: string): string {
  if (n === 0) return "Nothing picked";
  return `${n} ${n === 1 ? one : many}`;
}

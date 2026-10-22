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

// The active field decides what a click fills. Picks never move to the other field, except that a set line or plane
// hands the clicks back to Objects. Enter moves on to an empty field, then applies.
export function pickObject<L>(f: MirrorFields<L>, id: string): MirrorFields<L> {
  const had = f.objects.includes(id);
  const objects = had ? f.objects.filter((o) => o !== id) : [...f.objects, id];
  const clearsLine = !had && f.lineId === id;
  return { ...f, objects, line: clearsLine ? null : f.line, lineId: clearsLine ? null : f.lineId };
}

export function addObjects<L>(f: MirrorFields<L>, ids: readonly string[]): MirrorFields<L> {
  const fresh = ids.filter((id) => !f.objects.includes(id));
  if (!fresh.length) return f;
  const clearsLine = f.lineId !== null && fresh.includes(f.lineId);
  return {
    ...f,
    objects: [...f.objects, ...fresh],
    line: clearsLine ? null : f.line,
    lineId: clearsLine ? null : f.lineId,
  };
}

export function pickLine<L>(f: MirrorFields<L>, line: L, lineId: string | null): MirrorFields<L> {
  const objects = lineId === null ? f.objects : f.objects.filter((o) => o !== lineId);
  return { objects, line, lineId, active: "objects" };
}

export function enterStep<L>(f: MirrorFields<L>): MirrorFields<L> | "commit" {
  if (isReady(f)) return "commit";
  return activate(f, f.objects.length ? "line" : "objects");
}

export function nextPick(f: MirrorFields<unknown>, lineNoun: string): string {
  if (f.active === "line") return `Pick the mirror ${lineNoun}`;
  if (isReady(f)) return "Enter to mirror, or pick more to mirror";
  return f.objects.length ? "Pick what to mirror, Enter when done" : "Pick what to mirror";
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

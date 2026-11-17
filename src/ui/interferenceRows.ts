import { t } from "../i18n";
import type { ClashRow, ClearanceRow, InterferenceData } from "../stores/panels";
import { bodyReason } from "./engineReasons";

interface Reply {
  pairs: { a: string; b: string; aName: string; bName: string; volume: number }[];
  clearances: { a: string; b: string; aName: string; bName: string; distance: number }[];
  unchecked: { id: string; name: string; reason: string }[];
}

interface Display {
  unit: string;
  /** Display units per mm. */
  scale: number;
  round: (n: number) => number | string;
  label: (id: string, raw: string) => string;
}

export function interferenceTitle(clashes: number): string {
  return t("interference.title", { n: clashes });
}

/** What a finished check says aloud; `closePairs` is null unless Clearance mode ran. */
export function interferenceSummary(clashes: number, closePairs: number | null, unchecked: number): string {
  return t("interference.summary", {
    clashes,
    clearance: closePairs === null ? "no" : "yes",
    close: closePairs ?? 0,
    unchecked,
  });
}

/** The status bar line of a finished check; `closePairs` is null unless Clearance mode ran. */
export function interferenceStatus(clashes: number, closePairs: number | null, unchecked: number): string {
  return t("interference.status.done", {
    found: clashes || closePairs ? "yes" : "no",
    clashes,
    clearance: closePairs === null ? "no" : "yes",
    close: closePairs ?? 0,
    unchecked,
  });
}

export function interferenceData(reply: Reply, d: Display): InterferenceData {
  const names = (r: { a: string; b: string; aName: string; bName: string }) =>
    t("interference.pair", { a: d.label(r.a, r.aName), b: d.label(r.b, r.bName) });
  const f = d.scale;
  // Without the word in the value, mm³ against mm is all a sighted reader has to tell a clash from a close pair.
  const clashes: ClashRow[] = reply.pairs.map((p) => {
    const volume = `${d.round(p.volume * f * f * f)} ${d.unit}³`;
    return {
      key: `${p.a} ${p.b}`,
      label: names(p),
      v: t("interference.overlap", { volume }),
      spoken: t("interference.overlapSaid", { pair: names(p), volume }),
      a: p.a,
      b: p.b,
    };
  });
  const clearances: ClearanceRow[] = reply.clearances.map((c) => {
    const v = t("interference.apart", { distance: `${d.round(c.distance * f)} ${d.unit}` });
    return {
      key: `${c.a} ${c.b}`,
      label: names(c),
      v,
      spoken: t("interference.apartSaid", { pair: names(c), apart: v }),
      a: c.a,
      b: c.b,
    };
  });
  return {
    title: interferenceTitle(clashes.length),
    clashes,
    clearances,
    unchecked: reply.unchecked.map((u) => bodyReason(d.label(u.id, u.name), u.reason)),
  };
}

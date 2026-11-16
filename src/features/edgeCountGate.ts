// How many edges one fillet or chamfer may take. On 8192 boxes (98k edges) the preview took 16 s at 1,000 edges and 45 s
// at 5,000. At 20,000 on a big robot it ran past a minute and took the PC from 8 GB free memory to 0.1 GB.

import { decimalMark, t } from "../i18n";
import { choose } from "../ui/choice";

export const EDGE_WARN = 3000;
export const EDGE_CAP = 5000;

// Grouped only where the group mark cannot be read as a decimal one.
const fmt = (n: number) => (decimalMark() === "." ? n.toLocaleString("en-US") : String(n));

export type EdgeGate = "go" | "warn" | "refuse";

export function edgeGate(count: number): EdgeGate {
  if (count > EDGE_CAP) return "refuse";
  return count > EDGE_WARN ? "warn" : "go";
}

/** True when the tool may start: at once below the warning, on confirm up to the cap, never above it. */
export async function confirmEdgeCount(label: string, count: number): Promise<boolean> {
  const gate = edgeGate(count);
  if (gate === "go") return true;
  // The callers pass the capability's English label, which only tells fillet from chamfer.
  const kind = label.toLowerCase().startsWith("chamfer") ? "chamfer" : "fillet";
  const shown = fmt(count);
  const name = t(kind === "chamfer" ? "tool.chamfer" : "tool.fillet");
  if (gate === "refuse") {
    await choose(
      t("tool.fillet.tooMany", { kind }),
      [{ value: "ok", label: t("tool.fillet.ok"), primary: true }],
      undefined,
      t("tool.fillet.tooManyBody", { count: shown, cap: fmt(EDGE_CAP), kind }),
    );
    return false;
  }
  const answer = await choose(
    t("tool.fillet.manyTitle", { label: name, count: shown }),
    [
      { value: "cancel", label: t("common.cancel") },
      { value: "go", label: t("tool.fillet.manyAction", { label: name, count: shown }), primary: true },
    ],
    undefined,
    t("tool.fillet.manyBody", { label: name, count: shown }),
  );
  return answer === "go";
}

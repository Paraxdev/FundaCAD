// How many edges one fillet or chamfer may take. Measured on 8192 boxes (98k edges): the preview took 16 s at 1,000
// edges and 45 s at 5,000, and at 20,000 the engine stalled past its 60 s watchdog, so no fillet that big can finish.

import { choose } from "../ui/choice";

export const EDGE_WARN = 3000;
export const EDGE_CAP = 20000;

export type EdgeGate = "go" | "warn" | "refuse";

export function edgeGate(count: number): EdgeGate {
  if (count > EDGE_CAP) return "refuse";
  return count > EDGE_WARN ? "warn" : "go";
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** True when the tool may start: at once below the warning, on confirm up to the cap, never above it. */
export async function confirmEdgeCount(label: string, count: number): Promise<boolean> {
  const gate = edgeGate(count);
  if (gate === "go") return true;
  const edges = `${fmt(count)} edges`;
  if (gate === "refuse") {
    await choose(
      `Too many edges for one ${label.toLowerCase()}`,
      [{ value: "ok", label: "OK", primary: true }],
      undefined,
      `${edges} are selected, one ${label.toLowerCase()} takes at most ${fmt(EDGE_CAP)}. At this count the ` +
        `geometry kernel stalls past its watchdog and the ${label.toLowerCase()} can not finish. Select fewer ` +
        `edges and run it in parts.`,
    );
    return false;
  }
  const answer = await choose(
    `${label} ${edges}?`,
    [
      { value: "cancel", label: "Cancel" },
      { value: "go", label: `${label} ${edges}`, primary: true },
    ],
    undefined,
    `${label} on ${edges} at once can take a long time, the preview and the build may need minutes. Esc ` +
      `cancels the preview while it runs.`,
  );
  return answer === "go";
}

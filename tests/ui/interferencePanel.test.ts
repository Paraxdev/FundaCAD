import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import { usePanelsStore } from "../../src/stores/panels";
import type { InterferenceReply } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";
import { EDGE_HOVER_COLOR } from "../../src/viewport/highlight";

// The Interference panel against a hand-made engine: a body the engine could
// not judge is named with why, and its pairs are never reported as clear.

beforeEach(() => setActivePinia(createPinia()));

type Body = { id: string; name: string; faceStart?: number; faceCount?: number };
type Marks = { faceIds: number[]; color: number }[] | null;

function rig(
  reply: InterferenceReply,
  bodies: Body[] = [
    { id: "body1", name: "Echo Dot 2" },
    { id: "body2", name: "Shelf" },
  ],
  userNames = new Map<string, string>(),
) {
  const statuses: { text: string; cls: string }[] = [];
  const marks: { marks: Marks; layer: string | undefined }[] = [];
  const selected: string[][] = [];
  const deps = {
    store: {
      document: { features: [] } as unknown as CadDocument,
      buildState: { result: { bodies } },
      bodyName: (id: string) => userNames.get(id),
      onDocChange: () => {},
      onOpen: () => {},
    },
    viewport: {
      setInterferenceOverlay: () => {},
      setFaceMarks: (m: Marks, layer?: string) => marks.push({ marks: m, layer }),
      setSelectedBodies: (ids: string[]) => selected.push(ids),
    },
    geometry: { interference: async () => reply },
    hasBody: () => true,
    setStatus: (text: string, cls: string) => statuses.push({ text, cls }),
  } as unknown as PanelsDeps;
  return { panels: createPanels(deps), statuses, marks, selected };
}

describe("the Interference panel", () => {
  it("says no bodies overlap when every pair was checked", async () => {
    const { panels, statuses } = rig({ ok: true, pairs: [] });
    await panels.showInterference();
    expect(usePanelsStore().interference?.unchecked).toEqual([]);
    expect(statuses.at(-1)).toEqual({ text: "No interferences found", cls: "connected" });
  });

  it("names a body it could not judge, and does not call the check clean", async () => {
    const reason =
      "has faces that point the wrong way, at 65 of its edges the two faces disagree about which side is inside";
    const { panels, statuses } = rig({
      ok: true,
      pairs: [],
      unchecked: [{ id: "body1", name: "Echo Dot 2", reason }],
    });
    await panels.showInterference();
    expect(usePanelsStore().interference?.unchecked).toEqual([`Echo Dot 2 ${reason}`]);
    expect(statuses.at(-1)).toEqual({
      text: "No interferences found, 1 body could not be checked",
      cls: "error",
    });
  });

  it("tells bodies with the same engine name apart in its rows", async () => {
    const box = (id: string): Body => ({ id, name: "Box" });
    const clash = (a: string, b: string, volume: number) => ({
      a,
      b,
      aName: "Box",
      bName: "Box",
      volume,
      bbox: { min: [1, 2, 3] as [number, number, number], max: [4, 6, 9] as [number, number, number] },
    });
    const { panels } = rig(
      {
        ok: true,
        pairs: [clash("body1", "body3", 2.5), clash("body3", "body4", 0.75)],
        clearances: [
          {
            a: "body1",
            b: "body4",
            aName: "Box",
            bName: "Box",
            distance: 0.3,
            pointA: [5, 1, 2],
            pointB: [5.2, 1.1, 2.2],
          },
        ],
        unchecked: [{ id: "body4", name: "Box", reason: "is open" }],
      },
      [box("body1"), box("body3"), box("body4"), box("body9")],
      new Map([["body9", "Box 2"]]),
    );
    await panels.showInterference(0.5);
    const p = usePanelsStore().interference!;
    expect(p.clashes.map((c) => c.k)).toEqual(["Box ∩ Box 3", "Box 3 ∩ Box 4"]);
    expect(p.clearances.map((c) => c.k)).toEqual(["Box ↔ Box 4"]);
    expect(p.unchecked).toEqual(["Box 4 is open"]);
  });

  it("tints a clicked pair's faces on a layer of its own without selecting them, and drops the tint on a recheck or close", async () => {
    const bodies: Body[] = [
      { id: "body1", name: "Base", faceStart: 0, faceCount: 3 },
      { id: "body2", name: "Pin", faceStart: 3, faceCount: 2 },
      { id: "body5", name: "Cap", faceStart: 5, faceCount: 4 },
    ];
    const { panels, marks, selected } = rig({ ok: true, pairs: [] }, bodies);
    await panels.showInterference();
    marks.length = 0;
    panels.highlightInterference("body5", "body1");
    expect(marks).toEqual([
      { marks: [{ faceIds: [0, 1, 2, 5, 6, 7, 8], color: EDGE_HOVER_COLOR }], layer: "interference" },
    ]);
    panels.highlightInterference("body2", "body9");
    expect(marks.at(-1)).toEqual({ marks: [{ faceIds: [3, 4], color: EDGE_HOVER_COLOR }], layer: "interference" });
    panels.highlightInterference("body8", "body9");
    expect(marks.at(-1)).toEqual({ marks: null, layer: "interference" });
    panels.highlightInterference("body1", "body2");
    await panels.showInterference();
    expect(marks.at(-1)).toEqual({ marks: null, layer: "interference" });
    panels.highlightInterference("body1", "body2");
    panels.closeInterference();
    expect(marks.at(-1)).toEqual({ marks: null, layer: "interference" });
    expect(selected).toEqual([]);
  });
});

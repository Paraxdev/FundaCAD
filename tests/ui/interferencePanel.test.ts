import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import { usePanelsStore } from "../../src/stores/panels";
import type { InterferenceReply } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";

// The Interference panel against a hand-made engine: a body the engine could
// not judge is named with why, and its pairs are never reported as clear.

beforeEach(() => setActivePinia(createPinia()));

function rig(reply: InterferenceReply) {
  const statuses: { text: string; cls: string }[] = [];
  const deps = {
    store: {
      document: { features: [] } as unknown as CadDocument,
      buildState: { result: { bodies: [{}, {}] } },
      onDocChange: () => {},
      onOpen: () => {},
    },
    viewport: { setInterferenceOverlay: () => {} },
    geometry: { interference: async () => reply },
    hasBody: () => true,
    setStatus: (text: string, cls: string) => statuses.push({ text, cls }),
  } as unknown as PanelsDeps;
  return { panels: createPanels(deps), statuses };
}

describe("the Interference panel", () => {
  it("says no bodies overlap when every pair was checked", async () => {
    const { panels, statuses } = rig({ ok: true, pairs: [] });
    await panels.showInterference();
    expect(usePanelsStore().interference?.unchecked).toEqual([]);
    expect(statuses.at(-1)).toEqual({ text: "No interferences found", cls: "connected" });
  });

  it("names a body it could not judge, and does not call the check clean", async () => {
    const reason = "has faces that point the wrong way, at 65 of its edges the two faces disagree about which side is inside";
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
});

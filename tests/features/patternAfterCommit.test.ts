// A feature the app selected on commit is not one the user pointed Pattern at:
// box, fillet an edge, Pattern repeats the body instead of refusing the fillet.
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { createSelection } from "../../src/app/selection";
import { useSelectionStore } from "../../src/stores/selection";
import type { Engine } from "../../src/app/engine";

beforeEach(() => setActivePinia(createPinia()));

type Done = (id: string | null) => void;

function rig() {
  const selection = createSelection({ viewport: { highlightDatum: () => {} } } as unknown as Engine);
  const sel = useSelectionStore();
  const state = {
    done: null as Done | null,
    patterns: [] as { ids: string[]; features?: string[] }[],
    status: [] as string[],
  };
  const deps = {
    store: {
      document: {
        features: [
          { id: "bx", type: "box", length: 10, width: 10, height: 10 },
          { id: "fil", type: "fillet", edges: [], radius: 1 },
        ],
      },
      buildState: {
        result: { bodies: [{ id: "body1", name: "Body1", faceStart: 0, faceCount: 2, faceOwners: ["bx", "fil"] }] },
      },
    },
    viewport: { getSelectedBodies: () => [], getSelectedFaceIds: () => [] },
    edgeFeature: { start: (_k: string, done: Done) => { state.done = done; } },
    pressPull: { start: (done: Done) => { state.done = done; } },
    patternTool: {
      start: (_k: string, ids: string[], _done: Done, features?: string[]) => {
        state.patterns.push({ ids, ...(features ? { features } : {}) });
      },
    },
    toolBusy: () => false,
    hasBody: () => true,
    setStatus: (t: string) => { state.status.push(t); },
    selectFeature: selection.selectFeature,
    noteCommitted: () => {},
    getSelectedFeature: () => sel.featureId,
    getSelectedFeatureExplicit: () => sel.featureExplicit,
  } as unknown as FeatureStartersDeps;
  return { starters: createFeatureStarters(deps), state, selection, sel };
}

describe("Pattern after a commit", () => {
  for (const tool of ["startFillet", "startChamfer", "startPressPull"] as const) {
    it(`${tool}, commit, then Pattern gives a body pattern`, () => {
      const { starters, state, sel } = rig();
      starters[tool]();
      state.done!("fil");
      expect(sel.featureId).toBe("fil");
      expect(sel.featureExplicit).toBe(false);
      starters.startPattern("circular");
      expect(state.status).toEqual([]);
      expect(state.patterns).toEqual([{ ids: ["body1"] }]);
    });
  }

  it("still refuses the fillet when the user selects it", () => {
    const { starters, state, selection } = rig();
    selection.selectFeature("fil");
    starters.startPattern("circular");
    expect(state.patterns).toEqual([]);
    expect(state.status[0]).toContain("cannot be patterned");
  });
});

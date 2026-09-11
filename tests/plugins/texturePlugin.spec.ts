// The plugin, whole: what switching it on adds to the application, and what
// switching it off takes away.
//
// The other files here take one surface at a time. This one runs the real
// `activate(e)` against an engine it fakes, and then asks every surface the
// application has whether it can see a texture, the tool inventory, the
// selection toolbar, the icon registry, the history's mark, the properties
// panel's rows, the action dispatcher, the busy predicate. Then it tears the
// plugin down and asks all of them again.
//
// THE SECOND HALF IS THE POINT. A capability that can be switched off but whose
// verb stays in the toolbar, whose mark stays in the history and whose rows stay
// in the properties panel has not been switched off; it has been hidden badly.
// Every assertion below is paired with its opposite after `stop()`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { activate } from "../../plugins/FundaCAD.Texture/main";
import * as panel from "../../plugins/FundaCAD.Texture/panel";
import {
  anyToolBusy,
  contributedAction,
  contributedOverlays,
  contributedRibbon,
  contributors,
  resetContributions,
} from "../../src/plugins/contrib";
import { applicableTools, capabilityOf } from "../../src/features/toolCapabilities";
import { selectionOffers } from "../../src/ui/selectionTools";
import { iconPaths } from "../../src/ui/icons";
import { featureMeta } from "../../src/ui/featureMeta";
import {
  choiceFieldsFor, fieldApplies, fieldLabel, fileFieldsFor, fileValue,
  hasOptionFields, toggleFieldsFor,
} from "../../src/document/optionFields";
import type { Feature } from "../../src/types";
import type { Engine } from "../../src/app/engine";

/** The engine surface `activate` actually touches: a viewport, a store, and the
 *  five predicates a starter is guarded by. */
function fakeEngine() {
  const state = { faceIds: [] as number[], bodyIds: [] as string[], hasBody: true, status: "" };
  const viewport = {
    get selecting() { return "faces"; },
    setSelectionMode: () => {},
    getSelectedFaceIds: () => [...state.faceIds],
    getSelectedBodies: () => [...state.bodyIds],
    selectFaces: (ids: number[]) => { state.faceIds = [...ids]; },
    setSelectedBodies: (ids: string[]) => { state.bodyIds = [...ids]; },
    clearSelection: () => { state.faceIds = []; },
    faceIdToBodyId: () => "body1",
    faceIdNear: () => null,
    selectedFacesForPressPull: () => null,
  };
  const store = {
    document: { features: [] },
    buildState: { result: { bodies: [] } },
    nextId: () => "t1",
    bodyName: () => null,
    isParamBound: () => false,
    onBuild: () => () => {},
    setPreview: () => {},
    setEditPreview: () => {},
    beginEditPreview: () => {},
    endEditPreview: () => {},
    addFeature: () => {},
    replaceFeature: () => {},
  };
  const e = {
    viewport,
    store,
    toolBusy: () => false,
    hasBody: () => state.hasBody,
    setStatus: (t: string) => { state.status = t; },
    noteCommitted: vi.fn(),
    selectFeature: vi.fn(),
  };
  return { e: e as unknown as Engine, state };
}

describe("the Texture plugin, switched on and off", () => {
  let stop: () => void;
  let engine: ReturnType<typeof fakeEngine>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    panel.resetPanel();
    engine = fakeEngine();
    stop = await activate(engine.e);
  });

  afterEach(() => {
    stop();
    panel.resetPanel();
    resetContributions();
  });

  it("registers under its own id and nothing else's", () => {
    expect(contributors()).toEqual(["FundaCAD.Texture"]);
  });

  describe("the tool", () => {
    it("joins the inventory as a peer of the application's own", () => {
      expect(capabilityOf("texture")).toMatchObject({
        label: "Texture", consumes: ["face", "body"], source: "selection", icon: "texture",
      });
      expect(applicableTools({ face: 1 })).toContain("texture");
      expect(applicableTools({ body: 1 })).toContain("texture");
    });

    // The surface a tool with only a ribbon button would have missed: selecting
    // a face has to OFFER it, beside Fillet and Press/Pull.
    it("is offered to a face selection, with its own mark and its own action", () => {
      const offer = selectionOffers({ face: 1 }).find((o) => o.tool === "texture");
      expect(offer).toBeDefined();
      expect(offer).toMatchObject({ label: "Texture", iconName: "texture", action: "texture", enabled: true });
    });

    it("claims the action the ribbon and the palette dispatch", () => {
      expect(contributedAction("texture")).toBeTypeOf("function");
      const item = contributedRibbon().flatMap((g) => g.items).find((i) => i.action === "texture");
      expect(item).toMatchObject({ label: "Texture", iconName: "texture" });
    });

    it("runs from that action, and then holds the window", () => {
      expect(anyToolBusy()).toBe(false);
      contributedAction("texture")!();
      expect(panel.isOpen()).toBe(true);
      expect(anyToolBusy()).toBe(true);
    });

    it("refuses to run on a document with nothing in it, and says why", () => {
      engine.state.hasBody = false;
      contributedAction("texture")!();
      expect(panel.isOpen()).toBe(false);
      expect(anyToolBusy()).toBe(false);
      expect(engine.state.status).toContain("create or import a body first");
    });
  });

  describe("the view", () => {
    it("mounts one overlay, under a key of the plugin's own", () => {
      const mine = contributedOverlays().filter((o) => o.key.startsWith("FundaCAD.Texture:"));
      expect(mine).toHaveLength(1);
    });
  });

  describe("the mark", () => {
    it("draws a texture the application has no icon for", () => {
      expect(iconPaths("texture")).toContain("<rect");
    });
  });

  describe("the feature it leaves behind", () => {
    it("has a name and a mark in the history", () => {
      expect(featureMeta({ type: "texture" })).toEqual({ icon: "texture", label: "Texture" });
    });

    it("has the dropdowns and the switch its values are edited with", () => {
      expect(hasOptionFields("texture")).toBe(true);
      expect(choiceFieldsFor("texture").map((c) => c.field)).toEqual(["kind", "profile", "direction", "projection"]);
      expect(toggleFieldsFor("texture").map((t) => t.field)).toEqual(["invert"]);
    });

    // The gap this closes: picking Heightmap in Properties changed the pattern
    // to the one that reads an image, and there was nowhere to say WHICH image.
    // `fieldApplies` had answered the question for a long time; no kind of row
    // could show a path, so nothing read the answer.
    it("has a row for the heightmap, and only under the pattern that reads one", () => {
      const files = fileFieldsFor("texture");
      expect(files.map((f) => f.field)).toEqual(["imagePath"]);
      expect(files[0]!.filters?.[0]!.extensions).toContain("png");
      expect(fieldApplies("texture", "imagePath", { kind: "image" })).toBe(true);
      expect(fieldApplies("texture", "imagePath", { kind: "knurl" })).toBe(false);
    });

    it("shows the path a texture carries, and an empty row when it carries none", () => {
      const f = fileFieldsFor("texture")[0]!;
      const withPath = { id: "t1", type: "texture", imagePath: "C:/img/relief.png" };
      expect(fileValue(withPath as unknown as Feature, f)).toBe("C:/img/relief.png");
      expect(fileValue({ id: "t1", type: "texture" } as unknown as Feature, f)).toBe("");
    });

    // The rule that governs the APPLICATION'S OWN numeric rows. The application
    // keeps `seed` and `angle` because a parameter can drive them; the plugin
    // decides which of them a given pattern actually reads.
    it("decides which of the application's value rows a pattern reads", () => {
      expect(fieldApplies("texture", "seed", { kind: "knurl" })).toBe(false);
      expect(fieldApplies("texture", "seed", { kind: "noise" })).toBe(true);
      expect(fieldApplies("texture", "angle", { kind: "knurl" })).toBe(true);
      expect(fieldApplies("texture", "angle", { kind: "noise" })).toBe(false);
      expect(fieldApplies("texture", "depth", { kind: "knurl" })).toBe(true);
    });

    it("renames the one row whose name is not a constant", () => {
      expect(fieldLabel("texture", "sharpness", { profile: "facet" })?.text).toBe("Land");
      expect(fieldLabel("texture", "sharpness", { profile: "round" })?.text).toBe("Sharp");
      expect(fieldLabel("texture", "depth", {})).toBeNull();
    });

    it("says nothing about a feature that is not its own", () => {
      expect(fieldApplies("fillet", "radius", {})).toBe(true);
      expect(fieldLabel("fillet", "radius", {})).toBeNull();
      expect(featureMeta({ type: "fillet" }).label).toBe("Fillet");
    });
  });

  describe("switching it off", () => {
    it("takes every surface back", () => {
      stop();
      stop = () => {}; // afterEach must not stop it twice

      expect(contributors()).toEqual([]);
      expect(capabilityOf("texture")).toBeNull();
      expect(applicableTools({ face: 1 })).not.toContain("texture");
      expect(selectionOffers({ face: 1 }).some((o) => o.tool === "texture")).toBe(false);
      expect(contributedAction("texture")).toBeNull();
      expect(contributedRibbon().flatMap((g) => g.items).some((i) => i.action === "texture")).toBe(false);
      expect(contributedOverlays()).toEqual([]);
      expect(iconPaths("texture")).toBe("");
      expect(featureMeta({ type: "texture" })).toEqual({ icon: "dot", label: "texture" });
      expect(hasOptionFields("texture")).toBe(false);
      expect(choiceFieldsFor("texture")).toEqual([]);
      expect(fileFieldsFor("texture")).toEqual([]);
      expect(anyToolBusy()).toBe(false);
    });

    // Reachable in one click: the plugins panel is open while a tool is running.
    // Without the cancel in the teardown the document is left rolled back to a
    // point in its own history, with no panel on screen and no way back.
    it("cancels a gesture that was still running", () => {
      contributedAction("texture")!();
      expect(panel.isOpen()).toBe(true);

      stop();
      stop = () => {};

      expect(panel.isOpen()).toBe(false);
      expect(anyToolBusy()).toBe(false);
    });

    it("can be switched on again and works", async () => {
      stop();
      const again = await activate(engine.e);
      expect(applicableTools({ face: 1 })).toContain("texture");
      contributedAction("texture")!();
      expect(panel.isOpen()).toBe(true);
      again();
      stop = () => {};
    });
  });
});

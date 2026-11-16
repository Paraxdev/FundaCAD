// The prompts, labels and refusals of the pattern, move, mirror, loft, measure, section and datum tools read in the
// chosen language, and a measure prompt that is already on screen follows a switch.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { setLanguage } from "../../src/i18n";
import { BOOLEAN_COMMANDS, BOOLEAN_LABEL } from "../../src/features/booleanOps";
import { MATERIAL_PRESETS } from "../../src/features/filamentEstimate";
import { curvedFaceRow } from "../../src/features/facePlanePick";
import { describeAxis } from "../../src/features/patternAxis";
import { describePattern, describeRect } from "../../src/features/patternMath";
import { patternSources } from "../../src/features/patternSources";
import { ghostName } from "../../src/features/sectionMath";
import { measureRows, type MeasureProbe } from "../../src/features/measureRows";
import { mirrorFeatures } from "../../src/features/mirrorMath";
import { MeasureTool } from "../../src/features/measureTool";
import { usePromptStore } from "../../src/stores/prompt";
import { useToolPanelStore } from "../../src/stores/toolPanels";
import { resetTreePicks } from "../../src/ui/treePick";
import type { Feature } from "../../src/types";
import type { Viewport } from "../../src/viewport/viewport";

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const face: MeasureProbe = { kind: "face", area: 50, point: V(1, 2, 3), dir: V(0, 0, 1) };

beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  resetTreePicks();
  await setLanguage("system");
});

describe("tool lines in German", () => {
  beforeEach(() => setLanguage("de"));

  it("words the pattern summaries and its axis", () => {
    expect(describePattern("linear", 3, 12.5, "X")).toBe("3 Kopien, 12,5 mm Abstand entlang X");
    expect(describePattern("circular", 1, 90, "Z")).toBe("1 Kopie über 90° um Z");
    expect(describeRect(2, 3, 10, 20)).toContain("2");
    expect(describeAxis("Y", undefined)).toBe("Y durch den Ursprung");
    expect(describeAxis(null, { kind: "x" })).toBe("am Modell gewählt");
  });

  it("refuses a pattern source in German, with the German name of its type", () => {
    const features = [{ id: "f1", type: "fillet" }] as unknown as Feature[];
    const [refusal] = patternSources(features, ["f1"]).refused;
    expect(refusal!.reason.startsWith("Muster: ")).toBe(true);
    expect(refusal!.reason).not.toContain("cannot be patterned");
  });

  it("words the readout rows with the measure labels", () => {
    expect(measureRows(undefined, undefined, null)).toEqual([{ k: "", v: "Wählen Sie eine Fläche oder Kante" }]);
    expect(measureRows(face, undefined, null).map((r) => r.k)).toEqual(["Flächeninhalt", "Position"]);
  });

  it("follows the language for the shared rows, ghost levels, boolean names and the nylon preset", () => {
    expect(curvedFaceRow()).toBe("Diese Fläche ist gekrümmt, wählen Sie eine ebene Fläche oder eine Ebene");
    expect(ghostName(0)).toBe("ausgeblendet");
    expect(BOOLEAN_COMMANDS.map((c) => c.label)).toContain("Vereinigen");
    expect(BOOLEAN_LABEL.union).toBe("Vereinigen");
    expect(MATERIAL_PRESETS.find((m) => m.id === "nylon")!.label).toBe("Nylon");
  });

  it("names the datum made from a mirror face in German", () => {
    let n = 0;
    const out = mirrorFeatures(() => `n${++n}`, ["b1"], {
      kind: "face",
      face: { def: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, selector: { kind: "face" } } as never,
    });
    expect((out[0] as { name?: string }).name).toBe("Spiegelebene");
  });
});

describe("tool lines in Japanese", () => {
  beforeEach(() => setLanguage("ja"));

  it("words the pattern summary, the curved face row and the nylon label", () => {
    expect(describePattern("linear", 3, 12.5, "X")).toBe("X 方向に 12.5 mm 間隔で3個のコピー");
    expect(curvedFaceRow()).toBe("その面は曲面です。平らな面か平面を選んでください");
    expect(MATERIAL_PRESETS.find((m) => m.id === "nylon")!.label).toBe("ナイロン");
    expect(ghostName(0)).not.toBe("hidden");
  });
});

describe("the Measure prompt on screen follows a language switch", () => {
  it("rewrites the prompt and the readout rows when the language changes while the tool is active", async () => {
    const el = document.createElement("canvas");
    const vp = {
      suspendPicking: false,
      domElement: el,
      clearSelection: () => {},
      hoverEntity: () => {},
      setMeasureMarker: () => {},
      measureHighlight: () => {},
      pickEntity: () => null,
    } as unknown as Viewport;
    const tool = new MeasureTool(vp);
    tool.start();
    expect(usePromptStore().text).toBe("Click a face or edge, then a second one · Esc");
    expect(useToolPanelStore().measure).toEqual([{ k: "", v: "Pick a face or edge" }]);
    await setLanguage("de");
    expect(usePromptStore().text).toBe("Klicken Sie auf eine Fläche oder Kante, dann auf eine zweite · Esc");
    expect(useToolPanelStore().measure).toEqual([{ k: "", v: "Wählen Sie eine Fläche oder Kante" }]);
    tool.stop();
    expect(usePromptStore().text).toBeNull();
  });
});

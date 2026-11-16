// The prompts, labels and dialogs of the edge, push pull, extrude, draft and hole tools read in the chosen language,
// the tables that were module constants follow a switch, and a prompt is composed again after one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { setLanguage } from "../../src/i18n";
import { blendRefusalReason, treatmentLabel } from "../../src/features/edgeDragMath";
import { missPrompt } from "../../src/features/blendPick";
import { walkWords } from "../../src/features/profileWalk";
import { badHoleSizeText } from "../../src/features/holeStandards";
import { DIRECTION_LABEL } from "../../src/features/pressPullAxis";
import { OP_WORD } from "../../src/features/extrudeOperation";
import { CONTINUITY_SEGMENTS } from "../../src/features/edgeFeatureTool";
import { confirmEdgeCount } from "../../src/features/edgeCountGate";
import { DraftTool } from "../../src/features/draftTool";
import { usePromptStore } from "../../src/stores/prompt";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector } from "../../src/types";

const choose = vi.hoisted(() => vi.fn());
vi.mock("../../src/ui/choice", () => ({ choose }));

const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;

beforeEach(() => {
  setActivePinia(createPinia());
  choose.mockReset();
});
afterEach(async () => {
  await setLanguage("system");
  document.body.innerHTML = "";
});

describe("messages built from whole sentences", () => {
  it("names the blend in the chosen language and keeps the counts", async () => {
    expect(treatmentLabel("chamfer")).toBe("Chamfer");
    await setLanguage("de");
    expect(treatmentLabel("chamfer")).toBe("Fase");
    expect(treatmentLabel("fillet")).toBe("Verrundung");
    expect(blendRefusalReason("chamfer", 1, { code: "blendHasNoEnd", message: "" })).toContain("die Fase");
    expect(blendRefusalReason("fillet", 3, { code: "edgeAlreadySmooth", message: "" })).toContain(
      "Diese Kanten sind bereits glatt",
    );
    expect(missPrompt("fillet", 2)).toContain("2 Kanten");
    await setLanguage("ja");
    expect(treatmentLabel("chamfer")).toBe("面取り");
    expect(blendRefusalReason("fillet", 2, { code: "blendHasNoEnd", message: "" })).toMatch(JAPANESE);
    expect(missPrompt("chamfer", 1)).toContain("1 本");
  });

  it("walks the profiles of an extrude with the area, the holes and whether it is picked", async () => {
    const unit = { area: 100, holes: 2, members: [{}, {}] } as never;
    expect(walkWords(unit, 0, 3, true)).toMatch(/^Profile 1 of 3/);
    await setLanguage("de");
    const de = walkWords(unit, 0, 3, true);
    expect(de).toMatch(/^Profil 1 von 3/);
    expect(de).toContain("2 Löcher");
    expect(de).toContain("ausgewählt");
    expect(walkWords(unit, 0, 3, false)).not.toContain("ausgewählt");
    await setLanguage("ja");
    expect(walkWords(unit, 1, 3, true)).toMatch(/^プロファイル 2\/3/);
  });

  it("explains a hole size nobody can use, quoting what was typed", async () => {
    await setLanguage("de");
    expect(badHoleSizeText(" x9 ")).toContain('"x9"');
    expect(badHoleSizeText("x9")).toContain("M2 bis M20");
    await setLanguage("ja");
    expect(badHoleSizeText("x9")).toContain("「x9」");
  });

  it("asks before a big blend in the chosen language and answers from the button", async () => {
    choose.mockResolvedValue("go");
    await setLanguage("de");
    expect(await confirmEdgeCount("Fillet", 4000)).toBe(true);
    const [title, buttons, , body] = choose.mock.calls[0]!;
    expect(title).toBe("Verrundung für 4000 Kanten?");
    expect(body).toContain("4000");
    expect(buttons.map((b: { value: string }) => b.value)).toEqual(["cancel", "go"]);
    expect(buttons[0].label).not.toBe("Cancel");
    choose.mockResolvedValue("ok");
    expect(await confirmEdgeCount("Chamfer", 9000)).toBe(false);
    expect(choose.mock.calls[1]![0]).toContain("Fase");
  });
});

describe("tables that follow a switch", () => {
  it("read English first and then German or Japanese on the same objects", async () => {
    const direction = DIRECTION_LABEL;
    const ops = OP_WORD;
    const segments = CONTINUITY_SEGMENTS;
    const ids = segments.map((s) => s.id);
    expect(direction.normal).toBe("Along normal");
    expect(ops.cut).toBe("Cut");
    const english = segments.map((s) => s.label);
    await setLanguage("de");
    expect(direction.normal).toBe("Entlang der Normalen");
    expect(ops.new).toBe("Neuer Körper");
    expect(segments.map((s) => s.id)).toEqual(ids);
    expect(segments.map((s) => s.label)).not.toEqual(english);
    await setLanguage("ja");
    expect(direction.normal).toBe("法線方向");
    expect(ops.cut).toBe("切り取り");
    expect(CONTINUITY_SEGMENTS).toBe(segments);
  });
});

const FACE: Selector = { kind: "face", by: "nearest", point: [0, 0, 0] };

function fakeViewport() {
  const canvas = document.createElement("canvas");
  const scene = new THREE.Scene();
  return {
    suspendPicking: false,
    domElement: canvas,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    probe: () => null,
    clearHover: () => {},
    hoverFaceAt: () => null,
    selectedFacesForPressPull: () => ({
      selectors: [FACE],
      faceIds: [7],
      normal: new THREE.Vector3(1, 0, 0),
      anchor: new THREE.Vector3(0, 0, 5),
      bodyId: "b1",
    }),
  } as unknown as Viewport;
}

function fakeStore() {
  return {
    nextId: () => "p1",
    boundExpr: () => null,
    setPreview: (_f: Feature | null) => {},
    addFeature: () => {},
    verifyCommit: () => {},
    hasPreview: false,
    previewError: null,
    buildState: { building: false, result: null },
  } as unknown as DocumentStore;
}

describe("a tool prompt", () => {
  it("reads in the language the tool was started in and is composed again after a switch", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const tool = new DraftTool(fakeViewport(), fakeStore());
      tool.start(() => {});
      expect(usePromptStore().text).toMatch(/drag or type an angle/);
      await setLanguage("de");
      (tool as unknown as { prompt(): void }).prompt();
      expect(usePromptStore().text).toMatch(/Winkel ein \(max\. \d+°\)/);
      expect(usePromptStore().text).toContain("Klick bestätigt");
      await setLanguage("ja");
      (tool as unknown as { prompt(): void }).prompt();
      expect(usePromptStore().text).toContain("角度を入力");
      tool.cancel?.();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

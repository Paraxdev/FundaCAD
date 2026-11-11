// Feature names follow the picked language; numbering and English sentences do not.
//
// Readers of a feature's name, each classified (grep of featureMeta, stepName, numberedName, labelOf, FEATURE_META):
//   translated, the name stands alone or lands in a line that goes through t():
//     TimelineBar.vue chips and rename placeholder, geometryBrowser.ts ownerNamesOf (Items), readouts.ts,
//     describeModel.ts, ParamsDialog.vue targetLabel, TargetEditPanel.vue, ToolRail.vue unnamed sketch,
//     patternSources.featureLabel (the Features row).
//   English, the name lands in a raw English sentence another lane owns (featureEnglish, stepEnglish, numberedEnglish):
//     rebuildBridge.ts failure toast, plainError.ts sketchConflictText, contextMenus.ts "Edit X",
//     patternSources.refusalReason, viewportWiring.ts edge picker, announcements.ts build line, VersionsPanel.vue
//     summary, stepLabels.ts and store.ts undo and toast labels.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installRebuildBridge } from "../../src/app/rebuildBridge";
import type { Engine } from "../../src/app/engine";
import { SessionHost } from "../../src/document/session";
import type { RebuildState } from "../../src/document/store";
import { BOOLEAN_COMMANDS } from "../../src/features/booleanOps";
import { patternSources } from "../../src/features/patternSources";
import { setLanguage, t, type MessageKey } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import ja from "../../src/i18n/locales/ja.json";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import { useContextMenuStore } from "../../src/stores/contextMenu";
import { createContextMenus, type ContextMenusDeps } from "../../src/ui/contextMenus";
import {
  FEATURE_META,
  featureEnglish,
  featureMeta,
  numberedEnglish,
  numberedName,
  stepEnglish,
  stepName,
} from "../../src/ui/featureMeta";
import { sketchConflictText } from "../../src/ui/plainError";
import type { Feature } from "../../src/types";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../src/ui/toast", () => ({
  toast: (m: string) => {
    toasts.push(m);
    return 1;
  },
}));

afterEach(async () => {
  resetContributions();
  await setLanguage("system");
});

// type, key, today's English
const TABLE: [string, MessageKey, string][] = [
  ["sketch", "tool.sketch", "Sketch"],
  ["extrude", "tool.extrude", "Extrude"],
  ["fillet", "tool.fillet", "Fillet"],
  ["chamfer", "tool.chamfer", "Chamfer"],
  ["press-pull", "tool.pressPull", "Press/Pull"],
  ["deleteFace", "feature.deleteFace", "Delete Face"],
  ["mirror", "tool.mirror", "Mirror"],
  ["revolve", "tool.revolve", "Revolve"],
  ["loft", "tool.loft", "Loft"],
  ["sweep", "tool.sweep", "Sweep"],
  ["datumPlane", "tool.datumPlane", "Datum Plane"],
  ["datumPoint", "tool.datumPoint", "Datum Point"],
  ["datumAxis", "tool.datumAxis", "Datum Axis"],
  ["import", "feature.import", "Import"],
  ["split", "tool.splitBody", "Split Body"],
  ["separate", "tool.separate", "Separate"],
  ["imprint", "feature.divideFace", "Divide Face"],
  ["boolean", "tool.family.boolean", "Boolean"],
  ["box", "feature.box", "Box"],
  ["cylinder", "feature.cylinder", "Cylinder"],
  ["cone", "feature.cone", "Cone"],
  ["sphere", "feature.sphere", "Sphere"],
  ["torus", "feature.torus", "Torus"],
  ["shell", "tool.shell", "Shell"],
  ["offsetFace", "tool.offsetFace", "Offset Face"],
  ["thicken", "tool.thicken", "Thicken"],
  ["draft", "tool.draft", "Draft"],
  ["hole", "tool.hole", "Hole"],
  ["thread", "tool.thread", "Thread"],
  ["textOnFace", "tool.textOnFace", "Text on Face"],
  ["patternRect", "tool.rectPattern", "Rect Pattern"],
  ["patternLinear", "tool.linearPattern", "Linear Pattern"],
  ["patternCircular", "tool.circularPattern", "Circular Pattern"],
  ["simplifyMesh", "tool.simplifyMesh", "Simplify Mesh"],
  ["cleanUp", "tool.cleanUp", "Clean Up"],
  ["scale", "tool.scale", "Scale"],
  ["move", "tool.move", "Move"],
  ["duplicate", "feature.duplicate", "Duplicate"],
  ["joint", "tool.joint", "Joint"],
  ["mechanism", "tool.mechanism", "Mechanism"],
  ["removeBody", "feature.removeBody", "Remove Body"],
];

const BOOLEAN_NAMES: [string, MessageKey, string][] = [
  ["union", "tool.union", "Union"],
  ["subtract", "tool.subtract", "Subtract"],
  ["intersect", "tool.intersect", "Intersect"],
];

const LOCALES = [
  ["de", de],
  ["ja", ja],
] as const;
const line = (file: Record<string, string>, key: MessageKey) => file[key]!;

describe("a feature type's name", () => {
  it("is today's English with no language picked", () => {
    expect(Object.keys(FEATURE_META)).toEqual(TABLE.map(([type]) => type));
    expect(TABLE.map(([type]) => featureMeta({ type }).label)).toEqual(TABLE.map(([, , english]) => english));
  });

  it.each(LOCALES)("reads its key's line in %s, the rail's word where the rail has one", async (code, file) => {
    await setLanguage(code);
    expect(TABLE.map(([type]) => featureMeta({ type }).label)).toEqual(TABLE.map(([, key]) => line(file, key)));
    expect(featureMeta({ type: "fillet" }).label).toBe(t("tool.fillet"));
    expect(featureMeta({ type: "datumPlane" }).label).toBe(t("tool.datumPlane"));
  });

  it("is a getter, so the same entry follows a switch", async () => {
    const entry = FEATURE_META.hole!;
    const english = entry.label;
    await setLanguage("de");
    expect([english, entry.label]).toEqual(["Hole", line(de, "tool.hole")]);
    await setLanguage("ja");
    expect(entry.label).toBe(line(ja, "tool.hole"));
  });

  it("keeps the icon of every entry through a switch", async () => {
    const icons = TABLE.map(([type]) => featureMeta({ type }).icon);
    await setLanguage("de");
    expect(TABLE.map(([type]) => featureMeta({ type }).icon)).toEqual(icons);
  });

  it("names a boolean by its operation, and an unknown operation by the Boolean word", async () => {
    for (const code of ["en", "de", "ja"] as const) {
      await setLanguage(code);
      const file = code === "de" ? de : code === "ja" ? ja : null;
      expect(BOOLEAN_NAMES.map(([op]) => featureMeta({ type: "boolean", operation: op }).label)).toEqual(
        BOOLEAN_NAMES.map(([, key, english]) => (file ? line(file, key) : english)),
      );
      expect(featureMeta({ type: "boolean", operation: "xor" }).label).toBe(
        file ? line(file, "tool.family.boolean") : "Boolean",
      );
      expect(featureMeta({ type: "boolean" }).label).toBe(file ? line(file, "tool.family.boolean") : "Boolean");
    }
    expect(BOOLEAN_COMMANDS.map((c) => featureMeta({ type: "boolean", operation: c.op }).icon)).toEqual(
      BOOLEAN_COMMANDS.map((c) => c.iconName),
    );
  });

  it("names a thin extrude on, and a plain one off, in each language", async () => {
    await setLanguage("de");
    expect([true, false, "yes", undefined].map((thin) => featureMeta({ type: "extrude", thin }).label)).toEqual([
      line(de, "feature.thinExtrude"),
      line(de, "tool.extrude"),
      line(de, "tool.extrude"),
      line(de, "tool.extrude"),
    ]);
    await setLanguage("system");
    expect(featureMeta({ type: "extrude", thin: true })).toMatchObject({ icon: "extrude", label: "Thin extrude" });
    expect(featureMeta({ type: "extrude", thin: false }).label).toBe("Extrude");
  });

  it("is the raw type for a type nothing knows, in any language", async () => {
    await setLanguage("de");
    expect(featureMeta({ type: "zigzag" })).toEqual({ icon: "dot", label: "zigzag" });
    expect(featureEnglish({ type: "zigzag" })).toBe("zigzag");
  });
});

describe("the English name", () => {
  it("stays English in German and Japanese, for every type, boolean and thin extrude", async () => {
    for (const code of ["de", "ja"] as const) {
      await setLanguage(code);
      expect(TABLE.map(([type]) => featureEnglish({ type }))).toEqual(TABLE.map(([, , english]) => english));
      expect(BOOLEAN_NAMES.map(([op]) => featureEnglish({ type: "boolean", operation: op }))).toEqual(
        BOOLEAN_NAMES.map(([, , english]) => english),
      );
      expect(featureEnglish({ type: "extrude", thin: true })).toBe("Thin extrude");
    }
  });

  it("is the refName of a plugin feature whose label follows the language, else its label", async () => {
    contribute("Gears", {
      features: [
        {
          type: "gear",
          meta: {
            icon: "gear",
            get label() {
              return t("feature.cylinder");
            },
            refName: "Gear",
          },
        },
        { type: "rack", meta: { icon: "rack", label: "Rack" } },
      ],
    });
    await setLanguage("de");
    expect([featureMeta({ type: "gear" }).label, featureEnglish({ type: "gear" })]).toEqual([
      line(de, "feature.cylinder"),
      "Gear",
    ]);
    expect([featureMeta({ type: "rack" }).label, featureEnglish({ type: "rack" })]).toEqual(["Rack", "Rack"]);
    expect(stepEnglish({ type: "gear" })).toBe("Gear");
    expect(stepEnglish({ type: "gear", name: "Drive gear" })).toBe("Drive gear");
  });
});

type Step = { id: string; type: string; name?: string; operation?: unknown; thin?: unknown };
const step = (id: string, type: string, extra: object = {}): Step => ({ id, type, ...extra });
const LIST: Step[] = [
  step("a", "extrude"),
  step("b", "fillet"),
  step("c", "fillet", { name: "Rounding" }),
  step("d", "fillet"),
  step("e", "extrude"),
  step("f", "fillet"),
  step("g", "fillet"),
];
const PLACES = [1, 1, null, 3, 2, 4, 5];

describe("numbering", () => {
  it("counts earlier steps of the same type: none, one and several, a named one counted but shown as typed", () => {
    expect(LIST.map((f) => numberedName(f, LIST))).toEqual([
      "Extrude 1",
      "Fillet 1",
      "Rounding",
      "Fillet 3",
      "Extrude 2",
      "Fillet 4",
      "Fillet 5",
    ]);
    expect(numberedName(LIST[1]!, LIST.slice(0, 2))).toBe("Fillet 1");
    expect(numberedName({ id: "z", type: "fillet" }, LIST)).toBe("Fillet");
  });

  it.each(LOCALES)("joins the name and the place the language's way in %s, with the same place", async (code, file) => {
    await setLanguage(code);
    const fillet = line(file, "tool.fillet");
    const extrude = line(file, "tool.extrude");
    expect(LIST.map((f) => numberedName(f, LIST))).toEqual([
      `${extrude} 1`,
      `${fillet} 1`,
      "Rounding",
      `${fillet} 3`,
      `${extrude} 2`,
      `${fillet} 4`,
      `${fillet} 5`,
    ]);
    expect(LIST.map((f) => /(\d+)$/.exec(numberedName(f, LIST))?.[1] ?? null)).toEqual(
      PLACES.map((n) => (n === null ? null : String(n))),
    );
  });

  it("shows a typed name as typed in every language, even one that equals an English type name", async () => {
    const named = [step("n", "fillet", { name: "Fillet" }), step("m", "fillet", { name: "Verrundung" })];
    for (const code of ["en", "de", "ja"] as const) {
      await setLanguage(code);
      expect(named.map((f) => numberedName(f, named))).toEqual(["Fillet", "Verrundung"]);
      expect(named.map((f) => stepName(f))).toEqual(["Fillet", "Verrundung"]);
    }
  });

  it("gives the English place and name in German and Japanese", async () => {
    for (const code of ["de", "ja"] as const) {
      await setLanguage(code);
      expect(LIST.map((f) => numberedEnglish(f, LIST))).toEqual([
        "Extrude 1",
        "Fillet 1",
        "Rounding",
        "Fillet 3",
        "Extrude 2",
        "Fillet 4",
        "Fillet 5",
      ]);
      expect(stepEnglish(LIST[0]!)).toBe("Extrude");
    }
  });

  it("counts two plugin types that share a word apart, by their English names, and one without refName by its label", async () => {
    const shared = {
      get label() {
        return t("feature.cylinder");
      },
    };
    contribute("Gears", {
      features: [
        { type: "spur", meta: { icon: "g", ...shared, refName: "Spur gear" } },
        { type: "helical", meta: { icon: "g", ...shared, refName: "Helical gear" } },
        { type: "plain", meta: { icon: "g", label: "Plain" } },
      ],
    });
    await setLanguage("de");
    const list = [step("1", "spur"), step("2", "helical"), step("3", "spur"), step("4", "plain"), step("5", "plain")];
    const places = list.map((f) => numberedEnglish(f, list));
    expect(places).toEqual(["Spur gear 1", "Helical gear 1", "Spur gear 2", "Plain 1", "Plain 2"]);
    expect(list.map((f) => /(\d+)$/.exec(numberedName(f, list))?.[1])).toEqual(["1", "1", "2", "1", "2"]);
  });
});

describe("the English sentences that name a feature", () => {
  it("keep the English name in German: the pattern refusal, the sketch conflict, the failure toast, the face menu", async () => {
    await setLanguage("de");
    const features = [
      { id: "s1", type: "sketch" },
      { id: "f1", type: "fillet" },
      { id: "m1", type: "sweep", operation: "new" },
    ] as unknown as Feature[];

    const refused = patternSources(features, ["f1", "m1"]).refused;
    expect(refused.map((r) => r.id)).toEqual(["f1", "m1"]);
    expect(refused[0]!.reason).toMatch(/^Pattern: Fillet is a fillet, which cannot be patterned\./);
    expect(refused[1]!.reason).toMatch(/^Pattern: Sweep has no cut or join/);
    expect(refused.map((r) => r.reason).join(" ")).not.toContain(line(de, "tool.fillet"));

    expect(sketchConflictText("s1", features)).toBe(
      "The dimensions in Sketch 1 conflict, so the sketch was left as it was",
    );

    setActivePinia(createPinia());
    const builds: ((s: RebuildState) => void)[] = [];
    const store = {
      document: { features: [{ id: "f1", type: "fillet" }] },
      buildState: { result: null },
      hasPreview: false,
      previewError: null,
      rollbackIndex: 1,
      onBuild: (fn: (s: RebuildState) => void) => builds.push(fn),
      onBuildChunk: () => {},
      onBuildAbort: () => {},
      onOpen: () => {},
      sessions: new SessionHost(),
      materialPaint: () => ({}),
      materialFinishes: () => ({}),
      faceMaterialEntries: () => [],
      hiddenFaceMaterials: () => [],
      materialLibrary: [],
      importColorSource: () => undefined,
      isBodyVisible: () => true,
    };
    installRebuildBridge({
      store,
      viewport: new Proxy({}, { get: () => () => {} }),
      ui: { panels: { refreshStressMarks: () => {} } },
      sketch: { active: false },
      toolBusy: () => false,
      overlay: { regions: [] },
      syncDatumPlanes: () => {},
    } as unknown as Engine);
    toasts.length = 0;
    const result = { mesh: { positions: [0, 0, 0], indices: [], faceIds: [] }, edges: [], bodies: [] };
    for (const fn of builds)
      fn({
        building: false,
        result: { ...result, featureErrors: [{ feature_id: "f1", message: "Radius 7.25 is larger than the edge" }] },
      } as unknown as RebuildState);
    expect(toasts).toEqual(["Fillet failed: Radius 7.25 is larger than the edge"]);

    const menus = createContextMenus({
      sketch: { active: false },
      store: { document: { features: [{ id: "x1", type: "extrude" }] }, faceAxis: async () => null },
      viewport: {
        facePlanePick: () => null,
        faceIdToBodyId: () => "body1",
      },
      toolBusy: () => false,
      dropBodyGizmo: () => {},
      setStatus: () => {},
      featureForFace: () => "x1",
      getLastAction: () => null,
    } as unknown as ContextMenusDeps);
    menus.openFaceMenu(10, 20, {
      kind: "face",
      faceId: 4,
      selector: { kind: "face", by: "nearest", point: [23.5, 7.25, 3] },
      point: [23.5, 7.25, 3],
    });
    const labels = useContextMenuStore().items.map((i) => i.label);
    expect(labels.filter((l) => /Extrude/.test(l))).toEqual(["Edit Extrude"]);
    expect(labels.join("|")).not.toContain(line(de, "tool.extrude"));
  });
});

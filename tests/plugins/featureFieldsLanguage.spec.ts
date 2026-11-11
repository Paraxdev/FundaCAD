// A plugin's feature rows speak the language through the plugin's own lines (pluginText), with no key of the app's.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FeatureProperties from "../../src/components/shell/FeatureProperties.vue";
import type { Engine } from "../../src/app/engine";
import { ENGINE } from "../../src/app/engineKey";
import type { FieldKind } from "../../src/document/numFields";
import { pluginText, setLanguage } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import type { CadDocument, Feature } from "../../src/types";

const en = {
  "row.span": "Span",
  "row.grip": "Grip depth",
  "row.head": "Head style",
  "row.blind": "Blind rivet",
  "row.source": "Rivet table",
  "row.reach": "Reach",
  "head.dome": "Dome",
};
const german = {
  "row.span": "Spannweite",
  "row.grip": "Klemmtiefe",
  "row.head": "Kopfform",
  "row.blind": "Blindniet",
  "row.source": "Nietetabelle",
  "head.dome": "Linsenkopf",
};
const lines = pluginText<typeof en>("Acme.Rivets", {
  "./locales/en.json": en,
  "./locales/de.json": german,
});

// The first row reuses the id of an app row ("distance" is Abstand in German) to show the app's line is never used.
function contributeRivets() {
  return contribute("Acme.Rivets", {
    features: [
      {
        type: "rivet",
        meta: { icon: "extrude", label: "Rivet" },
        numFields: (values) => {
          const rows: [string, string, FieldKind][] = [
            ["distance", lines.t("row.span"), "length"],
            ["grip", lines.t("row.grip"), "length"],
          ];
          if (values["reach"] !== undefined) rows.push(["reach", lines.t("row.reach"), "length"]);
          return rows;
        },
        choiceFields: [
          {
            field: "head",
            get label() {
              return lines.t("row.head");
            },
            options: [{ value: "dome", label: "Dome" }],
            fallback: "dome",
          },
        ],
        toggleFields: [
          {
            field: "blind",
            get label() {
              return lines.t("row.blind");
            },
            fallback: false,
          },
        ],
        fileFields: [
          {
            field: "source",
            get label() {
              return lines.t("row.source");
            },
          },
        ],
      },
    ],
  });
}

function makeEngine(doc: CadDocument) {
  const version = ref(0);
  const store = {
    get document() {
      return doc;
    },
    liveFeature: (id: string) => doc.features.find((f) => f.id === id) ?? null,
    updateFeature: () => {},
    boundExpr: () => null,
    isParamBound: () => false,
    setTargetValue: () => {},
    setTargetExpr: () => null,
  };
  const targetEdit = { active: false, editingId: null, field: null, start: () => true };
  return {
    store,
    bridge: { docVersion: version, buildVersion: version, editPreviewVersion: version },
    tools: { targetEdit },
    toolBusy: () => false,
  } as unknown as Engine;
}

const render = (doc: CadDocument, featureId: string): VueWrapper =>
  mount(FeatureProperties, {
    props: { featureId, unit: "mm" },
    global: { provide: { [ENGINE as symbol]: makeEngine(doc) } },
  });

// [field, label] of every row, found by the data hook the rows carry.
const labelled = (w: VueWrapper) =>
  w.findAll(".param-row[data-field]").map((r) => [r.attributes("data-field"), r.find("label").text()]);

const rivet = (id: string, extra: object): Feature =>
  ({ id, type: "rivet", distance: 14.5, grip: 3.25, head: "dome", blind: true, ...extra }) as unknown as Feature;

beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  resetContributions();
  await setLanguage("system");
});

describe("a plugin feature's rows in the properties", () => {
  it("read in the plugin's English, then its German line, then English again, on a live switch", async () => {
    contributeRivets();
    await setLanguage("en");
    const w = render({ parameters: {}, features: [rivet("r1", { reach: 9.75 })] }, "r1");
    const english = [
      ["head", "Head style"],
      ["source", "Rivet table"],
      ["blind", "Blind rivet"],
      ["distance", "Span"],
      ["grip", "Grip depth"],
      ["reach", "Reach"],
    ];
    expect(labelled(w)).toEqual(english);
    await setLanguage("de");
    await nextTick();
    expect(labelled(w)).toEqual([
      ["head", "Kopfform"],
      ["source", "Nietetabelle"],
      ["blind", "Blindniet"],
      ["distance", "Spannweite"],
      ["grip", "Klemmtiefe"],
      // The plugin ships no German line for this one, so its English stays.
      ["reach", "Reach"],
    ]);
    await setLanguage("en");
    await nextTick();
    expect(labelled(w)).toEqual(english);
    w.unmount();
  });

  it("never take the app's line for a field of the same id", async () => {
    contributeRivets();
    await setLanguage("de");
    const w = render({ parameters: {}, features: [rivet("r1", {})] }, "r1");
    const distance = labelled(w).find(([field]) => field === "distance")![1];
    expect(distance).toBe("Spannweite");
    expect(distance).not.toBe(de["field.distance"]);
    w.unmount();
  });

  it("show the plugin's rows of a second document and leave nothing of the first", async () => {
    contributeRivets();
    await setLanguage("de");
    const first = render({ parameters: {}, features: [rivet("r1", { reach: 2.5 })] }, "r1");
    const firstRows = labelled(first);
    first.unmount();
    const second = render({ parameters: {}, features: [rivet("r9", {})] }, "r9");
    expect(firstRows).toHaveLength(6);
    expect(labelled(second)).toEqual(firstRows.filter(([field]) => field !== "reach"));
    second.unmount();
  });

  it("show an unplugged feature's raw field paths as they are, in any language", async () => {
    await setLanguage("de");
    const w = render(
      { parameters: {}, features: [{ id: "g1", type: "ghost", reach: 4.5 } as unknown as Feature] },
      "g1",
    );
    expect(labelled(w)).toEqual([["reach", "reach"]]);
    w.unmount();
  });
});

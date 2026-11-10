// Mounted once in English, the Stress setup step follows every language picked after it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StressPanel from "../../../src/components/overlays/StressPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { setLanguage } from "../../../src/i18n";
import { formatMessage, parseMessage, type MessageArgs } from "../../../src/i18n/format";
import de from "../../../src/i18n/locales/de.json";
import en from "../../../src/i18n/locales/en.json";
import es from "../../../src/i18n/locales/es.json";
import fr from "../../../src/i18n/locales/fr.json";
import { usePanelsStore } from "../../../src/stores/panels";
import { CUSTOM_MATERIAL, STRESS_MATERIALS, newLoad, newSupport } from "../../../src/ui/stress";

type Lines = Record<string, string>;

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => setLanguage("system"));

function makeEngine(): Engine {
  const panels = {
    stressBodies: () => [
      { id: "b1", name: "Bracket" },
      { id: "b3", name: "" },
    ],
    setStressBody: vi.fn(),
    runStress: vi.fn(),
    cancelStress: vi.fn(),
    closeStress: vi.fn(),
  };
  const store = {
    onBuild: (fn: () => void) => {
      fn();
      return () => {};
    },
  };
  return { store, ui: { panels } } as unknown as Engine;
}

// Two supports and two loads, one of each holding a spot; the body is gone from the model, the force has a custom
// vector, own weight is on and the material is typed by hand.
async function scene() {
  const wrapper = mount(StressPanel, {
    global: { provide: { [ENGINE as symbol]: makeEngine() } },
    attachTo: document.body,
  });
  const p = usePanelsStore();
  p.showStress("b1");
  await flushPromises();
  const setup = p.stress!.setup;
  setup.body = "b9";
  setup.supports.push(newSupport(2, "pinned"));
  setup.loads.push({ ...newLoad(2), kind: "pressure" });
  setup.loads[0]!.direction = "custom";
  setup.gravity = { on: true, direction: "+X" };
  setup.material = CUSTOM_MATERIAL;
  p.addStressSpot({ support: 1 }, { at: [12.5, -3, 4.25], radius: 2.4 });
  p.addStressSpot({ load: 1 }, { at: [-6.5, 7.25, 3], radius: 1.8 });
  p.stress!.placing = { support: 1 };
  p.stress!.placeAs = "face";
  await flushPromises();
  return { wrapper, p };
}

const step = () => document.body.querySelector(".stress-setup")!;
const text = (sel: string) => [...step().querySelectorAll(sel)].map((e) => e.textContent!.trim());

function shown(wrapper: VueWrapper) {
  const all = (sel: string) => [...step().querySelectorAll(sel)];
  const cls = (e: Element) => [...e.classList].find((c) => c.startsWith("stress-")) ?? e.tagName;
  const pairs = (sel: string, read: (e: Element) => string | null) => all(sel).map((e) => [cls(e), read(e)]);
  return {
    titles: pairs("[title]", (e) => e.getAttribute("title")),
    labels: pairs("[aria-label]", (e) => e.getAttribute("aria-label")),
    selects: wrapper
      .findAllComponents({ name: "Select" })
      .map((s) => [s.props("label"), (s.props("options") as { label: string }[]).map((o) => o.label)]),
    buttons: pairs("button", (e) => e.textContent!.trim()),
    words: pairs(".measure-k, .rd-head, .stress-item-name, .sm-hint", (e) => e.textContent!.trim()),
  };
}

function expected(file: Lines, locale: string) {
  const L = (key: string, args: MessageArgs = {}) => formatMessage(parseMessage(file[key]!), args, locale);
  const S = (key: string, args: MessageArgs = {}) => L(`stress.setup.${key}`, args);
  const gone = S("bodyGone", { body: "b9" });
  const kinds = [L("stress.support.fixed"), L("stress.support.pinned"), L("stress.support.slider")];
  const axes = ["down", "up", "right", "left", "back", "front"].map((d) => L(`stress.dir.${d}`));
  const loadKinds = [S("force"), S("pressure")];
  const custom = L("stress.material.custom");
  const spot = L("stress.spots.count", { k: 1 });
  const none = L("stress.faces.none");
  const placeTips = (row: "support" | "load") => [
    [`stress-place-${row}`, S("clickFacesTip")],
    [`stress-spot-${row}`, S(row === "support" ? "spotSupportTip" : "spotLoadTip")],
    [`stress-set-${row}`, S("useSelectedTip")],
  ];
  const spotTips = [
    ["INPUT", S("radius")],
    ["stress-remove-spot", S("removeSpot", { k: 1 })],
  ];
  const spotLabels = [
    ["INPUT", S("spotRadius", { k: 1 })],
    ["stress-remove-spot", S("removeSpot", { k: 1 })],
  ];
  const rowButtons = (row: "support" | "load", picking: boolean) => [
    [`stress-clear-${row}`, S("clear")],
    [`stress-place-${row}`, S(picking ? "picking" : "clickFaces")],
    [`stress-spot-${row}`, S("spot")],
    [`stress-set-${row}`, S("useSelected")],
  ];
  return {
    titles: [
      ["stress-support-type", L("stress.support.fixedHint")],
      ["stress-remove-support", S("removeSupport", { i: 1 })],
      ["stress-clear-support", S("clearSupport", { i: 1 })],
      ...placeTips("support"),
      ...spotTips,
      ["stress-support-type", L("stress.support.pinnedHint")],
      ["stress-remove-support", S("removeSupport", { i: 2 })],
      ["stress-clear-support", S("nothingPlaced")],
      ...placeTips("support"),
      ["stress-remove-load", S("removeLoad", { i: 1 })],
      ["stress-clear-load", S("clearLoad", { i: 1 })],
      ...placeTips("load"),
      ...spotTips,
      ["stress-direction", S("direction")],
      ["INPUT", "0"],
      ["INPUT", "0"],
      ["INPUT", "-1"],
      ["stress-remove-load", S("removeLoad", { i: 2 })],
      ["stress-clear-load", S("nothingPlaced")],
      ...placeTips("load"),
      ["stress-gravity", S("ownWeightTip")],
      ["stress-gravity-dir", S("whichWayDown")],
      ["stress-detail", S("meshDetailTip")],
    ],
    labels: [
      ["stress-body", `${S("body")}, ${gone}`],
      ["stress-support-type", `${S("supportType", { i: 1 })}, ${kinds[0]}`],
      ["stress-remove-support", S("removeSupport", { i: 1 })],
      ...spotLabels,
      ["stress-support-type", `${S("supportType", { i: 2 })}, ${kinds[1]}`],
      ["stress-remove-support", S("removeSupport", { i: 2 })],
      ["stress-load-kind", `${S("loadKind", { i: 1 })}, ${loadKinds[0]}`],
      ["stress-remove-load", S("removeLoad", { i: 1 })],
      ...spotLabels,
      ["INPUT", S("force")],
      ["stress-direction", `${S("forceDirection")}, ${L("stress.dir.custom")}`],
      ["INPUT", "X"],
      ["INPUT", "Y"],
      ["INPUT", "Z"],
      ["stress-load-kind", `${S("loadKind", { i: 2 })}, ${loadKinds[1]}`],
      ["stress-remove-load", S("removeLoad", { i: 2 })],
      ["INPUT", S("pressure")],
      ["stress-gravity-on", S("ownWeight")],
      ["stress-gravity-dir", `${S("whichWayDown")}, ${axes[2]}`],
      ["stress-material", `${S("material")}, ${custom}`],
      ["INPUT", "E"],
      ["INPUT", S("poisson")],
      ["INPUT", S("yield")],
      ["INPUT", S("density")],
      ["stress-detail", `${S("meshDetail")}, ${L("stress.mesh.standard")}`],
    ],
    selects: [
      [S("body"), [S("choose"), "Bracket", "b3", gone]],
      [S("supportType", { i: 1 }), kinds],
      [S("supportType", { i: 2 }), kinds],
      [S("loadKind", { i: 1 }), loadKinds],
      [S("forceDirection"), [L("stress.dir.into"), ...axes, L("stress.dir.custom")]],
      [S("loadKind", { i: 2 }), loadKinds],
      [S("whichWayDown"), axes],
      [S("material"), [...STRESS_MATERIALS.map((m) => m.name), custom]],
      [S("meshDetail"), ["coarse", "standard", "fine"].map((m) => L(`stress.mesh.${m}`))],
    ],
    buttons: [
      ["stress-body", gone],
      ["stress-support-type", kinds[0]],
      ["stress-remove-support", ""],
      ...rowButtons("support", true),
      ["stress-remove-spot", ""],
      ["stress-support-type", kinds[1]],
      ["stress-remove-support", ""],
      ...rowButtons("support", false),
      ["stress-add", S("addSupport")],
      ["stress-load-kind", loadKinds[0]],
      ["stress-remove-load", ""],
      ...rowButtons("load", false),
      ["stress-remove-spot", ""],
      ["stress-direction", L("stress.dir.custom")],
      ["stress-load-kind", loadKinds[1]],
      ["stress-remove-load", ""],
      ...rowButtons("load", false),
      ["stress-add", S("addLoad")],
      ["stress-gravity-on", ""],
      ["stress-gravity-dir", axes[2]],
      ["stress-material", custom],
      ["stress-more", S("more")],
      ["stress-detail", L("stress.mesh.standard")],
    ],
    words: [
      ["SPAN", S("body")],
      ["stress-caption", `${S("supports")} 2`],
      ["stress-item-name", S("support", { i: 1 })],
      ["stress-count", spot],
      ["SPAN", S("spotN", { k: 1 })],
      ["stress-item-name", S("support", { i: 2 })],
      ["stress-count", none],
      ["stress-caption", `${S("loads")} 2`],
      ["stress-item-name", S("load", { i: 1 })],
      ["stress-count", spot],
      ["SPAN", S("spotN", { k: 1 })],
      ["SPAN", S("force")],
      ["SPAN", S("xyz")],
      ["stress-item-name", S("load", { i: 2 })],
      ["stress-count", none],
      ["SPAN", S("pressure")],
      ["SPAN", S("ownWeight")],
      ["stress-caption", S("material")],
      ["SPAN", S("material")],
      ["SPAN", "E"],
      ["SPAN", S("poisson")],
      ["SPAN", S("yield")],
      ["SPAN", S("density")],
      ["SPAN", S("meshDetail")],
      ["DIV", S("meshHint")],
    ],
  };
}

const flat = (x: unknown): string[] =>
  typeof x === "string" ? [x] : x && typeof x === "object" ? Object.values(x).flatMap(flat) : [];
// A closed Select keeps its list out of the page.
const inPage = ({ selects: _, ...rest }: ReturnType<typeof expected>) => [...new Set(flat(rest))];

// Every text node and attribute in the step, so a line the snapshot does not list still counts.
function everything(): string {
  const parts = [step().textContent ?? ""];
  for (const e of step().querySelectorAll("*")) for (const a of e.attributes) parts.push(a.value);
  return parts.join("\n");
}

async function pick(code: string) {
  await setLanguage(code);
  await flushPromises();
}

describe("StressSetupStep in the picked language", () => {
  it("reads every heading, button, name, tip and choice from the language file, then from the next one", async () => {
    const { wrapper } = await scene();
    expect(shown(wrapper)).toEqual(expected(en, "en"));
    await pick("de");
    expect(shown(wrapper)).toEqual(expected(de, "de"));
    await pick("fr");
    expect(shown(wrapper)).toEqual(expected(fr, "fr"));
  });

  it("leaves no German line behind once French is picked", async () => {
    await scene();
    const frLines = new Set(inPage(expected(fr, "fr")));
    const deOnly = inPage(expected(de, "de")).filter((v) => !frLines.has(v));
    expect(deOnly.length).toBeGreaterThan(30);
    await pick("de");
    expect(deOnly.filter((v) => !everything().includes(v))).toEqual([]);
    await pick("fr");
    expect(deOnly.filter((v) => everything().includes(v))).toEqual([]);
  });

  it("names the place being picked and the spot being placed in the picked language", async () => {
    const { p } = await scene();
    await pick("es");
    p.stress!.placing = { load: 2 };
    p.stress!.placeAs = "spot";
    await flushPromises();
    const S = (key: string) => formatMessage(parseMessage((es as Lines)[`stress.setup.${key}`]!), {}, "es");
    expect(text(".stress-place-support, .stress-spot-support, .stress-place-load, .stress-spot-load")).toEqual([
      ...[S("clickFaces"), S("spot"), S("clickFaces"), S("spot")],
      ...[S("clickFaces"), S("spot"), S("clickFaces"), S("placing")],
    ]);
  });

  it("writes a preset's values into the language's line, the numbers as the fields show them", async () => {
    const { p } = await scene();
    const line = (file: Lines, locale: string) =>
      formatMessage(
        parseMessage(file["stress.setup.materialLine"]!),
        { e: "69000", nu: "0.33", yield: "275", density: "2.7" },
        locale,
      );
    p.stress!.setup.material = "aluminium 6061-T6";
    await flushPromises();
    expect(text(".stress-material-line")).toEqual([line(en, "en")]);
    await pick("de");
    expect(text(".stress-material-line")).toEqual([line(de, "de")]);
    await pick("fr");
    expect(text(".stress-material-line")).toEqual([line(fr, "fr")]);
  });
});

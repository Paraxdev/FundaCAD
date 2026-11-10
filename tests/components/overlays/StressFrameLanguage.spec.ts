// The Stress panel frame (title, tabs, hint, Run and Cancel) follows the picked language, as the setup step does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StressPanel from "../../../src/components/overlays/StressPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { setLanguage } from "../../../src/i18n";
import { formatMessage, parseMessage } from "../../../src/i18n/format";
import de from "../../../src/i18n/locales/de.json";
import en from "../../../src/i18n/locales/en.json";
import es from "../../../src/i18n/locales/es.json";
import fr from "../../../src/i18n/locales/fr.json";
import ja from "../../../src/i18n/locales/ja.json";
import zh from "../../../src/i18n/locales/zh-CN.json";
import { usePanelsStore } from "../../../src/stores/panels";
import type { StressResultView } from "../../../src/ui/stress";
import type { Selector } from "../../../src/types";

type Lines = Record<string, string>;

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => setLanguage("system"));

const engine = {
  store: {
    onBuild: (fn: () => void) => {
      fn();
      return () => {};
    },
  },
  ui: {
    panels: {
      stressBodies: () => [{ id: "b1", name: "Bracket" }],
      runStress: vi.fn(),
      cancelStress: vi.fn(),
      closeStress: vi.fn(),
    },
  },
} as unknown as Engine;

async function open() {
  mount(StressPanel, {
    global: { provide: { [ENGINE as symbol]: engine }, stubs: { StressResultsStep: true } },
    attachTo: document.body,
  });
  const p = usePanelsStore();
  p.showStress("b1");
  await flushPromises();
  return p;
}

const frame = () => {
  const root = document.body.querySelector(".stress-panel")!;
  const all = (sel: string, read: (e: Element) => unknown) => [...root.querySelectorAll(sel)].map(read);
  const text = (e: Element) => e.textContent!.trim();
  const attr = (name: string) => (e: Element) => e.getAttribute(name);
  return {
    region: all("h2.sr-only", text),
    head: all(".measure-title", text),
    close: all(".stress-close", (e) => [e.getAttribute("title"), e.getAttribute("aria-label")]),
    tablist: all("[role=tablist]", attr("aria-label")),
    tabs: all(".float-tab", (e) => [text(e), e.getAttribute("title")]),
    hint: all(".measure-hint:not(.stress-error)", text),
    foot: all(".stress-foot > *", text),
  };
};

const L = (file: Lines, key: string) =>
  formatMessage(parseMessage(file[`stress.frame.${key}`] ?? `<${key}>`), {}, "en");

const STATES = ["idle", "probe", "spot", "face", "ready", "running", "results"] as const;
type State = (typeof STATES)[number];

async function reach(p: ReturnType<typeof usePanelsStore>, state: State) {
  if (state === "probe") p.stress!.probe = true;
  if (state === "spot") Object.assign(p.stress!, { placing: { load: 1 }, placeAs: "spot" });
  if (state === "face") Object.assign(p.stress!, { placing: { support: 1 }, placeAs: "face" });
  if (state === "ready") {
    const sel: Selector = { kind: "face", by: "nearest", point: [12.5, -3, 4.25], body: "b1" };
    const faces = { selectors: [sel], faceIds: [4], normalSum: [5.4, 0, 7.2] as [number, number, number], area: 9 };
    p.setStressSupportFaces(1, faces);
    p.setStressLoadFaces(1, faces);
    p.stress!.setup.loads[0]!.force = 40;
  }
  if (state === "running") p.stress!.running = true;
  if (state === "results") {
    p.stressStarted();
    p.stressFinished({ result: {} as StressResultView });
  }
  await flushPromises();
}

const HINT: Record<State, string> = {
  idle: "hintSetup",
  probe: "hintProbe",
  spot: "hintSpot",
  face: "hintFace",
  ready: "hintReady",
  running: "hintSetup",
  results: "hintResults",
};

function expected(file: Lines, state: State) {
  const results = state === "results";
  return {
    region: [L(file, "title")],
    head: [L(file, "title")],
    close: [[L(file, "close"), L(file, "close")]],
    tablist: [L(file, "steps")],
    tabs: [
      [L(file, "tabSetup"), null],
      [L(file, "tabResults"), results ? null : L(file, "tabResultsTip")],
    ],
    hint: [L(file, HINT[state])],
    foot: results ? [] : state === "running" ? [L(file, "busy"), L(file, "cancel")] : [L(file, "run")],
  };
}

const LANGUAGES = [
  ["en", en],
  ["de", de],
  ["fr", fr],
  ["es", es],
  ["zh-CN", zh],
  ["ja", ja],
] as const;

describe("the Stress panel frame in the picked language", () => {
  it.each(LANGUAGES)("reads every frame line from the %s file in every state", async (code, file) => {
    const p = await open();
    await setLanguage(code);
    await flushPromises();
    for (const state of STATES) {
      await reach(p, state);
      expect(frame(), `${code} ${state}`).toEqual(expected(file as Lines, state));
      p.stress = null;
      p.showStress("b1");
      await flushPromises();
    }
  });

  it("gives each frame line a word of its own in every other language than English", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("stress.frame."));
    expect(keys.length).toBe(15);
    for (const [code, file] of LANGUAGES.filter(([c]) => c !== "en")) {
      const same = keys.filter((k) => (file as Lines)[k] === (en as Lines)[k]);
      expect(same, code).toEqual([]);
    }
  });
});

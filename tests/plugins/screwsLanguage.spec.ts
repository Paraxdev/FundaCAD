// The Fasteners panel, the Standard Thread panel and the plugin's refusals speak the language through the plugin's own
// lines, and the catalogue ids and designations stay English.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import LibraryPanel from "../../plugins/FundaCAD.Screws/LibraryPanel.vue";
import ThreadPanel from "../../plugins/FundaCAD.Screws/ThreadPanel.vue";
import { expand, pitchesFor, familyById, specRows } from "../../plugins/FundaCAD.Screws/catalogue";
import { parseLibraryFile } from "../../plugins/FundaCAD.Screws/library";
import { NO_FILTERS, filterEntries, groupEntries, listEntries } from "../../plugins/FundaCAD.Screws/search";
import { specProblems, type FastenerSpec } from "../../plugins/FundaCAD.Screws/spec";
import { open } from "../../plugins/FundaCAD.Screws/state";
import { formatOffBy, nearestThread } from "../../plugins/FundaCAD.Screws/threadSpec";
import { threadDraft } from "../../plugins/FundaCAD.Screws/threadTool";
import { ENGINE } from "../../src/app/engineKey";
import { reloadLanguageFiles, setLanguage } from "../../src/i18n";

enableAutoUnmount(afterEach);

beforeEach(async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  await setLanguage("en");
});

afterEach(async () => {
  open.value = false;
  threadDraft.value = null;
  localStorage.clear();
  await reloadLanguageFiles();
  await setLanguage("system");
});

const socketCap = () => expand({ familyId: "iso4762", size: "M4", length: 12 });

describe("the refusals and the spec rows", () => {
  it("name a missing field in the chosen language", async () => {
    const spec = { kind: "screw", units: "mm", name: "x", head: { type: "socketCap" } } as unknown as FastenerSpec;
    expect(specProblems(spec)[0]).toMatch(/^Missing: .*thread/);
    await setLanguage("de");
    expect(specProblems(spec)[0]).toMatch(/^Es fehlt: /);
    await setLanguage("fr");
    expect(specProblems(spec)[0]).toMatch(/^Manquant : /);
  });

  it("read the row labels of the spec, and keep the standard English", async () => {
    const rows = () => Object.fromEntries(specRows(socketCap()).map((r) => [r.label.trim(), r.value]));
    expect(Object.keys(rows())).toEqual(expect.arrayContaining(["Standard", "Type", "Counterbore"]));
    await setLanguage("de");
    const de = rows();
    expect(de["Flachsenkung"]).toBeDefined();
    expect(de["Steigung"]).toBeDefined();
    expect(de["Norm"]).toBe(socketCap().standard);
    expect(de["Typ"]).toBe("Schraube oder Bolzen");
  });

  it("translate the pitch names of a metric size and keep the inch designations", async () => {
    const m = pitchesFor(familyById("iso4762")!, "M4");
    expect(m[0]!.label).toBe("0.7 mm coarse");
    await setLanguage("de");
    expect(pitchesFor(familyById("iso4762")!, "M4")[0]!.label).toBe("0,7 mm grob");
  });

  it("word the nearest standard thread in the chosen language", async () => {
    const near = nearestThread(5.98, true)!;
    expect(formatOffBy(near)).toBe("M6, 0.02 mm under nominal");
    await setLanguage("de");
    expect(formatOffBy(near)).toBe("M6, 0,02 mm unter Nennmaß");
    await setLanguage("ja");
    expect(formatOffBy(near)).toContain("呼び径");
  });

  it("report a library file that cannot be read in the chosen language", async () => {
    expect(parseLibraryFile("{").problems).toEqual(["the file is not JSON"]);
    await setLanguage("fr");
    expect(parseLibraryFile("{").problems).toEqual(["le fichier n'est pas du JSON"]);
    const bad = JSON.stringify({ format: "fundacad-fasteners", fasteners: [5] });
    expect(parseLibraryFile(bad).problems).toEqual(["entrée 1 : pas une fixation"]);
  });
});

describe("the list and its search", () => {
  it("finds a fastener by a word of the chosen language, and groups by the English category", async () => {
    const entries = listEntries([]);
    const words = (query: string) => filterEntries(entries, { ...NO_FILTERS, query }).length;
    expect(words("innensechskantschrauben")).toBe(0);
    await setLanguage("de");
    expect(words("innensechskantschrauben")).toBeGreaterThan(0);
    expect(groupEntries(entries).map((g) => g.category)).toContain("Socket screws");
  });
});

describe("the Fasteners panel", () => {
  const panel = () => mount(LibraryPanel, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: {} } } });

  it("reads German then Japanese after a switch, field labels, options and counts included", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    open.value = true;
    panel();
    await flushPromises();
    const q = (sel: string) => document.body.querySelector(sel)!;
    expect(q("input[type=search]").getAttribute("aria-label")).toBe("Search fasteners");
    expect(q(".scr-count").textContent).toMatch(/sizes shown$/);

    await setLanguage("de");
    await nextTick();
    expect(q("input[type=search]").getAttribute("aria-label")).toBe("Verbindungselemente suchen");
    expect(q(".scr-count").textContent).toMatch(/Größen angezeigt$/);
    expect(q(".scr-tab-custom").textContent).toBe("Eigene Verbindungselemente (0)");
    expect(q(".scr-filter-category").textContent).toContain("Alle Arten");

    await setLanguage("ja");
    await nextTick();
    expect(q(".scr-tab-custom").textContent).toBe("自分の締結部品 (0)");
    vi.unstubAllGlobals();
  });
});

describe("the Standard Thread panel", () => {
  it("reads German, the face and hand options included", async () => {
    const near = nearestThread(5.98, true)!;
    threadDraft.value = {
      editing: null,
      face: { type: "face" } as never,
      faceDiameter: 5.98,
      external: false,
      system: near.choice.system,
      designation: near.choice.designation,
      faceIs: "tap",
      hand: "right",
      starts: 1,
      printFit: false,
      clearance: 0.2,
    } as never;
    await setLanguage("de");
    const w = mount(ThreadPanel, { attachTo: document.body });
    await flushPromises();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Standardgewinde, Bohrung");
    w.unmount();
  });
});

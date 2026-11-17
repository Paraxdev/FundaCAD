// The Fasteners panel, the Standard Thread panel and the plugin's refusals speak the language through the plugin's own
// lines, and the catalogue ids and designations stay English.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import LibraryPanel from "../../plugins/FundaCAD.Screws/LibraryPanel.vue";
import ThreadPanel from "../../plugins/FundaCAD.Screws/ThreadPanel.vue";
import CustomForm from "../../plugins/FundaCAD.Screws/CustomForm.vue";
import {
  FAMILIES,
  expand,
  lengthsFor,
  pitchesFor,
  familyById,
  specRows,
} from "../../plugins/FundaCAD.Screws/catalogue";
import { insertFastener } from "../../plugins/FundaCAD.Screws/insert";
import { parseLibraryFile } from "../../plugins/FundaCAD.Screws/library";
import { familyTitle, lowerCase } from "../../plugins/FundaCAD.Screws/lines";
import { PLUGIN_ID } from "../../plugins/FundaCAD.Screws/state";
import { NO_FILTERS, filterEntries, groupEntries, listEntries } from "../../plugins/FundaCAD.Screws/search";
import { specProblems, type FastenerSpec } from "../../plugins/FundaCAD.Screws/spec";
import { open } from "../../plugins/FundaCAD.Screws/state";
import { formatOffBy, nearestThread } from "../../plugins/FundaCAD.Screws/threadSpec";
import { threadDraft } from "../../plugins/FundaCAD.Screws/threadTool";
import { ENGINE } from "../../src/app/engineKey";
import { Select } from "../../src/plugins/hostUi";
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
  const draft = () => {
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
  };
  const optionLabels = (w: VueWrapper) =>
    w
      .findAllComponents(Select)
      .map((s) =>
        ((s as unknown as { props(key: string): unknown }).props("options") as { label: string }[]).map((o) => o.label),
      );

  it("reads German, the face, hand and system options and the pitch and lead line included", async () => {
    draft();
    await setLanguage("de");
    const w = mount(ThreadPanel, { attachTo: document.body });
    await flushPromises();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Standardgewinde, Bohrung");
    expect(text).toContain("Teilung P 1 mm, Steigung Ph 1 mm");
    const options = optionLabels(w).flat();
    expect(options).toEqual(expect.arrayContaining(["ISO-metrisch", "Trapez Tr", "Rechts", "Links"]));
    expect(options.some((o) => /^Kernloch, /.test(o))).toBe(true);
    expect(options.some((o) => /^Nennmaß, /.test(o))).toBe(true);
    await setLanguage("ja");
    await flushPromises();
    const ja = optionLabels(w).flat();
    expect(ja.some((o) => o.startsWith("下穴、"))).toBe(true);
    expect(ja.some((o) => o.startsWith("呼び径、"))).toBe(true);
    w.unmount();
  });
});

describe("the family titles", () => {
  it("every English line is the catalogue's own name", () => {
    for (const f of FAMILIES) expect(familyTitle(f.id, "x")).toBe(f.name);
  });

  it("read in German and Japanese in the list, while the saved name stays English", async () => {
    const titles = () => groupEntries(listEntries([])).flatMap((g) => g.families.map((f) => f.title));
    expect(titles()).toContain("Hex nut");
    await setLanguage("de");
    expect(titles()).toEqual(expect.arrayContaining(["Sechskantmutter", "Zylinderschraube mit Innensechskant"]));
    expect(titles()).not.toContain("Hex nut");
    await setLanguage("ja");
    expect(titles()).toContain("六角ナット");
    expect(expand({ familyId: "iso4032", size: "M4" }).name).toBe("ISO 4032 M4");
  });

  it("are searched in the chosen language and the English one still finds them", async () => {
    const entries = listEntries([]);
    const found = (query: string) => new Set(filterEntries(entries, { ...NO_FILTERS, query }).map((e) => e.familyId));
    await setLanguage("de");
    expect(found("sechskantmutter")).toContain("iso4032");
    expect(found("hex nut")).toContain("iso4032");
    expect(found("kontermutter")).toContain("iso4035");
  });
});

describe("the lowercase rule of a label inside a sentence", () => {
  it("lowercases in English, French and Spanish and keeps the case in German, Japanese and Chinese", async () => {
    const out: Record<string, string> = {};
    for (const code of ["en", "fr", "es", "de", "ja", "zh-CN"]) {
      await setLanguage(code);
      out[code] = lowerCase("Head");
    }
    expect(out).toEqual({ en: "head", fr: "head", es: "head", de: "Head", ja: "Head", "zh-CN": "Head" });
  });
});

describe("what a save writes", () => {
  const catalogue = () =>
    FAMILIES.map((f) => {
      const row = f.sizes[0]!;
      const length = lengthsFor(f, row)[0];
      return expand({ familyId: f.id, size: row.size, ...(length === undefined ? {} : { length }) });
    });

  it("is the same spec from the catalogue in German and in English", async () => {
    const en = JSON.stringify(catalogue());
    await setLanguage("de");
    expect(JSON.stringify(catalogue())).toBe(en);
  });

  it("is the same inserted feature name and generatedBy spec in German and in English", async () => {
    const insert = async () => {
      const added: Record<string, unknown>[] = [];
      const e = {
        geometry: { generateShape: async () => ({ ok: true, shape: { geom: "g", solid: true } }) },
        setStatus: () => {},
        store: { nextId: () => "f1", addFeature: (f: Record<string, unknown>) => added.push(f) },
        noteCommitted: () => {},
        selectFeature: () => {},
      };
      await insertFastener(e as never, socketCap(), null);
      return added;
    };
    const en = await insert();
    await setLanguage("de");
    const de = await insert();
    expect(de).toEqual(en);
    expect(de[0]).toMatchObject({ name: "ISO 4762 M4x12", generatedBy: { plugin: PLUGIN_ID } });
  });

  it("is the same spec from the custom form in German and in English", async () => {
    const save = async () => {
      const w = mount(CustomForm, {
        props: { initial: socketCap(), editing: true },
        global: { stubs: { FastenerPreview: true } },
        attachTo: document.body,
      });
      await flushPromises();
      await w.get(".scr-save").trigger("click");
      const spec = w.emitted("save")!.at(-1)![0];
      w.unmount();
      return spec;
    };
    const en = await save();
    await setLanguage("de");
    expect(await save()).toEqual(en);
  });
});

describe("the custom form", () => {
  const phillips = {
    ...socketCap(),
    drive: { type: "phillips", size: 3, depth: 1.5 },
  } as unknown as FastenerSpec;

  it("words a refusal in the language of the moment, not the one it was raised in", async () => {
    await setLanguage("de");
    const w = mount(CustomForm, {
      props: { initial: phillips, editing: true },
      global: { stubs: { FastenerPreview: true } },
      attachTo: document.body,
    });
    await flushPromises();
    const field = w.element.querySelector(".scr-drive-number")!;
    const box = (field.matches("input") ? field : field.querySelector("input")) as HTMLInputElement;
    box.focus();
    box.value = "1.500";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    const problems = () => [...w.element.querySelectorAll(".scr-problems li")].map((li) => li.textContent ?? "");
    expect(problems()[0]).toMatch(/^Antriebsgröße: /);
    await setLanguage("fr");
    await flushPromises();
    expect(problems()[0]).toMatch(/^Numéro de taille : /);
    w.unmount();
  });
});

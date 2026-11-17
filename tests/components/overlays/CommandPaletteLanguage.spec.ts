// The command palette follows the chosen language and still finds a command by its English name.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import CommandPalette from "../../../src/components/overlays/CommandPalette.vue";
import { useCommandPaletteStore } from "../../../src/stores/commandPalette";
import { attachAnnouncer } from "../../../src/ui/announce";
import { setLanguage } from "../../../src/i18n";
import { stepMenuText } from "../../../src/ui/canStep";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const later = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const input = () => $(".cmdk-input input") as HTMLInputElement;
const rows = () => $$(".cmdk-item");
const labels = () => $$(".cmdk-item .cmdk-label").map((e) => e.textContent);

async function type(text: string) {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await later();
}

describe("CommandPalette language", () => {
  let lines: string[];
  let detach: () => void;
  beforeEach(async () => {
    setActivePinia(createPinia());
    document.body.replaceChildren();
    lines = [];
    detach = attachAnnouncer({
      polite: {
        get textContent() {
          return lines.at(-1) ?? "";
        },
        set textContent(v: string | null) {
          if (v) lines.push(v.trim());
        },
      },
      assertive: { textContent: "" },
    });
    await setLanguage("de");
    mount(CommandPalette, { attachTo: document.body });
    useCommandPaletteStore().toggle("model");
    await nextTick();
    await later();
  });
  afterEach(async () => {
    detach();
    await setLanguage("system");
  });

  it("speaks the chrome in German", () => {
    expect($(".cmdk-card")!.getAttribute("aria-label")).toBe("Befehlspalette");
    expect([input().getAttribute("aria-label"), input().placeholder]).toEqual(["Befehle suchen", "Befehle suchen…"]);
  });

  it("finds Save As by the German and by the English name, shown in German only", async () => {
    await type("speichern u");
    expect(labels()[0]).toBe("Speichern unter…");
    await type("save as");
    expect(labels()[0]).toBe("Speichern unter…");
    expect(rows()[0]!.textContent).not.toMatch(/Save/);
    expect($(".cmdk-item .cmdk-group")!.textContent).toBe("Datei");
  });

  it("finds Undo and Redo by their English names with no step to take", async () => {
    useCommandPaletteStore().bindLabels((id) => (id === "undo" || id === "redo" ? stepMenuText(id, null) : null));
    await type("undo");
    expect(labels()[0]).toBe("Rückgängig");
    await type("redo");
    expect(labels()[0]).toBe("Wiederholen");
  });

  it("shows the empty line in German when neither language matches", async () => {
    await type("qzxwv");
    expect(rows()).toEqual([]);
    expect($(".cmdk-empty")!.textContent).toBe("Kein passender Befehl");
  });

  it("speaks the empty line, one result and several results", async () => {
    await type("qzxwv");
    await later(350);
    expect(lines.at(-1)).toBe("Kein passender Befehl");
    await type("speichern unter");
    await later(350);
    expect(rows().length).toBe(1);
    expect(lines.at(-1)).toMatch(/^1 Befehl\. Speichern unter, Datei/);
    await type("speich");
    await later(350);
    expect(rows().length).toBe(2);
    expect(lines.at(-1)).toMatch(/^2 Befehle\. Speichern, Datei/);
    await type("an");
    await later(350);
    expect(rows().length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)).toMatch(new RegExp(`^${rows().length} Befehle\\. `));
  });

  it("switches an open palette to the new language", async () => {
    await type("save as");
    expect(labels()[0]).toBe("Speichern unter…");
    await setLanguage("fr");
    await nextTick();
    expect(labels()[0]).toBe("Enregistrer sous…");
    expect($(".cmdk-card")!.getAttribute("aria-label")).toBe("Palette de commandes");
    expect($(".cmdk-item .cmdk-group")!.textContent).toBe("Fichier");
  });

  it("finds a rail tool by the German and the English name, shown in German", async () => {
    await type("extrude");
    expect(labels()[0]).toBe("Extrusion");
    expect($(".cmdk-item .cmdk-group")!.textContent).toBe("Erstellen");
    await type("extru");
    expect(labels()).toContain("Extrusion");
    expect(rows()[0]!.textContent).not.toMatch(/Extrude/);
    await setLanguage("en");
    await nextTick();
    expect(labels()[0]).toBe("Extrude");
  });

  it("switches a rail tool and its group live from German to French", async () => {
    await type("extrude");
    await setLanguage("fr");
    await nextTick();
    expect(labels()[0]).toBe("Extruder");
    expect($(".cmdk-item .cmdk-group")!.textContent).toBe("Créer");
  });
});

// Comfortable text: the stored flag and its gate, the root attribute _comfortable.scss reads, and the stylesheet
// holding the WCAG text spacing values.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import comfortableScss from "../../src/styles/_comfortable.scss?raw";
import mainScss from "../../src/styles/main.scss?raw";

let stored: Map<string, string>;
let root: { dataset: Record<string, string> };

function boot(entries: Record<string, string> = {}) {
  stored = new Map(Object.entries(entries));
  root = { dataset: {} };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
  vi.stubGlobal("document", { documentElement: root });
}

async function load() {
  vi.resetModules();
  const prefs = await import("../../src/ui/a11yPrefs");
  const text = await import("../../src/ui/comfortableText");
  return { ...prefs, ...text };
}

const KEY = "fundacad.a11y.comfortableText";

beforeEach(() => boot());
afterEach(() => vi.unstubAllGlobals());

describe("the setting", () => {
  it("is off by default and takes booleans and their stored strings only", async () => {
    const m = await load();
    expect(m.a11yPrefs().comfortableText).toBe(false);
    expect([true, "true", false, "false", "1", "yes", 1, null].map(m.asComfortableText)).toEqual([
      true,
      true,
      false,
      false,
      null,
      null,
      null,
      null,
    ]);
  });

  it("survives a reload, and a stored value it cannot read stays off", async () => {
    let m = await load();
    m.setA11yPref("comfortableText", true);
    expect(stored.get(KEY)).toBe("true");
    m = await load();
    expect(m.a11yPrefs().comfortableText).toBe(true);
    boot({ [KEY]: "on" });
    m = await load();
    expect(m.a11yPrefs().comfortableText).toBe(false);
  });
});

describe("the root attribute", () => {
  it("is set at boot from the stored choice and follows every change, Reset to defaults too", async () => {
    boot({ [KEY]: "true" });
    const m = await load();
    m.installComfortableText();
    expect(root.dataset.text).toBe("comfortable");
    m.setA11yPref("comfortableText", false);
    expect(root.dataset.text).toBeUndefined();
    m.setA11yPref("comfortableText", true);
    m.resetA11yPrefs();
    expect([root.dataset.text, stored.has(KEY)]).toEqual([undefined, false]);
  });
});

describe("the stylesheet", () => {
  it("spaces every element by the WCAG 1.4.12 values, important so no rule's own line height wins", () => {
    for (const decl of [
      "line-height: 1.5 !important",
      "letter-spacing: 0.12em !important",
      "word-spacing: 0.16em !important",
    ])
      expect(comfortableScss).toContain(decl);
    expect(comfortableScss).toMatch(/:root\[data-text="comfortable"\] \{\s*&,\s*& \* \{/);
  });

  it("loads after the base components, so its minimum heights replace their fixed ones", () => {
    const order = [...mainScss.matchAll(/@use "([\w-]+)"/g)].map((x) => x[1]);
    expect(order.indexOf("comfortable")).toBeGreaterThan(order.indexOf("ui"));
  });
});

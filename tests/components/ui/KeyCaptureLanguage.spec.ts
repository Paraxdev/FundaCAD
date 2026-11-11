// The key button, its dialog and the spoken key names follow the chosen language, live.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock(import("../../../src/ui/announce"), async (orig) => ({ ...(await orig()), announce: vi.fn() }));

import KeyCapture from "../../../src/components/ui/KeyCapture.vue";
import { announce } from "../../../src/ui/announce";
import { setMacForTest, spokenKeys } from "../../../src/input/platform";
import { setLanguage } from "../../../src/i18n";
import de from "../../../src/i18n/locales/de.json";
import en from "../../../src/i18n/locales/en.json";

enableAutoUnmount(afterEach);
beforeEach(async () => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  setMacForTest(false);
  document.body.replaceChildren();
  await setLanguage("de");
});
afterEach(async () => {
  setMacForTest(null);
  await setLanguage("system");
});

const settle = () => new Promise((r) => setTimeout(r, 5));
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const fill = (text: string, args: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, k: string) => args[k]!);

describe("spokenKeys in German", () => {
  it("says the modifier and named key words of the language on Windows", () => {
    expect(spokenKeys("Ctrl+Shift+Z")).toBe(`${de["keys.spoken.control"]} ${de["keys.spoken.shift"]} Z`);
    expect(spokenKeys("Alt+Left")).toBe(`${de["keys.spoken.alt"]} ${de["keys.spoken.arrowLeft"]}`);
    expect(spokenKeys("Ctrl++")).toBe(`${de["keys.spoken.control"]} ${de["keys.spoken.plus"]}`);
    expect(spokenKeys("PgDn")).toBe(de["keys.spoken.pageDown"]);
    expect(spokenKeys("F5")).toBe("F5");
  });

  it("says Command and Option on a Mac", () => {
    setMacForTest(true);
    expect(spokenKeys("Ctrl+Alt+7")).toBe(`${de["keys.spoken.command"]} ${de["keys.spoken.option"]} 7`);
  });

  it("joins two and three alternatives with the language's or line", () => {
    const or = (first: string, second: string) => fill(de["keys.spoken.or"], { first, second });
    const c = de["keys.spoken.control"];
    expect(spokenKeys("Ctrl+Y / Ctrl+4")).toBe(or(`${c} Y`, `${c} 4`));
    expect(spokenKeys(["Ctrl+Y", "Ctrl+4", "Ctrl+9"])).toBe(or(or(`${c} Y`, `${c} 4`), `${c} 9`));
  });

  it("matches the English words once the language is back", async () => {
    await setLanguage("en");
    expect(spokenKeys(["Ctrl+Shift+Z", "?", "Right"])).toBe(
      "Control Shift Z or question mark or Right arrow".replace(
        "Control Shift Z or question mark or",
        `Control Shift Z or ${en["keys.spoken.questionMark"]} or`,
      ),
    );
  });
});

describe("KeyCapture in German", () => {
  const render = (keys: string, clearable = false) =>
    mount(KeyCapture, { props: { action: "Fase", keys, clearable }, attachTo: document.body });

  it("names the button and shows the unset text in German", () => {
    const set = render("Ctrl+Shift+Z");
    expect(set.get("button").attributes("aria-label")).toBe(
      fill(de["keyCapture.name"], { action: "Fase", keys: spokenKeys("Ctrl+Shift+Z") }),
    );
    const unset = render("");
    expect([unset.get("button").attributes("aria-label"), unset.get("button").text()]).toEqual([
      fill(de["keyCapture.nameUnset"], { action: "Fase" }),
      de["keyCapture.notSet"],
    ]);
  });

  it("opens a German dialog and speaks the result", async () => {
    const w = render("Ctrl+Shift+Z", true);
    await w.get("button").trigger("click");
    await settle();
    expect($(".ui-dialog h2")?.textContent).toBe(fill(de["keyCapture.title"], { action: "Fase" }));
    const pad = $(".ui-dialog [role='application']")!;
    expect(pad.getAttribute("aria-label")).toBe(fill(de["keyCapture.pad"], { action: "Fase" }));
    expect($(".key-capture-hint")?.textContent).toBe(de["keyCapture.hint"]);
    expect([...document.querySelectorAll(".ui-dialog-foot button")].map((b) => b.textContent?.trim())).toEqual([
      de["keyCapture.clear"],
      de["keyCapture.cancel"],
    ]);
    pad.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await settle();
    expect(announce).toHaveBeenCalledWith(
      fill(de["keyCapture.isNow"], { action: "Fase", keys: spokenKeys("Ctrl+Shift+Z") }),
      "polite",
    );
  });

  it("speaks the no shortcut line after a clear", async () => {
    const w = mount(KeyCapture, {
      props: { action: "Fase", keys: "Ctrl+Z", clearable: true, onClear: () => void w.setProps({ keys: "" }) },
      attachTo: document.body,
    });
    await w.get("button").trigger("click");
    await settle();
    [...document.querySelectorAll<HTMLElement>(".ui-dialog-foot button")][0]!.click();
    await settle();
    expect(announce).toHaveBeenCalledWith(fill(de["keyCapture.none"], { action: "Fase" }), "polite");
  });

  it("follows a language switch while the dialog is open", async () => {
    const w = render("Ctrl+Z");
    await w.get("button").trigger("click");
    await settle();
    await setLanguage("en");
    await settle();
    expect($(".ui-dialog h2")?.textContent).toBe(fill(en["keyCapture.title"], { action: "Fase" }));
    expect(w.get("button").attributes("aria-label")).toBe("Fase, shortcut Control Z, change");
    await setLanguage("de");
    await settle();
    expect($(".ui-dialog h2")?.textContent).toBe(fill(de["keyCapture.title"], { action: "Fase" }));
  });
});

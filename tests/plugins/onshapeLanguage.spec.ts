// The Onshape plugin's dialog, settings card, link refusals and import errors read in the chosen language through its
// own lines. What Onshape itself sends back stays as it arrives. Nothing here reaches Onshape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const native = vi.hoisted(() => ({
  loadKeys: vi.fn(),
  forgetKeys: vi.fn(),
}));
vi.mock("../../plugins/FundaCAD.Onshape/native", () => native);

import KeysSection from "../../plugins/FundaCAD.Onshape/KeysSection.vue";
import LinkDialog from "../../plugins/FundaCAD.Onshape/LinkDialog.vue";
import { onshapeClient, OnshapeError } from "../../plugins/FundaCAD.Onshape/client";
import type { LinkRequest } from "../../plugins/FundaCAD.Onshape/dialog";
import { pollTranslation } from "../../plugins/FundaCAD.Onshape/translate";
import { parseOnshapeUrl } from "../../plugins/FundaCAD.Onshape/url";
import { setLanguage } from "../../src/i18n";
import { stubResizeObserver } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(async () => {
  document.body.innerHTML = "";
  setActivePinia(createPinia());
  stubResizeObserver(vi.stubGlobal);
  native.loadKeys.mockReset();
  await setLanguage("en");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await setLanguage("system");
});

const text = (sel: string) => document.body.querySelector(sel)?.textContent?.trim();

async function dialog(askKeys: boolean) {
  const req: LinkRequest = { askKeys, resolve: vi.fn() };
  mount(LinkDialog, { props: { req }, attachTo: document.body });
  await flushPromises();
  return req;
}

describe("the Onshape link dialog follows the language", () => {
  it("reads German, with the labels the fields are named by", async () => {
    await setLanguage("de");
    await dialog(true);
    const dlg = document.body.querySelector("[role=dialog]")!;
    expect(dlg.textContent).toContain("Von Onshape-Link importieren");
    expect(dlg.textContent).toContain("Zugriffsschlüssel");
    expect(dlg.textContent).toContain("Geheimer Schlüssel");
    expect(dlg.textContent).toContain("Abbrechen");
    expect(dlg.textContent).toContain("Importieren");
    expect(document.body.querySelector("[data-testid=onshape-secret]")?.getAttribute("aria-label")).toBe(
      "Geheimer Schlüssel",
    );
  });

  it("reads Japanese, and a refused link is a Japanese error alert", async () => {
    await setLanguage("ja");
    await dialog(false);
    const dlg = document.body.querySelector("[role=dialog]")!;
    expect(dlg.textContent).toContain("Onshape のリンクからインポート");
    expect(dlg.textContent).toContain("別のキーを使う");
    const buttons = [...dlg.querySelectorAll("button")];
    buttons.find((b) => b.textContent?.trim() === "インポート")!.click();
    await flushPromises();
    expect(text("[role=alert]")).toBe(
      "エラー: リンクではありません。Onshape のドキュメントまたはパートスタジオのアドレスをコピーしてください。",
    );
  });

  it("says in German that both keys are needed", async () => {
    await setLanguage("de");
    await dialog(true);
    const input = document.body.querySelector<HTMLInputElement>("[data-testid=onshape-link]")!;
    input.value = "https://cad.onshape.com/documents/aaaaaaaaaaaaaaaaaaaaaaaa";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>("[data-testid=onshape-import]")!.click();
    await flushPromises();
    expect(text("[role=alert]")).toBe(
      "Fehler: Fügen Sie sowohl den Zugriffsschlüssel als auch den geheimen Schlüssel ein.",
    );
  });
});

describe("the Onshape keys setting follows the language", () => {
  it("reads German and French, and a switch changes it", async () => {
    native.loadKeys.mockResolvedValue({ access: "a", secret: "s" });
    await setLanguage("de");
    mount(KeysSection, { attachTo: document.body });
    await flushPromises();
    expect(text(".pref-title")).toBe("API-Schlüssel");
    expect(text("button")).toBe("Schlüssel vergessen");
    expect(text("[role=status]")).toContain("Anmeldedatenspeicher des Systems");
    await setLanguage("fr");
    await flushPromises();
    expect(text(".pref-title")).toBe("Clés d'API");
    expect(text("button")).toBe("Oublier les clés");
  });

  it("puts a failure behind the language's Error word", async () => {
    native.loadKeys.mockRejectedValue(new Error("keychain locked"));
    await setLanguage("ja");
    mount(KeysSection, { attachTo: document.body });
    await flushPromises();
    expect(text("[role=alert]")).toMatch(/^エラー: .*keychain locked/);
  });
});

describe("the Onshape link refusals follow the language", () => {
  it("returns the refusal in the active language", async () => {
    expect(parseOnshapeUrl("nope")).toEqual({
      error: "That is not a link. Copy the address of an Onshape document or part studio.",
    });
    await setLanguage("de");
    expect(parseOnshapeUrl("nope")).toEqual({
      error: "Das ist kein Link. Kopieren Sie die Adresse eines Onshape-Dokuments oder Part Studios.",
    });
    expect(parseOnshapeUrl("https://example.com/documents/x")).toEqual({
      error: "Das ist kein Onshape-Link. Er sollte mit https://cad.onshape.com/documents/ beginnen",
    });
    await setLanguage("ja");
    expect(parseOnshapeUrl("https://cad.onshape.com/nothing")).toEqual({
      error:
        "このリンクは Onshape のドキュメントを指していません。パートスタジオを開いて、そのアドレスをコピーしてください。",
    });
  });
});

describe("the Onshape import errors follow the language", () => {
  const response = (status: number, text: string | null = null) => ({
    status,
    contentType: null,
    location: null,
    retryAfter: null,
    text,
    path: null,
    len: null,
  });
  const client = (status: number, body: string | null = null) =>
    onshapeClient({
      transport: async () => response(status, body),
      keys: { access: "a", secret: "s" },
      sleep: async () => undefined,
    });
  const message = (p: Promise<unknown>) =>
    p.then(
      () => "",
      (e: Error) => e.message,
    );

  it("keeps the sentence in German and what Onshape said as it came", async () => {
    await setLanguage("de");
    const url = "https://cad.onshape.com/api/documents/x";
    expect(await message(client(404).send("GET", url))).toBe(
      "Onshape konnte dieses Dokument nicht finden, oder diese Schlüssel können es nicht öffnen",
    );
    expect(await message(client(500, JSON.stringify({ message: "Internal trouble" })).send("GET", url))).toBe(
      "Onshape antwortete mit 500: Internal trouble",
    );
  });

  it("says the wait in minutes with the language's plural", async () => {
    const stuck = { id: "t1", requestState: "ACTIVE" };
    const run = (minutes: number) =>
      message(
        pollTranslation(async () => stuck, stuck, {
          sleep: async () => undefined,
          now: (() => {
            let at = 0;
            return () => (at += minutes * 60_000 + 1);
          })(),
          timeoutMs: minutes * 60_000,
        }),
      );
    expect(await run(1)).toBe("Onshape has not finished the STEP export after 1 minute");
    await setLanguage("de");
    expect(await run(1)).toBe("Onshape hat den STEP-Export nach 1 Minute nicht abgeschlossen");
    expect(await run(10)).toBe("Onshape hat den STEP-Export nach 10 Minuten nicht abgeschlossen");
    await setLanguage("ja");
    expect(await run(10)).toBe("10 分たっても、Onshape は STEP のエクスポートを終えていません");
  });

  it("is still an OnshapeError with the status", async () => {
    await setLanguage("ja");
    const err = await client(404)
      .send("GET", "https://cad.onshape.com/api/documents/x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnshapeError);
    expect((err as OnshapeError).status).toBe(404);
  });
});

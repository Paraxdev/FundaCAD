// The Onshape settings and link dialog for a screen reader: every control is named, the API keys are one group, a
// refused link is an error alert in words. Nothing here reaches Onshape or the system credential store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const native = vi.hoisted(() => ({
  loadKeys: vi.fn(),
  forgetKeys: vi.fn(),
}));
vi.mock("../../plugins/FundaCAD.Onshape/native", () => native);

import KeysSection from "../../plugins/FundaCAD.Onshape/KeysSection.vue";
import LinkDialog from "../../plugins/FundaCAD.Onshape/LinkDialog.vue";
import type { LinkRequest } from "../../plugins/FundaCAD.Onshape/dialog";
import { byName, nameOf, rawControls, stubResizeObserver, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  setActivePinia(createPinia());
  stubResizeObserver(vi.stubGlobal);
  native.loadKeys.mockReset();
  native.forgetKeys.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

// The frame's own close button is the app's, named Close.
const raw = (root: Element) => rawControls(root).filter((r) => r !== "button.modal-close");

async function keys(stored: boolean | Error) {
  if (stored instanceof Error) native.loadKeys.mockRejectedValue(stored);
  else native.loadKeys.mockResolvedValue(stored ? { access: "a", secret: "s" } : null);
  mount(KeysSection, { attachTo: document.body });
  await flushPromises();
  return document.body;
}

async function link(askKeys: boolean) {
  const req: LinkRequest = { askKeys, resolve: vi.fn() };
  mount(LinkDialog, { props: { req }, attachTo: document.body });
  await flushPromises();
  return { root: document.body, req };
}

describe("the Onshape API keys setting, for a screen reader", () => {
  it("is one group named API keys with a named Forget keys button", async () => {
    const root = await keys(true);
    const group = root.querySelector("[role=group]")!;
    expect(nameOf(group)).toBe("API keys");
    expect(raw(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
    expect(byName(group, "button", "Forget keys")).toBeDefined();
  });

  it("offers no button when none are stored, and says so as a status", async () => {
    const root = await keys(false);
    expect(root.querySelectorAll("button")).toHaveLength(0);
    expect(root.querySelector("[role=status]")?.textContent).toMatch(/No keys are stored/);
  });

  it("calls a keychain failure an error alert in words", async () => {
    const root = await keys(new Error("keychain locked"));
    expect(root.querySelector("[role=alert]")?.textContent).toMatch(/^Error: .*keychain locked/);
  });
});

describe("the Onshape link dialog, for a screen reader", () => {
  it("names the dialog and every control, with the link hint describing the link", async () => {
    const { root } = await link(false);
    const dialog = root.querySelector("[role=dialog]")!;
    expect(nameOf(dialog)).toBe("Import from Onshape link");
    expect(raw(root)).toEqual([]);
    expect(unnamed(dialog)).toEqual([]);
    const field = root.querySelector<HTMLInputElement>("[data-testid=onshape-link]")!;
    expect(nameOf(field)).toBe("Link");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toMatch(/part studio/);
    expect(byName(dialog, "button", "Use other keys")).toBeDefined();
  });

  it("names the key fields and the remember box once keys are asked for", async () => {
    const { root } = await link(true);
    expect(raw(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
    expect(nameOf(root.querySelector("[data-testid=onshape-access]")!)).toBe("Access key");
    const secret = root.querySelector<HTMLInputElement>("[data-testid=onshape-secret]")!;
    expect(nameOf(secret)).toBe("Secret key");
    expect(secret.type).toBe("password");
    expect(byName(root, "input[type=checkbox]", /Remember in the system's credential store/)).toBeDefined();
  });

  it("calls a refused link an error alert in words and leaves the dialog open", async () => {
    const { root, req } = await link(false);
    expect(root.querySelector("[role=alert]")).toBeNull();
    byName<HTMLButtonElement>(root, "button", "Import")!.click();
    await flushPromises();
    const alert = root.querySelector("[role=alert]")!;
    expect(alert.textContent).toMatch(/^Error: /);
    expect(alert.getAttribute("data-testid")).toBe("onshape-error");
    expect(req.resolve).not.toHaveBeenCalled();
  });

  it("calls missing keys an error alert, then imports with them", async () => {
    const { root, req } = await link(true);
    const type = async (sel: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(sel)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flushPromises();
    };
    await type("[data-testid=onshape-link]", "https://cad.onshape.com/documents/aaaaaaaaaaaaaaaaaaaaaaaa");
    byName<HTMLButtonElement>(root, "button", "Import")!.click();
    await flushPromises();
    expect(root.querySelector("[role=alert]")?.textContent).toBe(
      "Error: Paste both the access key and the secret key.",
    );
    await type("[data-testid=onshape-access]", "acc");
    await type("[data-testid=onshape-secret]", "sec");
    byName<HTMLButtonElement>(root, "button", "Import")!.click();
    await flushPromises();
    expect(req.resolve).toHaveBeenCalledWith(expect.objectContaining({ keys: { access: "acc", secret: "sec" } }));
  });

  it("activates a focused button on Enter rather than importing", async () => {
    const { root, req } = await link(false);
    const other = byName<HTMLButtonElement>(root, "button", "Use other keys")!;
    other.focus();
    other.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(root.querySelector("[role=alert]")).toBeNull();
    expect(req.resolve).not.toHaveBeenCalled();
  });
});

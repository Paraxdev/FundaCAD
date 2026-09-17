// The custom bed size dialog: prefilled fields, validation, and its three
// exits (OK, Cancel, Escape). Mounted directly rather than through the host,
// same call CustomBedHost.vue makes once there is a request to answer.

import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import CustomBedDialog from "../../plugins/FundaCAD.PrintToolbox/CustomBedDialog.vue";
import type { CustomBedRequest } from "../../plugins/FundaCAD.PrintToolbox/customBedDialog";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLInputElement>(sel);

function open(resolve = vi.fn()) {
  const req: CustomBedRequest = { initial: [200, 200, 200], resolve };
  mount(CustomBedDialog, { props: { req }, attachTo: document.body });
  return resolve;
}

describe("CustomBedDialog", () => {
  it("prefills the three fields from the stored custom size", () => {
    open();
    expect($('[data-testid="bed-custom-width"]')!.value).toBe("200");
    expect($('[data-testid="bed-custom-depth"]')!.value).toBe("200");
    expect($('[data-testid="bed-custom-height"]')!.value).toBe("200");
  });

  it("resolves the typed size on OK", async () => {
    const resolve = open();
    $('[data-testid="bed-custom-width"]')!.value = "120";
    $('[data-testid="bed-custom-width"]')!.dispatchEvent(new Event("input"));
    $('[data-testid="bed-custom-depth"]')!.value = "130";
    $('[data-testid="bed-custom-depth"]')!.dispatchEvent(new Event("input"));
    $('[data-testid="bed-custom-height"]')!.value = "140";
    $('[data-testid="bed-custom-height"]')!.dispatchEvent(new Event("input"));
    $('[data-testid="bed-custom-confirm"]')!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(resolve).toHaveBeenCalledWith([120, 130, 140]);
  });

  it("shows an inline message and does not resolve on a non-positive value", async () => {
    const resolve = open();
    $('[data-testid="bed-custom-width"]')!.value = "-5";
    $('[data-testid="bed-custom-width"]')!.dispatchEvent(new Event("input"));
    $('[data-testid="bed-custom-confirm"]')!.dispatchEvent(new Event("click", { bubbles: true }));
    await nextTick();
    expect(resolve).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="bed-custom-error"]')?.textContent).toContain("positive");
  });

  it("resolves null on Cancel and does nothing else", () => {
    const resolve = open();
    $('[data-testid="bed-custom-cancel"]')!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(resolve).toHaveBeenCalledWith(null);
  });

  it("resolves null on Escape", () => {
    const resolve = open();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(resolve).toHaveBeenCalledWith(null);
  });

  it("accepts on Enter", () => {
    const resolve = open();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(resolve).toHaveBeenCalledWith([200, 200, 200]);
  });
});

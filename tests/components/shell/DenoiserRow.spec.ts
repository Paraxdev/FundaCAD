import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DenoiserRow from "../../../src/components/shell/DenoiserRow.vue";
import { denoiserState } from "../../../src/viewport/pathtrace/denoiser";

afterEach(() => {
  denoiserState.info = null;
});

const offer = () => {
  denoiserState.info = { active: "filter", version: "", offered: true, bytes: 40_000_000 };
};

describe("DenoiserRow", () => {
  it("keeps the Preferences download button at the base size, and button-class stays off the row", () => {
    offer();
    const w = mount(DenoiserRow, { props: { hintClass: "pref-hint", buttonClass: "btn" } });
    expect(w.get("[data-denoiser-download]").classes()).toEqual(["btn", "btn-secondary", "btn-md"]);
    expect(w.get(".denoiser-row").classes()).toEqual(["denoiser-row"]);
    w.unmount();
  });

  it("draws the small button when the Render dock asks for it", () => {
    offer();
    const w = mount(DenoiserRow, { props: { hintClass: "sm-hint", size: "sm" } });
    expect(w.get("[data-denoiser-download]").classes()).toEqual(["btn", "btn-secondary", "btn-sm"]);
    w.unmount();
  });
});

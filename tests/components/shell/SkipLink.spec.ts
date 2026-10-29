import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import SkipLink from "../../../src/components/shell/SkipLink.vue";
import { announce } from "../../../src/ui/announce";

vi.mock("../../../src/ui/announce", () => ({ announce: vi.fn() }));
enableAutoUnmount(afterEach);

const host = () => {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
};

beforeEach(() => {
  document.body.innerHTML = "";
  vi.mocked(announce).mockClear();
});

describe("SkipLink", () => {
  it("is a link named Skip to model that points at the Model landmark", () => {
    const w = mount(SkipLink, { attachTo: host() });
    const a = w.get("a");
    expect(a.text()).toBe("Skip to model");
    expect(a.attributes("href")).toBe("#main");
  });

  it("moves focus to the canvas once it is a Tab stop, and leaves the URL alone", async () => {
    document.body.insertAdjacentHTML("beforeend", '<main id="main"><canvas tabindex="0"></canvas></main>');
    const w = mount(SkipLink, { attachTo: host() });
    const before = location.hash;
    await w.get("a").trigger("click");
    expect(document.activeElement).toBe(document.querySelector("canvas"));
    expect(location.hash).toBe(before);
  });

  it("lands on the Model landmark itself when the canvas is not focusable yet", async () => {
    document.body.insertAdjacentHTML("beforeend", '<main id="main"><canvas></canvas></main>');
    const w = mount(SkipLink, { attachTo: host() });
    await w.get("a").trigger("click");
    expect(document.activeElement).toBe(document.getElementById("main"));
  });

  it("says so when the model is not on screen", async () => {
    const w = mount(SkipLink, { attachTo: host() });
    await w.get("a").trigger("click");
    expect(announce).toHaveBeenCalledWith("The model is not on screen");
  });
});

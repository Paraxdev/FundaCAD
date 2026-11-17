import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { setLanguage } from "../../../src/i18n";
import TourCard from "../../../src/components/home/TourCard.vue";

enableAutoUnmount(afterEach);

describe("the guided bracket card", () => {
  it("wears an example's tile and asks to start once per click", async () => {
    const w = mount(TourCard, { attachTo: document.body });
    const tile = w.get("button");
    expect(w.classes()).toEqual(expect.arrayContaining(["home-cell", "home-tour"]));
    expect(tile.classes()).toContain("home-example");
    expect(tile.attributes("data-action")).toBe("first-bracket");
    expect(tile.attributes("title")).toBe("A guide shows each step of an L bracket, from sketch to STL");
    expect(w.get(".home-example-name").text()).toBe("Your first bracket");
    expect(w.get(".home-example-line").text()).toBe("Guided, about 10 minutes");
    expect(w.get(".home-card-pic svg").attributes("data-icon")).toBe("play");
    await tile.trigger("click");
    expect(w.emitted("start")).toHaveLength(1);
  });

  it("reads in the chosen language", async () => {
    await setLanguage("fr");
    try {
      const w = mount(TourCard);
      expect(w.get(".home-example-name").text()).toBe("Votre premier support");
      expect(w.get(".home-example-line").text()).toBe("Guidé, environ 10 minutes");
    } finally {
      await setLanguage("system");
    }
  });
});

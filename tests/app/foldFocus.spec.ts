// Where focus goes when the stage turns narrow or wide: a card that folds hands it to its drawer switch, a switch that
// goes away hands it to its card, and focus that is still somewhere is left alone.
import { afterEach, describe, expect, it } from "vitest";
import { foldFocus } from "../../src/app/foldFocus";

afterEach(() => {
  document.body.innerHTML = "";
});

const ITEMS_CARD = `
  <aside id="browser">
    <button class="float-card-close">Hide the items</button>
    <div role="tablist"><button role="tab" id="tab-items" tabindex="0">Items</button>
      <button role="tab" tabindex="-1">Geometry</button></div>
    <div role="tree"><div role="treeitem" id="row" tabindex="0">Box</div></div>
  </aside>`;
const SWITCHES = `
  <button id="sw-items" data-drawer-switch="items">Items</button>
  <button id="sw-history" data-drawer-switch="history">History</button>`;

function page(html: string) {
  document.body.innerHTML = `<main id="main">${html}</main>`;
}
const at = (id: string) => document.getElementById(id) as HTMLElement;
const active = () => document.activeElement?.id || document.activeElement?.tagName;

describe("foldFocus", () => {
  it("gives a row of a card that folded to that drawer's switch", () => {
    page(ITEMS_CARD);
    at("row").focus();
    const refocus = foldFocus();
    page(SWITCHES);
    refocus();
    expect(active()).toBe("sw-items");
  });

  it("gives the sketch options' focus to the History switch", () => {
    page(`<div id="palette"><button id="opt">Grid</button></div>`);
    at("opt").focus();
    const refocus = foldFocus();
    page(SWITCHES);
    refocus();
    expect(active()).toBe("sw-history");
  });

  it("gives a switch that went away to its card's first control after the close button", () => {
    page(SWITCHES + ITEMS_CARD);
    at("sw-items").focus();
    const refocus = foldFocus();
    at("sw-items").remove();
    at("sw-history").remove();
    refocus();
    expect(active()).toBe("tab-items");
  });

  it("lands on main when neither the switch nor the card is left", () => {
    page(SWITCHES);
    at("sw-items").focus();
    const refocus = foldFocus();
    page("");
    refocus();
    expect(active()).toBe("main");
  });

  it("leaves focus that is still on something, and focus that was outside the cards", () => {
    page(SWITCHES + ITEMS_CARD + `<button id="other">Other</button>`);
    at("row").focus();
    const keep = foldFocus();
    at("other").focus();
    keep();
    expect(active()).toBe("other");
    const outside = foldFocus();
    at("other").remove();
    outside();
    expect(active()).not.toBe("sw-items");
  });
});

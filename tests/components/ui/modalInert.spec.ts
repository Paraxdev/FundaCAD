import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inertDepth, inertOthers } from "../../../src/composables/useModalGate";

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const inert = (sel: string) => $(sel).hasAttribute("inert");
let releases: (() => void)[] = [];
const hold = (el: HTMLElement, keep?: string[]) => {
  const r = inertOthers(el, keep);
  releases.push(r);
  return r;
};

beforeEach(() => {
  document.body.innerHTML = `
    <div id="app">
      <header id="titlebar"><button id="home-btn">Home</button><span id="brand">B</span></header>
      <div id="main"><div id="stage"><div id="viewport"></div><div id="home"><button>Open</button></div></div></div>
    </div>
    <div id="toasts"></div>
    <div class="toast-stack"><button>Undo</button></div>
    <div id="a11y-announcer"><div role="status"></div></div>
    <script id="boot"></script>
    <div id="dlg-a" class="overlay"><div class="panel"><button>A</button></div></div>
    <div id="dlg-b" class="overlay"><div class="panel"><button>B</button></div></div>`;
});
afterEach(() => {
  for (const r of releases) r();
  releases = [];
});

describe("inertOthers", () => {
  it("marks every body child but the dialog and the announcer inert and hidden", () => {
    hold($("#dlg-a .panel"));
    expect(inert("#app")).toBe(true);
    expect($("#app").getAttribute("aria-hidden")).toBe("true");
    expect(inert("#toasts")).toBe(true);
    expect(inert("#dlg-b")).toBe(true);
    expect(inert("#dlg-a")).toBe(false);
    expect(inert("#a11y-announcer")).toBe(false);
    expect(inert("#boot")).toBe(false);
    expect(inertDepth()).toBe(1);
  });

  it("keeps the toast stack live, since it paints above the overlay", () => {
    hold($("#dlg-a .panel"));
    expect(inert(".toast-stack")).toBe(false);
    expect($(".toast-stack").hasAttribute("aria-hidden")).toBe(false);
  });

  it("walks into the app for a modal inside it, so only its siblings at each level go inert", () => {
    hold($("#home"));
    expect(inert("#app")).toBe(false);
    expect(inert("#main")).toBe(false);
    expect(inert("#titlebar")).toBe(true);
    expect(inert("#viewport")).toBe(true);
    expect(inert("#toasts")).toBe(true);
    expect(inert("#home")).toBe(false);
  });

  it("keeps a listed selector live, with the rest of its parent inert", () => {
    hold($("#home"), ["#home-btn"]);
    expect(inert("#titlebar")).toBe(false);
    expect(inert("#home-btn")).toBe(false);
    expect(inert("#brand")).toBe(true);
  });

  it("restores the page when the last layer is released, and a second release does nothing", () => {
    const r = hold($("#dlg-a .panel"));
    r();
    expect(inertDepth()).toBe(0);
    expect(inert("#app")).toBe(false);
    expect($("#app").hasAttribute("aria-hidden")).toBe(false);
    hold($("#dlg-b .panel"));
    r();
    expect(inertDepth()).toBe(1);
    expect(inert("#app")).toBe(true);
  });

  it("hands the page back to the layer below when the top one closes", () => {
    hold($("#dlg-a .panel"));
    const top = hold($("#dlg-b .panel"));
    expect(inert("#dlg-a")).toBe(true);
    expect(inert("#dlg-b")).toBe(false);
    top();
    expect(inert("#dlg-a")).toBe(false);
    expect(inert("#dlg-b")).toBe(true);
    expect(inert("#app")).toBe(true);
  });

  it("keeps the top layer in charge when a lower one is released first", () => {
    const below = hold($("#dlg-a .panel"));
    hold($("#dlg-b .panel"));
    below();
    expect(inertDepth()).toBe(1);
    expect(inert("#dlg-a")).toBe(true);
    expect(inert("#app")).toBe(true);
    expect(inert("#dlg-b")).toBe(false);
  });

  it("lets a modal opened inside the app over a dialog take the page, then gives it back", () => {
    hold($("#dlg-a .panel"));
    const home = hold($("#home"));
    expect(inert("#app")).toBe(false);
    expect(inert("#dlg-a")).toBe(true);
    home();
    expect(inert("#app")).toBe(true);
    expect(inert("#dlg-a")).toBe(false);
  });

  it("never clears an inert or aria-hidden it did not set", () => {
    $("#viewport").setAttribute("inert", "");
    $("#toasts").setAttribute("aria-hidden", "true");
    const r = hold($("#home"));
    expect($("#toasts").hasAttribute("inert")).toBe(true);
    r();
    expect(inert("#viewport")).toBe(true);
    expect(inert("#toasts")).toBe(false);
    expect($("#toasts").getAttribute("aria-hidden")).toBe("true");
  });

  it("hides an element another component made inert from older WebKit too, and gives back only that", () => {
    $("#viewport").setAttribute("inert", "");
    const r = hold($("#home"));
    expect($("#viewport").getAttribute("aria-hidden")).toBe("true");
    r();
    expect(inert("#viewport")).toBe(true);
    expect($("#viewport").hasAttribute("aria-hidden")).toBe(false);
  });

  it("skips a layer whose element left the page without a release", () => {
    hold($("#dlg-a .panel"));
    const gone = $("#dlg-b");
    hold(gone.querySelector<HTMLElement>(".panel")!);
    gone.remove();
    hold($("#home")).call(null);
    expect(inert("#app")).toBe(true);
    expect(inert("#dlg-a")).toBe(false);
  });
});

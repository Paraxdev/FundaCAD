import { afterEach, describe, expect, it } from "vitest";
import { keyTargetFree } from "../../src/ui/focus";

afterEach(() => {
  document.body.innerHTML = "";
});

function page(inner: string): HTMLElement {
  document.body.innerHTML = `<aside id="side"><div id="plain-side"></div><button id="side-btn">x</button></aside><main id="main">${inner}</main>`;
  return document.getElementById("main")!;
}

const at = (id: string) => document.getElementById(id);

describe("keyTargetFree", () => {
  it("is free on the body, the document and a missing target", () => {
    expect(keyTargetFree(document.body)).toBe(true);
    expect(keyTargetFree(document.documentElement)).toBe(true);
    expect(keyTargetFree(null)).toBe(true);
    expect(keyTargetFree(window)).toBe(true);
  });

  it("is free on a plain element and the canvas of the model area", () => {
    page('<div id="panel"><span id="label">a</span></div><canvas id="cv"></canvas>');
    expect(keyTargetFree(at("panel"))).toBe(true);
    expect(keyTargetFree(at("label"))).toBe(true);
    expect(keyTargetFree(at("cv"))).toBe(true);
    expect(keyTargetFree(at("main"))).toBe(true);
  });

  it("is free on the key surface although it is a stop with a role", () => {
    page('<div id="surf" data-key-surface role="application" tabindex="0"></div>');
    expect(keyTargetFree(at("surf"))).toBe(true);
  });

  it("is not free on a control or a widget", () => {
    page(
      [
        '<button id="b">b</button>',
        '<a id="a" href="#x">a</a>',
        '<input id="i" />',
        '<select id="s"></select>',
        '<div id="row" role="treeitem" tabindex="0"></div>',
        '<div id="menu" role="menu"><span id="inner"></span></div>',
        '<div id="stop" tabindex="0"></div>',
        '<div id="ce" contenteditable="true"></div>',
      ].join(""),
    );
    for (const id of ["b", "a", "i", "s", "row", "menu", "inner", "stop", "ce"]) {
      expect(keyTargetFree(at(id)), id).toBe(false);
    }
  });

  it("keeps a tabindex -1 element and contenteditable false free", () => {
    page('<div id="skip" tabindex="-1"></div><div id="ro" contenteditable="false"></div>');
    expect(keyTargetFree(at("skip"))).toBe(true);
    expect(keyTargetFree(at("ro"))).toBe(true);
  });

  it("is not free outside the model area, plain element or not", () => {
    page("");
    expect(keyTargetFree(at("plain-side"))).toBe(false);
    expect(keyTargetFree(at("side-btn"))).toBe(false);
  });
});

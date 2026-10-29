import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createActions } from "../../src/app/actions";
import type { Engine } from "../../src/app/engine";

const finish = vi.fn();
const e = { sketch: { active: true, finish }, lastAction: "extrude" } as unknown as Engine;

beforeEach(() => {
  setActivePinia(createPinia());
  finish.mockClear();
  document.body.innerHTML = `
    <header id="titlebar"><nav id="menubar"><button id="file">File</button></nav></header>
    <div id="toolrail"><button id="sketch">Sketch</button></div>`;
});

describe("the region actions", () => {
  it("step focus between regions and leave the sketch open and the last command alone", () => {
    document.querySelector<HTMLElement>("#file")!.focus();
    createActions(e)("region-next");
    expect(document.activeElement?.id).toBe("sketch");
    createActions(e)("region-prev");
    expect(document.activeElement?.id).toBe("file");
    expect(finish).not.toHaveBeenCalled();
    expect(e.lastAction).toBe("extrude");
  });
});

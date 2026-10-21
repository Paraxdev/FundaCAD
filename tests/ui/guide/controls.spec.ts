import { beforeEach, describe, expect, it } from "vitest";
import { walkControls } from "../../../src/ui/controlRefs";
import { resolveControl } from "../../../src/ui/guide/controls";
import { APP_HTML, mountApp, rect } from "../../harness/fixture";

const FLYOUT = `<div class="float-popover"><button class="flyout-row" data-pick="fillet" aria-label="Fillet"></button></div>`;

beforeEach(() => mountApp());

const resolve = (ref: string) => resolveControl(ref, document, { rect });

describe("resolveControl", () => {
  it("rings the Modify family while Fillet is folded inside it", () => {
    const r = resolve("pick:fillet");
    expect(r.el?.dataset.family).toBe("cat:MODIFY");
    expect(r).toMatchObject({ ref: "pick:fillet", via: "family:cat:MODIFY" });
  });

  it("rings the Fillet row once the flyout is open", () => {
    mountApp(APP_HTML + FLYOUT);
    const r = resolve("pick:fillet");
    expect(r.el?.dataset.pick).toBe("fillet");
    expect(r.via).toBeUndefined();
  });

  it("counts the rail's offer for a selection as the same tool", () => {
    mountApp(APP_HTML + `<nav id="x"><button data-action="offer:fillet" aria-label="Fillet"></button></nav>`);
    expect(resolve("pick:fillet").el?.dataset.action).toBe("offer:fillet");
  });

  it("finds a value box field and a menu item through its menu", () => {
    expect(resolve("field:angle").el?.tagName).toBe("INPUT");
    const m = resolve("menu:File/Open...");
    expect(m).toMatchObject({ via: "menu:File" });
  });

  it("names near misses and the id families when nothing matches", () => {
    const r = resolve("family:cat:MODIF");
    expect(r.el).toBeUndefined();
    if (r.el) return;
    expect(r.near).toContain("family:cat:MODIFY");
    expect(r.missing).toContain("pick:fillet");
  });

  it("names every control the harness lists the same way", () => {
    const { controls } = walkControls(document, { rect });
    expect(controls.length).toBeGreaterThan(5);
    for (const c of controls) {
      if (controls.filter((o) => o.ref === c.ref).length > 1) continue;
      expect(resolve(c.ref).el, c.ref).toBe(c.el);
    }
  });
});

// The Print category and its buttons must show the 3D printer the plugin is, not a paper printer: a portal frame with
// a gantry across it, a nozzle hanging from the gantry and a base plate the posts stand on.

import { describe, expect, it } from "vitest";

import { ICONS } from "../../plugins/FundaCAD.Printing/icons";

const num = (s: string | undefined) => Number(s);

// The posts and top bar as one path, M left bottom V top h width v.
function frameOf(markup: string) {
  const m = /<path d="M([\d.]+) ([\d.]+)V([\d.]+)h([\d.]+)v/.exec(markup)!;
  return { left: num(m[1]), bottom: num(m[2]), top: num(m[3]), right: num(m[1]) + num(m[4]) };
}

function gantryOf(markup: string) {
  const all = [...markup.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"\/>/g)];
  return all.map((m) => ({ x1: num(m[1]), y1: num(m[2]), x2: num(m[3]), y2: num(m[4]) }));
}

function baseOf(markup: string) {
  const m = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"/.exec(markup)!;
  return { left: num(m[1]), top: num(m[2]), right: num(m[1]) + num(m[3]) };
}

// M x y v h1 l dx dy l dx2-dy2 V y: a nozzle block that narrows to a tip.
function nozzleOf(markup: string) {
  const m = /<path d="M([\d.]+) ([\d.]+)v([\d.]+)l([\d.]+) ([\d.]+)l[\d.]+-[\d.]+V[\d.]+"\/>/.exec(markup);
  if (!m) return null;
  return { top: num(m[2]), tip: num(m[2]) + num(m[3]) + num(m[5]), x: num(m[1]) + num(m[4]) };
}

describe("the 3D printer icons", () => {
  for (const name of ["print", "printerSend"]) {
    it(`${name} has a gantry across a frame, a nozzle under it and a base the posts stand on`, () => {
      const markup = ICONS[name]!;
      const frame = frameOf(markup);
      const gantry = gantryOf(markup);
      const base = baseOf(markup);
      const nozzle = nozzleOf(markup);

      expect(gantry).toHaveLength(1);
      expect(gantry[0]).toEqual({ x1: frame.left, y1: gantry[0]!.y1, x2: frame.right, y2: gantry[0]!.y1 });
      expect(gantry[0]!.y1).toBeGreaterThan(frame.top);
      expect(base.top).toBe(frame.bottom);
      expect(base.left).toBeLessThan(frame.left);
      expect(base.right).toBeGreaterThan(frame.right);

      expect(nozzle).not.toBeNull();
      expect(nozzle!.top).toBe(gantry[0]!.y1);
      expect(nozzle!.tip).toBeLessThan(base.top);
      expect(nozzle!.x).toBeGreaterThan(frame.left);
      expect(nozzle!.x).toBeLessThan(frame.right);
    });
  }

  it("keeps the arrow of Send to Printer clear of the printer's base", () => {
    const base = baseOf(ICONS.printerSend!);
    const arrow = /<path d="M([\d.]+) 12h/.exec(ICONS.printerSend!)!;
    expect(num(arrow[1])).toBeGreaterThan(base.right);
  });
});

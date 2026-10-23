import { describe, expect, it, vi } from "vitest";
import { RADIAL_DEADZONE_PX, RADIAL_SUBMENU_PX, RadialSession, pickRadial, radialSlot } from "../../src/ui/radialMenu";
import type { CtxItem } from "../../src/stores/contextMenu";

const eight = () =>
  Array.from({ length: 8 }, (_, i) => ({ label: `item ${i}`, onClick: vi.fn(), onHover: vi.fn() })) as (CtxItem & {
    onClick: ReturnType<typeof vi.fn>;
    onHover: ReturnType<typeof vi.fn>;
  })[];

describe("pickRadial", () => {
  it("puts item 0 at the top and goes clockwise", () => {
    expect(pickRadial(8, 0, -80)).toBe(0);
    expect(pickRadial(8, 80, 0)).toBe(2);
    expect(pickRadial(8, 0, 80)).toBe(4);
    expect(pickRadial(8, -80, 0)).toBe(6);
    expect(pickRadial(8, -60, -62)).toBe(7);
  });
  it("picks nothing inside the dead zone", () => {
    expect(pickRadial(8, 3, 4)).toBe(null);
    expect(pickRadial(8, RADIAL_DEADZONE_PX - 1, 0)).toBe(null);
    expect(pickRadial(0, 100, 0)).toBe(null);
  });
  it("draws each item where it is picked", () => {
    for (let i = 0; i < 5; i++) {
      const p = radialSlot(i, 5);
      expect(pickRadial(5, p.x, p.y)).toBe(i);
    }
  });
});

describe("a press-drag-release ring", () => {
  const open = (items: CtxItem[], gesture: { pointerId: number } | { key: string } = { pointerId: 1 }) => {
    const states: unknown[] = [];
    const s = new RadialSession(400, 300, items, gesture, (st) => states.push(st));
    return { s, states };
  };

  it("runs the item the release points at, exactly once", () => {
    const items = eight();
    const { s } = open(items);
    s.move(480, 300);
    expect(s.state.hot).toBe(2);
    s.release(480, 300);
    s.release(480, 300);
    s.click(480, 300);
    expect(items[2]!.onClick).toHaveBeenCalledTimes(1);
    expect(items.filter((it) => it.onClick.mock.calls.length).length).toBe(1);
    expect(s.open).toBe(false);
  });

  it("runs nothing on Escape or a release in the middle, and the lit row is always let go", () => {
    for (const end of ["escape", "middle"] as const) {
      const items = eight();
      const { s, states } = open(items);
      s.move(400, 220);
      expect(items[0]!.onHover).toHaveBeenLastCalledWith(true);
      if (end === "escape") s.close();
      else {
        s.move(401, 301);
        s.release(401, 301);
      }
      expect(items.some((it) => it.onClick.mock.calls.length)).toBe(false);
      expect(items[0]!.onHover).toHaveBeenLastCalledWith(false);
      expect(states.at(-1)).toBe(null);
    }
  });

  it("closes with the hover ended when a row is lit at the moment it runs", () => {
    const items = eight();
    const { s } = open(items);
    s.move(400, 220);
    s.release(400, 220);
    expect(items[0]!.onHover.mock.calls).toEqual([[true], [false]]);
  });

  it("opens a submenu's ring when the drag goes on past it, and picks from that ring", () => {
    const deep = { label: "deep", onClick: vi.fn() };
    const items: CtxItem[] = [
      { label: "more", children: [{ label: "a", onClick: vi.fn() }, deep] },
      { label: "b", onClick: vi.fn() },
    ];
    const { s } = open(items);
    s.move(400, 300 - RADIAL_SUBMENU_PX);
    expect(s.state.items.map((i) => i.label)).toEqual(["a", "deep"]);
    expect(s.state.y).toBe(300 - RADIAL_SUBMENU_PX);
    s.move(400, 300 - RADIAL_SUBMENU_PX + 80);
    s.release(400, 300 - RADIAL_SUBMENU_PX + 80);
    expect(deep.onClick).toHaveBeenCalledTimes(1);
  });

  it("leaves a ring opened by a key tap up to be clicked", () => {
    const items = eight();
    const { s } = open(items, { key: "w" });
    s.release(400, 300);
    expect(s.open).toBe(true);
    s.click(400, 380);
    expect(items[4]!.onClick).toHaveBeenCalledTimes(1);
  });

  it("does not run a disabled item and skips separators", () => {
    const off = { label: "off", disabled: true, onClick: vi.fn() };
    const { s } = open([off, { label: "", separator: true }, { label: "on", onClick: vi.fn() }]);
    expect(s.state.items.length).toBe(2);
    s.move(400, 220);
    s.release(400, 220);
    expect(off.onClick).not.toHaveBeenCalled();
  });
});

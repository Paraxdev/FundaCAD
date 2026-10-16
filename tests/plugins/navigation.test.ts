import { describe, expect, it, vi } from "vitest";
import { validateBindings } from "../../src/viewport/navigator/bindings";
import { checkShortcut } from "../../src/input/shortcuts";
import { shippedPlugins } from "../../src/plugins/shipped";
import {
  DEFAULT_CONFIG, PRESETS, RADIAL_ACTION, RADIAL_KEY, RING_SLOTS, contextOf, keymapFor, parseConfig, radialItems,
  tableFor, type NavConfig,
} from "../../plugins/FundaCAD.Navigation/navigation";

const cfg = (patch: Partial<NavConfig> = {}): NavConfig => ({ ...structuredClone(DEFAULT_CONFIG), ...patch });

describe("the Navigation plugin", () => {
  it("asks for input.remap and starts off", () => {
    const m = shippedPlugins().find((p) => p.dir === "FundaCAD.Navigation")!.manifest;
    expect(m.grants).toContain("input.remap");
    expect(m.enabledByDefault).toBe(false);
  });

  it("names its presets by the buttons, and each is a table the core accepts", () => {
    expect(PRESETS.map((p) => p.label)).toEqual([
      "Right orbits (default)",
      "Middle orbits, Shift+middle pans",
      "Middle orbits, Ctrl+middle pans",
      "Alt+left orbits",
    ]);
    for (const p of PRESETS) expect(validateBindings(p.table), p.label).toEqual([]);
    for (const p of PRESETS) for (const d of ["alt-right", "right", "middle"] as const) {
      expect(validateBindings(tableFor(cfg({ preset: p.id, radial: true, radialDrag: d })).table), `${p.label} ${d}`).toEqual([]);
    }
  });

  it("keeps the left button alone for selection in every preset", () => {
    for (const p of PRESETS) {
      for (const b of p.table.filter((b) => b.button === "left")) expect(b.alt || b.shift || b.ctrl).toBe(true);
    }
  });

  it("leaves the radial menu off by default, with no gesture and no key", () => {
    const c = parseConfig(null);
    expect(c.radial).toBe(false);
    expect(tableFor(c).table.some((b) => b.drag === "gesture")).toBe(false);
    expect(keymapFor(c).some((k) => k.action === RADIAL_ACTION)).toBe(false);
  });

  it("adds the radial trigger when on, and says why a drag the preset uses cannot be one", () => {
    const on = tableFor(cfg({ radial: true }));
    expect(on.table[0]).toEqual({ button: "right", alt: true, drag: "gesture", click: "menu" });
    expect(keymapFor(cfg({ radial: true }))).toContainEqual({ action: RADIAL_ACTION, key: RADIAL_KEY, context: "global", label: "Radial menu" });
    expect(checkShortcut({ action: RADIAL_ACTION, key: RADIAL_KEY, context: "global" })).toBe(null);
    const taken = tableFor(cfg({ radial: true, radialDrag: "right" }));
    expect(taken.problem).toContain("Right drag already does orbit");
    const free = tableFor(cfg({ preset: "middle-shift", radial: true, radialDrag: "right" }));
    expect(free.problem).toBe(null);
    expect(free.table.find((b) => b.button === "right" && !b.shift)).toEqual({ button: "right", drag: "gesture", click: "menu" });
  });

  it("round-trips its config through storage and survives junk", () => {
    const c = cfg({ preset: "alt-left", radial: true, radialDrag: "middle", keys: [{ action: "fillet", key: "g" }] });
    c.items.sketch = ["line", "circle"];
    expect(parseConfig(JSON.stringify(c))).toEqual(c);
    expect(parseConfig("{nope")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(JSON.stringify({ preset: "warp", items: { model: [3] }, keys: [{ key: 1 }] }))).toEqual(DEFAULT_CONFIG);
  });

  it("offers sketch tools in a sketch and modelling tools on a selection", () => {
    expect(contextOf(true, 3)).toBe("sketch");
    expect(contextOf(false, 1)).toBe("selection");
    expect(contextOf(false, 0)).toBe("model");
    expect(DEFAULT_CONFIG.items.sketch).toContain("line");
    expect(DEFAULT_CONFIG.items.selection).toContain("fillet");
  });

  it("builds a ring with icons and puts the overflow under More", () => {
    const run = vi.fn();
    const ids = Array.from({ length: 10 }, (_, i) => (i === 0 ? "fillet" : `cmd${i}`));
    const items = radialItems(ids, run, (id) => id.toUpperCase(), () => undefined);
    expect(items.length).toBe(RING_SLOTS);
    expect(items[0]!.icon).toBe("fillet");
    expect(items.at(-1)!.label).toBe("More");
    expect(items.at(-1)!.children!.map((c) => c.label)).toEqual(["CMD7", "CMD8", "CMD9"]);
    items[0]!.onClick!();
    expect(run).toHaveBeenCalledWith("fillet");
  });
});

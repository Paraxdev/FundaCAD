import { describe, expect, it } from "vitest";
import type * as THREE from "three";
import { SketchOverlay, type WorldRegion } from "../../src/sketch/overlay";
import { SketchPlane } from "../../src/sketch/plane";
import { detectRegions, regionArea } from "../../src/sketch/region";

const circle = (id: string, radius: number) => ({ type: "circle" as const, id, x: 0, y: 0, radius });
const opacity = (wr: WorldRegion) => (wr.fill!.material as THREE.MeshBasicMaterial).opacity;

describe("an even-odd sketch's holes in the overlay", () => {
  it("draw no fill until hovered, while the material around them does", () => {
    const o = new SketchOverlay();
    const regions = detectRegions("s", [circle("a", 10), circle("b", 5), circle("c", 2)]);
    o.setActiveRegions(regions, new SketchPlane("XY"), "s", [], true);
    const active = (o as unknown as { activeRegions: WorldRegion[] }).activeRegions;
    const byArea = [...active].sort((x, y) => regionArea(y.region) - regionArea(x.region));
    const [ring, counter, island] = [byArea[0]!, byArea[1]!, byArea[2]!];
    expect(counter.hole).toBe(true);
    expect(opacity(counter)).toBe(0);
    expect(opacity(ring)).toBeGreaterThan(0);
    expect(opacity(island)).toBeGreaterThan(0);
    o.setHoverRegion(counter);
    expect(opacity(counter)).toBeGreaterThan(0);
  });
});

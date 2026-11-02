import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { hitAt } from "../../src/sketch/keyCursor";
import type { SnapCandidate } from "../../src/sketch/snap";

const c = (x: number, y: number, priority: number, kind: SnapCandidate["kind"] = "endpoint"): SnapCandidate => ({
  p: new THREE.Vector2(x, y),
  kind,
  priority,
});

describe("hitAt", () => {
  const list = [c(12.5, -3.25, 100), c(40, 7.5, 80, "midpoint")];

  it("finds a candidate within a thousandth of a millimetre and not beyond", () => {
    expect(hitAt(new THREE.Vector2(12.5009, -3.25), list)).toBe(list[0]);
    expect(hitAt(new THREE.Vector2(12.5, -3.2511), list)).toBeNull();
    expect(hitAt(new THREE.Vector2(40, 7.5), list)).toBe(list[1]);
  });

  it("takes the higher priority of two on the same spot, in either order", () => {
    const low = c(5, 9, 60, "control");
    const high = c(5, 9, 100);
    expect(hitAt(new THREE.Vector2(5, 9), [low, high])).toBe(high);
    expect(hitAt(new THREE.Vector2(5, 9), [high, low])).toBe(high);
  });

  it("is null for no candidates", () => {
    expect(hitAt(new THREE.Vector2(1, 2), [])).toBeNull();
  });
});

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { dialPoint, formatTurn } from "../../src/viewport/rotateDial";
import { angleInFrame, rotationFrame } from "../../src/features/transformGizmo";

describe("rotateDial", () => {
  it("puts an angle where the ring drag reads it back", () => {
    const frame = rotationFrame(new THREE.Vector3(0, 0, 1));
    for (const a of [0, 0.4, 2, -1.3]) {
      expect(angleInFrame(dialPoint(frame, a, 62), new THREE.Vector3(), frame)).toBeCloseTo(a, 9);
    }
  });

  it("writes whole turns without a fraction", () => {
    expect(formatTurn(345)).toBe("345°");
    expect(formatTurn(-30)).toBe("-30°");
    expect(formatTurn(7.5)).toBe("7.5°");
  });
});

// The box selection index is built in idle time. An idle callback must stop when its time is up even when every body
// is small: with about 3,000 bodies, one callback that builds them all is a long task in the middle of an orbit.
import { beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { areaIndexReady, drainAreaIndex, scheduleAreaIndex } from "../../src/viewport/areaIndex";
import { fakeBody } from "./areaModel";

const bodies = (n: number) =>
  Array.from({ length: n }, (_, i) => fakeBody(`b${i}`, new THREE.BoxGeometry(1, 1, 1), (t) => t >> 1));

describe("the idle build", () => {
  // Each case starts from an empty queue.
  beforeEach(() => drainAreaIndex(() => true));

  it("builds one body when there is no time left, and moves on", () => {
    const many = bodies(40);
    for (const b of many) scheduleAreaIndex(b);
    drainAreaIndex(() => false);
    expect(many.filter(areaIndexReady)).toHaveLength(1);
    drainAreaIndex(() => false);
    expect(many.filter(areaIndexReady)).toHaveLength(2);
  });

  it("stops between small bodies when its budget runs out", () => {
    const many = bodies(40);
    for (const b of many) scheduleAreaIndex(b);
    let asks = 0;
    // Budget for five checks: each small body finishes in one slice, so only the check before a body spends it.
    drainAreaIndex(() => ++asks <= 5);
    expect(many.filter(areaIndexReady)).toHaveLength(6);
    drainAreaIndex(() => true);
    expect(many.every(areaIndexReady)).toBe(true);
  });

  it("leaves a hidden body for when it is shown", () => {
    const [shown, hidden] = bodies(2);
    hidden!.mesh.visible = false;
    scheduleAreaIndex(hidden!);
    scheduleAreaIndex(shown!);
    drainAreaIndex(() => true);
    expect(areaIndexReady(shown!)).toBe(true);
    expect(areaIndexReady(hidden!)).toBe(false);
    hidden!.mesh.visible = true;
    scheduleAreaIndex(hidden!);
    drainAreaIndex(() => true);
    expect(areaIndexReady(hidden!)).toBe(true);
  });

  it("drops a body hidden after it was queued", () => {
    const [b] = bodies(1);
    scheduleAreaIndex(b!);
    b!.mesh.visible = false;
    drainAreaIndex(() => true);
    expect(areaIndexReady(b!)).toBe(false);
  });
});

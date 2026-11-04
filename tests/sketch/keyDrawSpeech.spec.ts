// What Tab's walk says through the real announcer, timers and all.

import * as THREE from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

import { DimInput } from "../../src/sketch/dimInput";
import { KeyDrawFlow, type KeyDrawHost } from "../../src/sketch/keyDrawFlow";
import type { SnapCandidate } from "../../src/sketch/snap";
import { attachAnnouncer } from "../../src/ui/announce";

let dim: DimInput;
let detach: () => void;
let listener: (e: KeyboardEvent) => void;
const polite = { textContent: "" as string | null };

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main id="main"><div id="free"></div></main>';
  dim = new DimInput();
  polite.textContent = "";
  detach = attachAnnouncer({ polite, assertive: { textContent: "" } });
});
afterEach(() => {
  window.removeEventListener("keydown", listener, true);
  detach();
  dim.dispose();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it("never says the snap a Tab reached once the next Tab has moved the cursor off it", () => {
  const origin: SnapCandidate = { p: new THREE.Vector2(0, 0), kind: "center", priority: 95, label: "Origin" };
  let cursor = new THREE.Vector2(7, -3);
  const host: KeyDrawHost = {
    tool: () => "rectangle",
    base: () => null,
    cursor: () => cursor,
    candidates: () => [origin],
    entities: () => [],
    planeTooEdgeOn: () => false,
    step: () => 5,
    moveTo: (hit) => {
      cursor = hit.p.clone();
    },
    dim: () => dim,
    place: () => null,
    positionBox: () => {},
    prompt: () => {},
    focusSurface: () => true,
    changed: () => {},
  };
  const flow = new KeyDrawFlow(host);
  listener = (e) => void flow.onKey(e);
  window.addEventListener("keydown", listener, true);
  const key = (k: string) =>
    document
      .getElementById("free")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  key("ArrowRight");
  key("Tab");
  expect(cursor.toArray()).toEqual([0, 0]);
  // The first Tab's pause has run out and its sentence waits for a frame when the second Tab comes.
  vi.advanceTimersByTime(150);
  key("Tab");
  expect(cursor.toArray()).toEqual([10, -3]);
  vi.advanceTimersByTime(100);
  expect(polite.textContent).not.toContain("origin");
  vi.advanceTimersByTime(250);
  expect(polite.textContent).toBe("No snap, cursor at 10, minus 3");
});

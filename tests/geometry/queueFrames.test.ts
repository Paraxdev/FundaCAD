import { describe, expect, it } from "vitest";
import { Geometry, type EngineWait } from "../../src/geometry/client";

// Frames about the queue on a shared engine: another client (an assistant, a
// second window) can hold the job thread while a request of ours waits. Only
// frames for a request of ours still in flight may reach the store, anything
// else describes a job this window is not waiting on.

interface Inner {
  pending: Map<string, (m: unknown) => void>;
  onMessage(data: string): void;
}

function geom(pendingIds: string[]) {
  const g = new Geometry();
  const inner = g as unknown as Inner;
  for (const id of pendingIds) inner.pending.set(id, () => {});
  const queue: [string, EngineWait | null][] = [];
  const progress: number[] = [];
  const reports: (number | undefined)[][] = [];
  g.onQueue((id, behind) => queue.push([id, behind]));
  g.onProgress((f, m, t, _id, p) => {
    progress.push(f);
    reports.push([f, m, t, p]);
  });
  const say = (v: object) => inner.onMessage(JSON.stringify(v));
  return { g, inner, queue, progress, reports, say };
}

describe("queue frames", () => {
  it("names who a request of ours waits behind, then clears it when it starts", () => {
    const { queue, say } = geom(["mine"]);
    say({ id: "mine", status: "queued", behind: { who: "assistant", name: "Claude", op: "import" } });
    say({ id: "mine", status: "started" });
    expect(queue).toEqual([
      ["mine", { who: "assistant", name: "Claude", op: "import" }],
      ["mine", null],
    ]);
  });

  it("reads an unknown or missing owner as another session", () => {
    const { queue, say } = geom(["mine"]);
    say({ id: "mine", status: "queued", behind: { who: "martian", op: "rebuild" } });
    expect(queue[0]![1]).toEqual({ who: "session", op: "rebuild" });
  });

  it("ignores frames for a request that is not ours or no longer in flight", () => {
    const { queue, progress, say } = geom(["mine"]);
    say({ id: "theirs", status: "queued", behind: { who: "session", op: "import" } });
    say({ id: "theirs", status: "building", feature: 3, meshed: -1, meshTotal: -1 });
    say({ id: 7, status: "building", feature: 1, meshed: -1, meshTotal: -1 });
    expect(queue).toEqual([]);
    expect(progress).toEqual([]);
    say({ id: "mine", status: "building", feature: 2, meshed: -1, meshTotal: -1 });
    expect(progress).toEqual([2]);
  });

  it("passes the engine's phase through, and reads a frame without one from its feature index", () => {
    const { reports, say } = geom(["mine"]);
    say({ id: "mine", status: "building", phase: 3, feature: -1, meshed: 4, meshTotal: 9 });
    say({ id: "mine", status: "building", phase: 2, feature: -1, meshed: -1, meshTotal: -1 });
    say({ id: "mine", status: "building", feature: 6, meshed: -1, meshTotal: -1 });
    say({ id: "mine", status: "building", feature: -1, meshed: -1, meshTotal: -1 });
    expect(reports).toEqual([
      [-1, 4, 9, 3],
      [-1, -1, -1, 2],
      [6, -1, -1, 1],
      [-1, -1, -1, 0],
    ]);
  });

  it("never settles the pending call on a queue frame", () => {
    const { inner, say } = geom([]);
    let settled = false;
    inner.pending.set("mine", () => {
      settled = true;
    });
    say({ id: "mine", status: "queued", behind: { who: "session", op: "import" } });
    say({ id: "mine", status: "started" });
    expect(settled).toBe(false);
    expect(inner.pending.has("mine")).toBe(true);
  });
});

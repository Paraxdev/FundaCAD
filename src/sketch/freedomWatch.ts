// Runs the freedom probes a pause after the sketch last changed and hands over only the result of the newest sketch.

import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { shapeFreedom, type Freedom } from "./freedom";

type Result = Map<string, Freedom> | null;
export type FreedomRun = (e: ResolvedEntity[], c: SketchConstraint[], isStale: () => boolean) => Promise<Result>;

export const FREEDOM_DELAY_MS = 300;

export class FreedomWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private waiting: string | null = null;
  private delivered: string | null = null;

  constructor(
    private readonly onResult: (result: Result) => void,
    private readonly run: FreedomRun = shapeFreedom,
    private readonly delayMs = FREEDOM_DELAY_MS,
  ) {}

  /** The fingerprint is the sketch's content, so a selection click that rebuilds the same sketch starts nothing. */
  request(entities: ResolvedEntity[], constraints: SketchConstraint[]) {
    const fingerprint = JSON.stringify([entities, constraints]);
    if (fingerprint === this.waiting) return;
    this.stop();
    // An undo back to the shown sketch inside the pause: its words are already up, the newer run must not land.
    if (fingerprint === this.delivered) {
      this.waiting = null;
      return;
    }
    this.waiting = fingerprint;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      const stale = () => generation !== this.generation;
      this.run(entities, constraints, stale)
        .catch(() => null)
        .then((result) => {
          if (stale()) return;
          this.waiting = null;
          this.delivered = fingerprint;
          this.onResult(result);
        });
    }, this.delayMs);
  }

  /** Drops what is waiting or running, and forgets the last result so the next request runs again. */
  cancel() {
    this.stop();
    this.waiting = null;
    this.delivered = null;
  }

  private stop() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

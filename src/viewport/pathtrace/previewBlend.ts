/** A preview's noise differs at every restart, so a moving camera shows a new pattern each frame. An even mix
 *  with the preview before it halves that difference. */
const MIX = 0.5;

/** Over this gap the preview before shows another moment of the move, so a mix would read as a double image. */
const GAP_MS = 100;

export interface PreviewBlendTarget<T> {
  draw(last: T, preview: T, mix: number): void;
  keep(preview: T): void;
}

export class PreviewBlend<T> {
  private lastAt = -Infinity;

  constructor(
    private last: T,
    private target: PreviewBlendTarget<T>,
  ) {}

  /** Once for each preview the tracer has just drawn on the canvas. */
  drew(preview: T, now: number) {
    if (now - this.lastAt <= GAP_MS) this.target.draw(this.last, preview, MIX);
    this.target.keep(preview);
    this.lastAt = now;
  }
}

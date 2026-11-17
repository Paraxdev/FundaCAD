// A guided tour on a guide session of its own, beside the assistant's: each step is a highlight and a wait for Next,
// passed early when its check holds. The layer's frame loop calls observe() while the wait is open, and every update
// it emits is a chance to check.

import { crumb } from "../../diagnostics/breadcrumbs";
import type { GuideSession, GuideTarget } from "../guide/guideSession";
import type { TourContext } from "./context";

export interface TourStep {
  /** null is a caption alone. A function picks the target as the step is shown, such as one History row. */
  target: GuideTarget | null | ((ctx: TourContext) => GuideTarget | null);
  caption: () => string;
  /** Shown under the caption once the step has been up for HINT_MS; null while it has nothing to add. */
  hint?: (ctx: TourContext) => string | null;
  /** A value read as the step is shown, for `done` to compare against, such as a distance. */
  enter?: (ctx: TourContext) => unknown;
  /** Absent is Next only. The last step always ends on Next. */
  done?: (ctx: TourContext, entered: unknown) => boolean;
}

/** The toasts, each in the user's language. */
export interface TourLines {
  finished(): string;
  /** Another document opened. */
  opened(): string;
  /** An assistant's guide step arrived. */
  assistant(): string;
  /** A start refused while an assistant's guide is up. */
  refused(): string;
}

export interface Tour {
  id: string;
  steps: TourStep[];
  lines: TourLines;
}

export type TourEnd = "finished" | "stopped" | "assistant" | "opened";

export interface TourState {
  /** The tour running or the last one to end, null before any. */
  id: string | null;
  /** 1 based, where it is or where it ended. */
  step: number;
  of: number;
  ended: TourEnd | null;
}

export const HINT_MS = 6000;

export class TourRunner {
  private tour: Tour | null = null;
  private at = 0;
  private entered: unknown = undefined;
  private seq = 0;
  private waitSeq = 0;
  private shownAt = 0;
  private busy = false;
  private st: TourState = { id: null, step: 0, of: 0, ended: null };

  constructor(
    readonly session: GuideSession,
    private readonly ctx: TourContext,
    private readonly assistant: GuideSession,
    private readonly toast: (message: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    // The session also emits from inside apply(), setHint() and reset(), which this runner calls itself.
    session.subscribe(() => {
      if (!this.busy) this.busyWith(() => this.check());
    });
    // Its stop or an open wait with nothing on screen leaves the tour running.
    assistant.subscribe((s) => {
      if (this.tour && s.step && !s.step.next) this.end("assistant");
    });
  }

  get state(): TourState {
    return this.st;
  }

  get running(): boolean {
    return this.tour !== null;
  }

  /** False, with a toast, while an assistant's guide is up. */
  start(tour: Tour): boolean {
    if (!tour.steps.length) return false;
    if (this.assistant.active) {
      this.toast(tour.lines.refused());
      return false;
    }
    this.tour = null;
    this.session.reset();
    this.seq = 0;
    this.tour = tour;
    this.busyWith(() => this.enter(0));
    return true;
  }

  documentOpened(): void {
    if (this.tour) this.end("opened");
  }

  private busyWith(fn: () => void): void {
    const was = this.busy;
    this.busy = true;
    try {
      fn();
    } finally {
      this.busy = was;
    }
  }

  private check(): void {
    const tour = this.tour;
    if (!tour) return;
    const s = this.session.state;
    if (s.stopped) return this.end("stopped");
    if (s.wait?.seq === this.waitSeq && s.wait.done === "next") return this.advance();
    const step = tour.steps[this.at]!;
    const last = this.at === tour.steps.length - 1;
    if (!last && step.done?.(this.ctx, this.entered)) return this.advance();
    if (step.hint && this.now() - this.shownAt >= HINT_MS) this.session.setHint(step.hint(this.ctx) || undefined);
  }

  private advance(): void {
    if (this.at + 1 >= this.tour!.steps.length) return this.end("finished");
    this.enter(this.at + 1);
  }

  /** Steps already done as they come up are passed in one go, never the last. */
  private enter(i: number): void {
    const steps = this.tour!.steps;
    let entered = steps[i]!.enter?.(this.ctx);
    while (i < steps.length - 1 && steps[i]!.done?.(this.ctx, entered)) {
      i++;
      entered = steps[i]!.enter?.(this.ctx);
    }
    this.at = i;
    this.entered = entered;
    this.shownAt = this.now();
    this.show();
  }

  private show(): void {
    const tour = this.tour!;
    const step = tour.steps[this.at]!;
    const n = tour.steps.length;
    const target = typeof step.target === "function" ? step.target(this.ctx) : step.target;
    this.st = { id: tour.id, step: this.at + 1, of: n, ended: null };
    crumb(`[tour] ${tour.id} step ${this.at + 1} of ${n}`);
    const highlight = ++this.seq;
    this.waitSeq = ++this.seq;
    this.session.apply([
      { kind: "highlight", seq: highlight, step: this.at + 1, of: n, caption: step.caption(), target: target ?? {} },
      { kind: "wait", seq: this.waitSeq, until: ["next"] },
    ]);
  }

  private end(why: TourEnd): void {
    const tour = this.tour!;
    this.tour = null;
    this.st = { ...this.st, ended: why };
    crumb(`[tour] ${tour.id} ended ${why} at step ${this.st.step} of ${this.st.of}`);
    this.session.reset();
    const line =
      why === "finished"
        ? tour.lines.finished()
        : why === "opened"
          ? tour.lines.opened()
          : why === "assistant"
            ? tour.lines.assistant()
            : null;
    if (line) this.toast(line);
  }
}

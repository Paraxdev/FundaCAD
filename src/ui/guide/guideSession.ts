// Guide mode's state: the step on screen, the wait an assistant has armed, and
// the user's Stop. Commands arrive through the live session (src/live/liveSession.ts)
// and the state goes back the same way. No Vue import, so the headless suite drives it.

import {
  WAIT_KINDS,
  describeEvent,
  diffSnapshot,
  matchWait,
  type GuideEvent,
  type Snapshot,
  type WaitKind,
} from "./wait";

export interface GuideTarget {
  ui?: string | undefined;
  model?: string | undefined;
  /** Viewport fractions, 0 to 1. */
  region?: { x: number; y: number; w: number; h: number };
}

export interface Resolution {
  found: boolean;
  /** The control the ring is on, when it is not the one asked for. */
  via?: string | undefined;
  missing?: string | undefined;
  near?: string[] | undefined;
}

export interface StepState extends Resolution {
  seq: number;
  step: number;
  of: number;
  caption: string;
  target: GuideTarget;
  /** Next was pressed on this step. */
  next: boolean;
}

export type WaitDone = "met" | "next" | "stopped" | "cleared";

export interface WaitState {
  seq: number;
  until: WaitKind[];
  tool?: string | undefined;
  field?: string | undefined;
  done: WaitDone | null;
  what: string | null;
}

export interface GuideState {
  ack: number;
  step: StepState | null;
  wait: WaitState | null;
  stopped: { n: number; step: number; of: number } | null;
}

type Listener = (s: GuideState) => void;
type Command = Record<string, unknown>;

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function targetOf(v: unknown): GuideTarget {
  const t = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const r = t.region as Record<string, unknown> | undefined;
  if (r && typeof r === "object") {
    const f = (k: string) => Math.max(0, Math.min(1, num(r[k], 0)));
    return { region: { x: f("x"), y: f("y"), w: f("w"), h: f("h") } };
  }
  if (str(t.model)) return { model: str(t.model) };
  return { ui: str(t.ui) ?? "" };
}

export class GuideSession {
  private s: GuideState = { ack: 0, step: null, wait: null, stopped: null };
  private last: Snapshot | null = null;
  private listeners = new Set<Listener>();

  constructor(
    private readonly resolve: (t: GuideTarget) => Resolution,
    private readonly snapshot: () => Snapshot,
  ) {}

  get state(): GuideState {
    return this.s;
  }

  /** A step on screen or a wait still open, the live loop polls fast while so. */
  get active(): boolean {
    return (!!this.s.step && !this.s.step.next) || (!!this.s.wait && !this.s.wait.done);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.s);
    return () => this.listeners.delete(fn);
  }

  apply(commands: unknown[]): void {
    if (!commands.length) return;
    for (const raw of commands) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Command;
      const seq = num(c.seq, 0);
      if (seq <= this.s.ack) continue;
      if (c.kind === "highlight") this.highlight(c, seq);
      else if (c.kind === "clear") this.clear();
      else if (c.kind === "wait") this.arm(c, seq);
      this.s = { ...this.s, ack: seq };
    }
    this.emit();
  }

  /** The layer found the target somewhere else, such as Modify opening on Fillet. */
  updateResolution(r: Resolution): void {
    const st = this.s.step;
    if (!st || (st.found === r.found && st.via === r.via && st.missing === r.missing)) return;
    this.s = { ...this.s, step: { ...st, ...r, via: r.via, missing: r.missing, near: r.near } };
    this.emit();
  }

  next(): void {
    const st = this.s.step;
    if (!st || st.next) return;
    this.s = { ...this.s, step: { ...st, next: true } };
    this.decide({ kind: "next" });
    this.emit();
  }

  /** Stop clears everything and records it for the assistant. */
  stop(): void {
    const st = this.s.step;
    const at = st ? { step: st.step, of: st.of } : { step: 0, of: 0 };
    const n = (this.s.stopped?.n ?? 0) + 1;
    let wait = this.s.wait;
    if (wait && !wait.done) wait = { ...wait, done: "stopped", what: stoppedText(at) };
    this.s = { ...this.s, step: null, wait, stopped: { n, ...at } };
    this.last = null;
    this.emit();
  }

  /** Called on every follow frame and document change while a wait is open. */
  observe(): void {
    const w = this.s.wait;
    if (!w || w.done) return;
    const snap = this.snapshot();
    const prev = this.last ?? snap;
    this.last = snap;
    for (const ev of diffSnapshot(prev, snap)) if (this.decide(ev)) break;
    this.emit();
  }

  /** The window stopped sharing: nothing it showed stays up. */
  reset(): void {
    this.s = { ack: 0, step: null, wait: null, stopped: null };
    this.last = null;
    this.emit();
  }

  private highlight(c: Command, seq: number): void {
    const target = targetOf(c.target);
    const res = this.resolve(target);
    this.s = {
      ...this.s,
      step: { seq, step: num(c.step, 1), of: num(c.of, 1), caption: str(c.caption) ?? "", target, next: false, ...res },
    };
  }

  private clear(): void {
    const w = this.s.wait;
    this.s = {
      ...this.s,
      step: null,
      wait: w && !w.done ? { ...w, done: "cleared", what: "the guide was cleared" } : w,
    };
  }

  private arm(c: Command, seq: number): void {
    const asked = Array.isArray(c.until) ? c.until : [c.until ?? "next"];
    const until = asked.filter((k): k is WaitKind => (WAIT_KINDS as readonly unknown[]).includes(k));
    this.s = {
      ...this.s,
      wait: {
        seq,
        until: until.length ? until : ["next"],
        tool: str(c.tool),
        field: str(c.field),
        done: null,
        what: null,
      },
    };
    this.last = this.snapshot();
    if (this.s.step?.next) this.decide({ kind: "next" });
  }

  private decide(ev: GuideEvent): boolean {
    const w = this.s.wait;
    if (!w || w.done || !matchWait(w, ev)) return false;
    this.s = { ...this.s, wait: { ...w, done: ev.kind === "next" ? "next" : "met", what: describeEvent(ev) } };
    return true;
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.s);
  }
}

export function stoppedText(at: { step: number; of: number }): string {
  const where = at.of ? ` at step ${at.step} of ${at.of}` : "";
  return `the user stopped the guide${where}, everything is cleared`;
}

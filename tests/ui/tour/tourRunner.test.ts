// The tour runner on its own guide session, beside an assistant's. The layer is left out: a frame is observe().

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore, EMPTY_DOCUMENT } from "../../../src/document/store";
import type { GeometryBackend } from "../../../src/geometry/client";
import { LiveSessionHost } from "../../../src/live/liveSession";
import { GuideSession } from "../../../src/ui/guide/guideSession";
import { emptySnapshot } from "../../../src/ui/guide/wait";
import type { TourContext } from "../../../src/ui/tour/context";
import { firstBracketLines } from "../../../src/ui/tour/firstBracket";
import { HINT_MS, TourRunner, type Tour, type TourStep } from "../../../src/ui/tour/tourRunner";

const h = vi.hoisted(() => ({ crumbs: [] as string[] }));
vi.mock(import("../../../src/diagnostics/breadcrumbs"), async (orig) => ({
  ...(await orig()),
  crumb: (m: string) => void h.crumbs.push(m),
}));

beforeEach(() => {
  h.crumbs = [];
});

const FINISHED = "Guide finished. Save your bracket with Ctrl+S.";
const OPENED = "The guided bracket stopped because another document opened.";
const ASSISTANT = "The guided bracket stopped, an assistant started a guide.";
const REFUSED = "An assistant's guide is running. Stop it first, then start the guided bracket.";

const ctx = { features: () => 0 } as unknown as TourContext;
const tourOf = (steps: TourStep[]): Tour => ({ id: "fake", steps, lines: firstBracketLines });

function rig(steps: TourStep[]) {
  const session = new GuideSession(() => ({ found: true }), emptySnapshot);
  const assistant = new GuideSession(() => ({ found: true }), emptySnapshot);
  const toasts: string[] = [];
  let clock = 0;
  const runner = new TourRunner(
    session,
    ctx,
    assistant,
    (m) => toasts.push(m),
    () => clock,
  );
  const opens = new Set<() => void>([() => runner.documentOpened()]);
  return {
    session,
    assistant,
    runner,
    toasts,
    tour: tourOf(steps),
    frame(ms = 0) {
      clock += ms;
      session.observe();
    },
    open: () => opens.forEach((fn) => fn()),
    view() {
      const st = session.state.step;
      return {
        tour: runner.state,
        step: st && { step: st.step, of: st.of, caption: st.caption, target: st.target, hint: st.hint },
        wait: session.state.wait && { until: session.state.wait.until, done: session.state.wait.done },
        toasts: [...toasts],
      };
    },
  };
}

const ui = (ref: string) => ({ ui: ref });

describe("a three step tour", () => {
  it("shows each step, passes one whose check turns true, takes Next, and ends finished with the toast", () => {
    const w = { one: false };
    const r = rig([
      { target: ui("action:sketch"), caption: () => "One", done: () => w.one },
      { target: null, caption: () => "Two" },
      { target: ui("#timeline"), caption: () => "Three", done: () => true },
    ]);
    expect(r.runner.start(r.tour)).toBe(true);
    expect(r.view()).toEqual({
      tour: { id: "fake", step: 1, of: 3, ended: null },
      step: { step: 1, of: 3, caption: "One", target: ui("action:sketch"), hint: undefined },
      wait: { until: ["next"], done: null },
      toasts: [],
    });
    r.frame();
    expect(r.view().tour.step).toBe(1);

    w.one = true;
    r.frame();
    expect(r.view()).toEqual({
      tour: { id: "fake", step: 2, of: 3, ended: null },
      step: { step: 2, of: 3, caption: "Two", target: {}, hint: undefined },
      wait: { until: ["next"], done: null },
      toasts: [],
    });

    r.session.next();
    expect(r.view()).toEqual({
      tour: { id: "fake", step: 3, of: 3, ended: null },
      step: { step: 3, of: 3, caption: "Three", target: ui("#timeline"), hint: undefined },
      wait: { until: ["next"], done: null },
      toasts: [],
    });
    r.frame();
    expect(r.view().tour.step).toBe(3);

    r.session.next();
    expect(r.view()).toEqual({
      tour: { id: "fake", step: 3, of: 3, ended: "finished" },
      step: null,
      wait: null,
      toasts: [FINISHED],
    });
    expect(r.runner.running).toBe(false);
    expect(h.crumbs).toEqual([
      "[tour] fake step 1 of 3",
      "[tour] fake step 2 of 3",
      "[tour] fake step 3 of 3",
      "[tour] fake ended finished at step 3 of 3",
    ]);
  });

  it("ends stopped on Stop, with no toast and the session cleared", () => {
    const r = rig([
      { target: null, caption: () => "One" },
      { target: null, caption: () => "Two" },
    ]);
    r.runner.start(r.tour);
    r.session.next();
    r.session.stop();
    expect(r.view()).toEqual({
      tour: { id: "fake", step: 2, of: 2, ended: "stopped" },
      step: null,
      wait: null,
      toasts: [],
    });
    expect(r.session.state).toEqual({ ack: 0, step: null, wait: null, stopped: null });
    expect(r.session.active).toBe(false);
  });

  it("starts again from step 1 after a stop", () => {
    const r = rig([
      { target: null, caption: () => "One" },
      { target: null, caption: () => "Two" },
    ]);
    r.runner.start(r.tour);
    r.session.next();
    r.session.stop();
    expect(r.runner.start(r.tour)).toBe(true);
    expect([r.view().tour, r.view().step?.caption]).toEqual([{ id: "fake", step: 1, of: 2, ended: null }, "One"]);
  });
});

describe("steps already done", () => {
  it("are passed in one go at start, with a crumb for the step shown only", () => {
    const r = rig([
      { target: null, caption: () => "One", done: () => true },
      { target: null, caption: () => "Two", done: () => true },
      { target: null, caption: () => "Three", done: () => false },
      { target: null, caption: () => "Four" },
    ]);
    r.runner.start(r.tour);
    expect([r.view().tour.step, r.view().step?.caption]).toEqual([3, "Three"]);
    expect(h.crumbs).toEqual(["[tour] fake step 3 of 4"]);
  });

  it("never skip the step before: a later step's check true at start leaves the first on screen", () => {
    const w = { one: false };
    const r = rig([
      { target: null, caption: () => "One", done: () => w.one },
      { target: null, caption: () => "Two", done: () => true },
      { target: null, caption: () => "Three" },
    ]);
    r.runner.start(r.tour);
    for (let i = 0; i < 3; i++) r.frame();
    expect(r.view().step?.caption).toBe("One");
    w.one = true;
    r.frame();
    expect(r.view().step?.caption).toBe("Three");
  });

  it("never pass the last step, which ends on Next alone", () => {
    const r = rig([
      { target: null, caption: () => "One", done: () => true },
      { target: null, caption: () => "Last", done: () => true },
    ]);
    r.runner.start(r.tour);
    for (let i = 0; i < 3; i++) r.frame();
    expect([r.view().tour, r.view().step?.caption]).toEqual([{ id: "fake", step: 2, of: 2, ended: null }, "Last"]);
    r.session.next();
    expect(r.view().tour.ended).toBe("finished");
  });
});

describe("a step's entered value", () => {
  for (const [label, to] of [
    ["a longer", 30],
    ["a shorter", 20],
  ] as const) {
    it(`holds while the distance equals the value at entry and passes on ${label} one`, () => {
      const w = { distance: 25 };
      const r = rig([
        { target: null, caption: () => "Before" },
        {
          target: null,
          caption: () => "Change 25 to 30",
          enter: () => w.distance,
          done: (_c, entered) => w.distance !== entered,
        },
        { target: null, caption: () => "After" },
      ]);
      r.runner.start(r.tour);
      r.session.next();
      for (let i = 0; i < 3; i++) r.frame();
      expect(r.view().step?.caption).toBe("Change 25 to 30");
      w.distance = to;
      r.frame();
      expect(r.view().step?.caption).toBe("After");
    });
  }
});

describe("a step's target and hint", () => {
  it("picks a target from the context as the step is shown", () => {
    const r = rig([
      { target: null, caption: () => "One" },
      { target: (c) => ui(`feature:f${c.features()}`), caption: () => "Two" },
    ]);
    r.runner.start(r.tour);
    r.session.next();
    expect(r.view().step?.target).toEqual(ui("feature:f0"));
  });

  it("shows the hint once the step has been up for a while without passing, and drops it when it has none", () => {
    const w = { hint: "The L is not closed yet, click its first corner again." as string | null };
    const r = rig([
      { target: null, caption: () => "Draw the L", hint: () => w.hint, done: () => false },
      { target: null, caption: () => "Done" },
    ]);
    r.runner.start(r.tour);
    r.frame(HINT_MS - 1);
    expect(r.view().step?.hint).toBeUndefined();
    r.frame(1);
    expect(r.view().step?.hint).toBe(w.hint);
    w.hint = null;
    r.frame();
    expect(r.view().step?.hint).toBeUndefined();
  });
});

describe("beside an assistant's guide", () => {
  const steps = (): TourStep[] => [
    { target: null, caption: () => "One" },
    { target: null, caption: () => "Two" },
  ];

  it("refuses to start while the assistant's guide is up, with the toast, and shows nothing", () => {
    const r = rig(steps());
    r.assistant.apply([{ kind: "highlight", seq: 1, target: ui("#a"), caption: "Theirs" }]);
    expect(r.runner.start(r.tour)).toBe(false);
    expect(r.view()).toEqual({
      tour: { id: null, step: 0, of: 0, ended: null },
      step: null,
      wait: null,
      toasts: [REFUSED],
    });
  });

  it("ends assistant when an assistant's step arrives, and leaves that step alone", () => {
    const r = rig(steps());
    r.runner.start(r.tour);
    r.assistant.apply([{ kind: "highlight", seq: 7, target: ui("#a"), caption: "Theirs" }]);
    expect(r.view()).toEqual({
      tour: { id: "fake", step: 1, of: 2, ended: "assistant" },
      step: null,
      wait: null,
      toasts: [ASSISTANT],
    });
    expect([r.assistant.state.step?.caption, r.assistant.state.step?.seq, r.assistant.active]).toEqual([
      "Theirs",
      7,
      true,
    ]);
  });

  it("keeps going when the assistant's state changes with no step on screen", () => {
    const r = rig(steps());
    r.runner.start(r.tour);
    r.assistant.apply([{ kind: "wait", seq: 1, until: "tool" }]);
    r.assistant.stop();
    r.assistant.reset();
    r.frame();
    expect([r.view().tour, r.view().step?.caption, r.toasts]).toEqual([
      { id: "fake", step: 1, of: 2, ended: null },
      "One",
      [],
    ]);
  });

  it("is left alone when the live session stops and resets the assistant's guide", async () => {
    const r = rig(steps());
    const geometry = {
      session: async () => ({ ok: true, guests: [], proposals: [] }),
      rebuild: async () => ({ ok: true, result: { bodies: [], errors: [] } }),
      init: async () => {},
      onStatus: () => () => {},
      connected: true,
    } as unknown as GeometryBackend;
    const live = new LiveSessionHost(new DocumentStore(geometry, EMPTY_DOCUMENT), geometry, () => true);
    live.attachGuide(r.assistant);
    live.start();
    r.runner.start(r.tour);
    r.assistant.apply([{ kind: "wait", seq: 4, until: "tool" }]);
    await live.stop();
    expect(r.assistant.state).toEqual({ ack: 0, step: null, wait: null, stopped: null });
    expect([r.view().tour, r.view().step?.caption, r.view().wait?.done]).toEqual([
      { id: "fake", step: 1, of: 2, ended: null },
      "One",
      null,
    ]);
  });
});

describe("another document", () => {
  it("opening mid tour ends it opened with the toast", () => {
    const r = rig([
      { target: null, caption: () => "One" },
      { target: null, caption: () => "Two" },
    ]);
    r.runner.start(r.tour);
    r.open();
    expect(r.view()).toEqual({
      tour: { id: "fake", step: 1, of: 2, ended: "opened" },
      step: null,
      wait: null,
      toasts: [OPENED],
    });
  });

  it("the tour's own new document, opened before start, does not end it", () => {
    const r = rig([
      { target: null, caption: () => "One" },
      { target: null, caption: () => "Two" },
    ]);
    r.open();
    r.runner.start(r.tour);
    expect([r.view().tour, r.view().step?.caption, r.toasts]).toEqual([
      { id: "fake", step: 1, of: 2, ended: null },
      "One",
      [],
    ]);
  });
});

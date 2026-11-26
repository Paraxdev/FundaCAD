// Starting the guided bracket: the discard question, a fresh document named for it, Home closed, the tour on step 1.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ pick: "cancel" as string, asked: [] as string[] }));
vi.mock("../../src/ui/choice", () => ({
  choose: async (question: string) => (h.asked.push(question), h.pick),
}));

import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { startFirstBracket, type TourEngine } from "../../src/app/tourActions";
import { DocumentStore, EMPTY_DOCUMENT } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";
import { GuideSession } from "../../src/ui/guide/guideSession";
import { emptySnapshot } from "../../src/ui/guide/wait";
import type { TourContext } from "../../src/ui/tour/context";
import { firstBracketSteps } from "../../src/ui/tour/firstBracket";
import { TourRunner } from "../../src/ui/tour/tourRunner";

const OPENED = "The guided bracket stopped because another document opened.";
const REFUSED = "An assistant's guide is running. Stop it first, then start the guided bracket.";

const geometry = {
  rebuild: async () => ({ ok: true, result: { bodies: [], errors: [] } }),
  init: async () => {},
  onStatus: () => () => {},
  connected: true,
} as unknown as GeometryBackend;

function rig(unsaved: boolean) {
  const store = new DocumentStore(geometry, EMPTY_DOCUMENT);
  const world = { planePick: false };
  const ctx = {
    planePick: () => world.planePick,
    sketchOpen: () => false,
    tool: () => null,
    entities: () => 0,
    regions: () => 0,
    features: () => 0,
    latest: () => null,
    bodies: () => 0,
    building: () => false,
    exportOpen: () => false,
  } satisfies TourContext;
  const session = new GuideSession(() => ({ found: true }), emptySnapshot);
  const guide = new GuideSession(() => ({ found: true }), emptySnapshot);
  const toasts: string[] = [];
  const tour = new TourRunner(session, ctx, guide, (m) => toasts.push(m));
  store.onOpen(() => tour.documentOpened());
  const resetCamera = vi.fn();
  const e = {
    store,
    sketch: { hasUncommittedEdits: unsaved },
    viewport: { resetCamera },
    guide,
    tour,
  } as unknown as TourEngine;
  const home = new Home({} as HomeCallbacks);
  home.open();
  return { e, store, tour, session, guide, toasts, resetCamera, world };
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.pick = "cancel";
  h.asked = [];
});

describe("starting the guided bracket", () => {
  it("starts nothing when the maker keeps unsaved work", async () => {
    const r = rig(true);
    const fresh = vi.spyOn(r.store, "newDocument");
    expect(await startFirstBracket(r.e)).toBe(false);
    expect(h.asked).toEqual(["Discard unsaved changes and start a new document?"]);
    expect([fresh.mock.calls.length, r.tour.running, homeIsOpen(), r.store.fileName, r.toasts]).toEqual([
      0,
      false,
      true,
      "Untitled",
      [],
    ]);
  });

  it.each([
    ["nothing is unsaved", false, []],
    ["the maker discards unsaved work", true, ["Discard unsaved changes and start a new document?"]],
  ] as const)("opens a fresh document named Bracket and shows step 1 when %s", async (_why, unsaved, asked) => {
    h.pick = "discard";
    const r = rig(unsaved);
    expect(await startFirstBracket(r.e)).toBe(true);
    await flushPromises();
    expect(h.asked).toEqual(asked);
    expect(r.store.fileName).toBe("Bracket");
    expect(r.store.filePath).toBeNull();
    expect(r.store.dirty).toBe(false);
    expect(r.resetCamera).toHaveBeenCalledWith(false);
    expect(homeIsOpen()).toBe(false);
    expect(r.tour.running).toBe(true);
    expect(r.tour.state).toMatchObject({ id: "first-bracket", step: 1, of: 14, ended: null });
    expect(r.session.state.step?.caption).toBe(firstBracketSteps[0]!.caption());
    expect(r.toasts).toEqual([]);
  });

  it("is still ended by a document opened later", async () => {
    const r = rig(false);
    await startFirstBracket(r.e);
    await flushPromises();
    r.store.newDocument();
    expect([r.tour.running, r.toasts]).toEqual([false, [OPENED]]);
  });

  it("starts over on step 1 while it runs, without the toast about another document", async () => {
    const r = rig(false);
    await startFirstBracket(r.e);
    r.world.planePick = true;
    r.session.observe();
    expect(r.tour.state.step).toBe(2);
    r.world.planePick = false;
    expect(await startFirstBracket(r.e)).toBe(true);
    await flushPromises();
    expect([r.tour.running, r.tour.state.step, r.toasts]).toEqual([true, 1, []]);
  });

  it("is refused while an assistant's guide is up, before anything is asked or given up", async () => {
    const r = rig(true);
    r.guide.apply([{ kind: "highlight", seq: 1, target: { ui: "#a" }, caption: "Theirs" }]);
    const fresh = vi.spyOn(r.store, "newDocument");
    expect(await startFirstBracket(r.e)).toBe(false);
    expect([h.asked, fresh.mock.calls.length, r.tour.running, homeIsOpen(), r.toasts]).toEqual([
      [],
      0,
      false,
      true,
      [REFUSED],
    ]);
  });
});

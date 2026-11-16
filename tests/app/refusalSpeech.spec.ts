// A refusal is spoken under the selection readout's key, so putting it away must leave the readout's own words.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { announce, attachAnnouncer, recentAnnouncements } from "../../src/ui/announce";
import { SELECTION_SPEECH_DELAY, dropRefusals, refuseAloud } from "../../src/app/planePick";
import type { Engine } from "../../src/app/engine";

const REFUSAL = "That row is an edge, this step needs a face";
const host = { setStatus: () => {} } as unknown as Pick<Engine, "setStatus">;
let detach: () => void;
let before: number;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  before = recentAnnouncements().length;
  detach = attachAnnouncer({ polite: { textContent: "" }, assertive: { textContent: "" } });
});
afterEach(() => {
  detach();
  vi.useRealTimers();
});

const spokenAfterDelay = () => {
  vi.advanceTimersByTime(SELECTION_SPEECH_DELAY + 200);
  return recentAnnouncements()
    .slice(before)
    .map((a) => a.text);
};

describe("dropRefusals", () => {
  it("drops the spoken refusal still inside its delay", () => {
    refuseAloud(host, REFUSAL);
    dropRefusals();
    expect(spokenAfterDelay()).toEqual([]);
  });

  it("drops the spoken refusal that is past its delay and still waiting for a frame", () => {
    refuseAloud(host, REFUSAL);
    vi.advanceTimersByTime(SELECTION_SPEECH_DELAY);
    dropRefusals();
    expect(spokenAfterDelay()).toEqual([]);
  });

  it("leaves a selection readout's words waiting under the same key", () => {
    refuseAloud(host, REFUSAL);
    announce("Face 3 of Body1", "polite", { key: "selection", delay: SELECTION_SPEECH_DELAY });
    dropRefusals();
    expect(spokenAfterDelay()).toEqual(["Face 3 of Body1"]);
  });

  it("speaks a refusal again once a new one is made after the drop", () => {
    refuseAloud(host, REFUSAL);
    dropRefusals();
    refuseAloud(host, REFUSAL);
    expect(spokenAfterDelay()).toEqual([REFUSAL]);
  });
});

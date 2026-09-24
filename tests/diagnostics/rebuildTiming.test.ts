// The three marks only mean anything paired correctly: a receive with nothing
// sent, or a draw with nothing received, must not fabricate a round trip.

import { beforeEach, describe, expect, it } from "vitest";
import {
  lastRoundTripMs, markDrawn, markReceived, markSent, onRoundTrip, recentRoundTrips, resetRebuildTiming,
} from "../../src/diagnostics/rebuildTiming";

beforeEach(() => resetRebuildTiming());

describe("rebuildTiming", () => {
  it("has nothing to report before a round trip completes", () => {
    expect(lastRoundTripMs()).toBeNull();
    expect(recentRoundTrips()).toEqual([]);
  });

  it("records sent -> received -> drawn as one round trip", () => {
    markSent();
    markReceived();
    markDrawn();
    const trips = recentRoundTrips();
    expect(trips.length).toBe(1);
    expect(trips[0]!.drawnAt).toBeGreaterThanOrEqual(trips[0]!.receivedAt);
    expect(trips[0]!.receivedAt).toBeGreaterThanOrEqual(trips[0]!.sentAt);
    expect(lastRoundTripMs()).toBeGreaterThanOrEqual(0);
  });

  it("ignores a draw with no open request, an ordinary re-paint isn't a round trip", () => {
    markDrawn(); // nothing sent
    expect(recentRoundTrips().length).toBe(0);

    markSent();
    markReceived();
    markDrawn();
    markDrawn(); // a second listener firing for the same settled build
    expect(recentRoundTrips().length).toBe(1);
  });

  it("ignores a receive with no open request", () => {
    markReceived(); // nothing sent
    markDrawn();
    expect(recentRoundTrips().length).toBe(0);
  });

  it("evicts past the ring size, keeping the most recent", () => {
    for (let i = 0; i < 20; i++) {
      markSent();
      markReceived();
      markDrawn();
    }
    expect(recentRoundTrips().length).toBeLessThanOrEqual(8);
  });

  it("notifies a subscriber on each completed trip, and stops after unsubscribing", () => {
    const seen: number[] = [];
    const unsub = onRoundTrip((rt) => seen.push(rt.drawnAt));
    markSent();
    markReceived();
    markDrawn();
    expect(seen.length).toBe(1);
    unsub();
    markSent();
    markReceived();
    markDrawn();
    expect(seen.length).toBe(1);
  });
});

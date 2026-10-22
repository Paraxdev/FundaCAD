// Wall-clock cost of one rebuild round trip (sent, received, drawn), marked from store.ts and the viewport's onBuild.

export interface RoundTrip {
  sentAt: number;
  receivedAt: number;
  drawnAt: number;
}

const RING_MAX = 8;
const ring: RoundTrip[] = [];
// rebuildNow awaits each reply before the next send, so one open record suffices. A draw with nothing open is a
// re-paint, not a round trip, and is ignored.
let sentAt: number | null = null;
let receivedAt: number | null = null;

type Listener = (rt: RoundTrip) => void;
const listeners = new Set<Listener>();

export function markSent(): void {
  sentAt = performance.now();
  receivedAt = null;
}

export function markReceived(): void {
  if (sentAt == null) return; // no open request to pair this with
  receivedAt = performance.now();
}

// Drawn is the moment the user actually sees the rebuild finish.
export function markDrawn(): void {
  if (sentAt == null || receivedAt == null) return;
  const rt: RoundTrip = { sentAt, receivedAt, drawnAt: performance.now() };
  ring.push(rt);
  if (ring.length > RING_MAX) ring.shift();
  sentAt = null;
  receivedAt = null;
  for (const fn of listeners) fn(rt);
}

// No replay of past trips: a UI readout wants only what happens from here.
export function onRoundTrip(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recentRoundTrips(): readonly RoundTrip[] {
  return ring;
}

export function lastRoundTripMs(): number | null {
  const last = ring[ring.length - 1];
  return last ? last.drawnAt - last.sentAt : null;
}

// Tests only: module state with no other way back to a clean slate.
export function resetRebuildTiming(): void {
  ring.length = 0;
  sentAt = null;
  receivedAt = null;
}

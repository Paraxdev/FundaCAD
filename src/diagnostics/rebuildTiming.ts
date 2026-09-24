// Wall-clock cost of one rebuild round trip: the request sent, its reply
// received, and the meshes actually drawn on screen. "Fillet dragging feels
// slow" was a claim nobody could measure from inside the app before this, only
// guess at with a stopwatch held up to the monitor.
//
// Three marks, not a wrapper object threaded through three files: the moments
// live in different places (store.ts sends and receives the wire request,
// the viewport's onBuild handler is what actually applies the reply to the
// scene), so this is plain module state, marked from each of them, the same
// shape as pipelineLog.ts's rolling ring.
//
// A rebuild is strictly sequential here (store.ts's rebuildNow awaits one
// reply before sending the next), so there is never more than one open
// request to pair a receive/draw against: a single "current" record is enough,
// no id needs threading through RebuildState for onBuild's other listeners to
// carry. A draw mark with nothing open (markSent never called, or already
// closed by an earlier draw) is a plain re-paint of the existing model, not a
// new round trip, and is silently ignored rather than logged as a ~0ms trip.

export interface RoundTrip {
  sentAt: number;
  receivedAt: number;
  drawnAt: number;
}

const RING_MAX = 8;
const ring: RoundTrip[] = [];
let sentAt: number | null = null;
let receivedAt: number | null = null;

type Listener = (rt: RoundTrip) => void;
const listeners = new Set<Listener>();

/** A rebuild request just went out. */
export function markSent(): void {
  sentAt = performance.now();
  receivedAt = null;
}

/** Its reply just landed. */
export function markReceived(): void {
  if (sentAt == null) return; // no open request to pair this with
  receivedAt = performance.now();
}

/** The viewport just applied that reply to the scene, the moment the user
 *  actually sees it finish. */
export function markDrawn(): void {
  if (sentAt == null || receivedAt == null) return;
  const rt: RoundTrip = { sentAt, receivedAt, drawnAt: performance.now() };
  ring.push(rt);
  if (ring.length > RING_MAX) ring.shift();
  sentAt = null;
  receivedAt = null;
  for (const fn of listeners) fn(rt);
}

/** Called on every completed round trip, immediately with nothing to catch up
 *  on: a UI readout wants only what happens FROM here, not a backlog. */
export function onRoundTrip(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The last few round trips, oldest first. */
export function recentRoundTrips(): readonly RoundTrip[] {
  return ring;
}

/** Total sent-to-drawn time of the last completed round trip, or null before
 *  one has happened this session. */
export function lastRoundTripMs(): number | null {
  const last = ring[ring.length - 1];
  return last ? last.drawnAt - last.sentAt : null;
}

/** Tests only, the same reason resetPipelineLog exists: module state with no
 *  other way back to a clean slate. */
export function resetRebuildTiming(): void {
  ring.length = 0;
  sentAt = null;
  receivedAt = null;
}

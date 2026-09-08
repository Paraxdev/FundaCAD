// The render pipeline's own trail: what the geometry engine sent, what the
// stream put on screen, and what the commit did with it.
//
// This exists for one report that would not close: bodies drawing shredded and
// doubled, holes appearing twice, seen often enough to ruin a session and never
// once on demand. Nothing in the app could say what had happened, because every
// stage did its job quietly and the evidence was a screenshot.
//
// So the pipeline says what it did, and the bug reporter carries it. Two rings,
// because the two failures need different memories:
//
//   * the ROLLING ring is the recent story, every begin/chunk/commit, deep
//     enough to cover a rebuild or two and no deeper. It answers "what led to
//     this".
//   * FAULTS are kept for the life of the session and never evicted. A rebuild
//     is a few of these lines and a slider drag is dozens, so anything rolling
//     is gone within seconds of the thing the user actually noticed. The
//     corruption stays on screen until the next rebuild, though, which is
//     exactly the gap between it happening and somebody deciding to report it.
//     A fault that scrolled away is a fault nobody can act on.
//
// Text, not structured records, for the same reason breadcrumbs are text: this
// is read by a person in a pasted issue.

const ROLL_MAX = 120;
const FAULT_MAX = 40;

const roll: string[] = [];
const faults: string[] = [];
let sinceFault = 0;

/** Wall-clock to the millisecond. A rebuild's stages are milliseconds apart and
 *  the ORDER of two lines in the same second is usually the whole question. */
function stamp(): string {
  const d = new Date();
  return `${d.toISOString().slice(11, 19)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** One ordinary pipeline event. Cheap by construction: callers pass a finished
 *  string, so a disabled reader costs an array push and nothing else. */
export function pipe(message: string): void {
  roll.push(`${stamp()} ${message}`.slice(0, 300));
  if (roll.length > ROLL_MAX) roll.shift();
  sinceFault++;
}

/** A broken invariant. Kept for the session, and also pushed into the rolling
 *  ring so its neighbours read in order there.
 *
 *  `sinceFault` is recorded with it because "the fault fired 400 events ago"
 *  and "it fired on the last build" are different bugs, and by the time the
 *  report is written the rolling ring cannot tell them apart. */
export function pipeFault(message: string): void {
  const line = `${stamp()} FAULT ${message}`.slice(0, 300);
  if (faults.length < FAULT_MAX) faults.push(line);
  else if (faults.length === FAULT_MAX) faults.push("... further faults not recorded");
  roll.push(line);
  if (roll.length > ROLL_MAX) roll.shift();
  sinceFault = 0;
}

/** True once anything has gone wrong this session. The bug reporter leads with
 *  this, so a report about something else still says the pipeline is unhappy. */
export function hasFaults(): boolean {
  return faults.length > 0;
}

/** The whole trail, faults first so they survive any cap applied downstream. */
export function pipelineLog(): string[] {
  const out: string[] = [];
  if (faults.length) {
    out.push(`[pipeline] ${faults.length} FAULT(S) this session, ${sinceFault} events since the last`);
    out.push(...faults);
  } else {
    out.push("[pipeline] no faults detected this session");
  }
  out.push(`[pipeline] last ${roll.length} events:`);
  out.push(...roll);
  return out;
}

/** Tests only. The rings are module state on purpose (every producer is deep in
 *  a render path that has no business being handed a logger), which makes this
 *  the one way to get a clean slate. */
export function resetPipelineLog(): void {
  roll.length = 0;
  faults.length = 0;
  sinceFault = 0;
}

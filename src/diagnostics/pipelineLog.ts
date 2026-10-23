// The render pipeline's trail for the bug reporter: what the engine sent, what the stream drew, what the commit did.

// Faults are kept all session: the corruption stays on screen until the next rebuild, while a slider drag
// scrolls dozens of rolling lines away in seconds.
const ROLL_MAX = 120;
const FAULT_MAX = 40;

const roll: string[] = [];
const faults: string[] = [];
let sinceFault = 0;

// Millisecond stamps: a rebuild's stages are ms apart and the order within one second is usually the question.
function stamp(): string {
  const d = new Date();
  return `${d.toISOString().slice(11, 19)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function pipe(message: string): void {
  roll.push(`${stamp()} ${message}`.slice(0, 300));
  if (roll.length > ROLL_MAX) roll.shift();
  sinceFault++;
}

// `sinceFault` is kept because "fired 400 events ago" and "fired on the last build" are different bugs.
export function pipeFault(message: string): void {
  const line = `${stamp()} FAULT ${message}`.slice(0, 300);
  if (faults.length < FAULT_MAX) faults.push(line);
  else if (faults.length === FAULT_MAX) faults.push("... further faults not recorded");
  roll.push(line);
  if (roll.length > ROLL_MAX) roll.shift();
  sinceFault = 0;
}

export function hasFaults(): boolean {
  return faults.length > 0;
}

// Faults first so they survive any cap applied downstream.
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

// Tests only: the rings are module state on purpose, so this is the one way to a clean slate.
export function resetPipelineLog(): void {
  roll.length = 0;
  faults.length = 0;
  sinceFault = 0;
}

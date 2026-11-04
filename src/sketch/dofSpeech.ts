// Decides when a change in sketch freedom is worth saying: never on entry, once per change, a conflict at once.

export interface DofLine {
  text: string;
  priority: "polite" | "assertive";
}

export class DofSpeech {
  private last: string | null = null;

  /** `ready` is false until the first solve after entry has settled, that summary becomes the silent baseline. */
  next(summary: string, conflict: boolean, ready: boolean): DofLine | null {
    if (!ready) return null;
    const was = this.last;
    this.last = summary;
    if (was === null || was === summary) return null;
    return { text: summary, priority: conflict ? "assertive" : "polite" };
  }

  reset() {
    this.last = null;
  }
}

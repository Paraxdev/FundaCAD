// A mailbox swap chain with room for one frame: the tracer puts finished frames here, each display refresh
// shows the newest, an older one nobody saw is dropped. So nothing queues and no refresh waits for a frame.

export class PresentSlot<T> {
  private waiting: T | null = null;
  private asked: number | null = null;
  private disposed = false;

  constructor(
    private show: (frame: T) => void,
    private raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
    private caf: (handle: number) => void = (h) => cancelAnimationFrame(h),
  ) {}

  put(frame: T) {
    if (this.disposed) return;
    this.waiting = frame;
    this.asked ??= this.raf(() => {
      this.asked = null;
      this.flush();
    });
  }

  flush() {
    const f = this.waiting;
    if (f === null) return;
    this.waiting = null;
    this.show(f);
  }

  dispose() {
    this.disposed = true;
    this.waiting = null;
    if (this.asked !== null) this.caf(this.asked);
    this.asked = null;
  }
}

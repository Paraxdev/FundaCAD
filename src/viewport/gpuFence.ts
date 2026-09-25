// Whether the GPU has finished the frames already sent, asked without waiting.
//
// Resizing the canvas makes the browser read a GL error back, which blocks the
// main thread until every queued command has run: a third of a second under
// SwiftShader with a frame or two in flight, a few milliseconds with none. So a
// resize waits for this to say the queue is empty.

export class GpuFence {
  private sync: WebGLSync | null = null;

  constructor(private readonly gl: WebGL2RenderingContext | null) {}

  /** Mark the end of the commands sent so far. */
  mark(): void {
    const gl = this.gl;
    if (!gl || typeof gl.fenceSync !== "function") return;
    if (this.sync) gl.deleteSync(this.sync);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }

  /** True once everything marked has finished. Note: WebGL only updates a
   *  sync's status between tasks, so this never blocks. */
  idle(): boolean {
    const gl = this.gl;
    const s = this.sync;
    if (!gl || !s) return true;
    if (gl.getSyncParameter(s, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
    gl.deleteSync(s);
    this.sync = null;
    return true;
  }
}

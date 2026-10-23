import * as THREE from "three";

type ProgramOf = { properties: { get(m: THREE.Material): { currentProgram?: { isReady(): boolean } } } };

/** Compiles `obj` in `scene`'s lights once for the canvas and once for an offscreen target, since three keys a
 *  program on the output colour space (canvas srgb, post chain buffer linear). Resolves when every program is
 *  linked. Polled directly, compileAsync checks the current program, which the next frame switches back. */
export function linkProgramsAhead(
  r: THREE.WebGLRenderer,
  obj: THREE.Object3D,
  camera: THREE.Camera,
  scene: THREE.Scene,
  offscreen: THREE.WebGLRenderTarget,
  what: string,
): Promise<void> {
  const props = (r as unknown as ProgramOf).properties;
  const programs: { isReady(): boolean }[] = [];
  const before = r.getRenderTarget();
  try {
    for (const target of [null, offscreen]) {
      r.setRenderTarget(target);
      for (const m of r.compile(obj, camera, scene)) {
        const p = props.get(m).currentProgram;
        if (p) programs.push(p);
      }
    }
  } catch (e) {
    console.warn(`[viewport] ${what} programs could not be linked ahead:`, e);
  } finally {
    r.setRenderTarget(before);
  }
  return new Promise((resolve) => {
    const poll = () => (programs.every((p) => p.isReady()) ? resolve() : setTimeout(poll, 16));
    poll();
  });
}

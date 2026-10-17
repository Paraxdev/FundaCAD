// What a saved picture draws: the model and what lights it, nothing that is there
// to work with. An allowlist, because tools and analyses add their handles and
// markers straight to the scene, and a list of what to leave out would miss the
// next one.

import * as THREE from "three";

const KEEP = "inPicture";
const DROP = "notInPicture";

/** A top level scene object a picture draws: section caps, the emitter lights,
 *  a stress result standing in for its body. */
export function markInPicture<T extends THREE.Object3D>(o: T): T {
  o.userData[KEEP] = true;
  return o;
}

/** Something under the model group a picture leaves out: a selection glow, a
 *  hovered face, curvature combs. */
export function markNotInPicture<T extends THREE.Object3D>(o: T): T {
  o.userData[DROP] = true;
  return o;
}

function keepsTopLevel(o: THREE.Object3D, model: THREE.Object3D): boolean {
  return o === model || (o as THREE.Light).isLight === true || o.userData[KEEP] === true;
}

/** Hide everything in `scene` a picture must not show and return what puts each
 *  flag back as it was. */
export function hideForPicture(scene: THREE.Scene, model: THREE.Object3D): () => void {
  const hidden: THREE.Object3D[] = [];
  const hide = (o: THREE.Object3D) => {
    if (!o.visible) return;
    o.visible = false;
    hidden.push(o);
  };
  for (const o of scene.children) if (!keepsTopLevel(o, model)) hide(o);
  model.traverse((o) => { if (o.userData[DROP] === true) hide(o); });
  return () => {
    for (const o of hidden) o.visible = true;
    hidden.length = 0;
  };
}


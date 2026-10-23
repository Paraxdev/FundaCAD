// The tracer takes three's physical fields as they are, so a finish reaches it by copying them. Raster only
// parts are left behind, and the procedural shader is baked by surfaceBake.ts.

import * as THREE from "three";

type Physical = Partial<THREE.MeshPhysicalMaterial>;

export function traceMaterialFrom(
  src: THREE.Material,
  vertexColors: boolean,
  m = new THREE.MeshPhysicalMaterial(),
): THREE.MeshPhysicalMaterial {
  const s = src as Physical;
  m.vertexColors = vertexColors;
  m.color.copy(s.color ?? WHITE);
  m.emissive.copy(s.emissive ?? BLACK);
  m.emissiveIntensity = s.emissiveIntensity ?? 1;
  m.metalness = s.metalness ?? 0;
  m.roughness = s.roughness ?? 0.5;
  m.transmission = s.transmission ?? 0;
  m.ior = s.ior ?? 1.5;
  // The tracer reads thickness only to tell a solid (refracts on entry and on
  // exit, absorbs inside) from a sheet; a raster thickness of 0 still means solid.
  m.thickness = m.transmission > 0 ? 1 : 0;
  m.attenuationColor.copy(s.attenuationColor ?? WHITE);
  m.attenuationDistance = s.attenuationDistance && s.attenuationDistance > 0 ? s.attenuationDistance : Infinity;
  m.dispersion = s.dispersion ?? 0;
  m.iridescence = s.iridescence ?? 0;
  m.iridescenceIOR = s.iridescenceIOR ?? 1.3;
  m.iridescenceThicknessRange = [...(s.iridescenceThicknessRange ?? [100, 400])];
  m.specularColor.copy(s.specularColor ?? WHITE);
  m.specularIntensity = s.specularIntensity ?? 1;
  m.sheen = s.sheen ?? 0;
  m.sheenColor.copy(s.sheenColor ?? BLACK);
  m.sheenRoughness = s.sheenRoughness ?? 1;
  m.clearcoat = s.clearcoat ?? 0;
  m.clearcoatRoughness = s.clearcoatRoughness ?? 0;
  m.opacity = src.opacity;
  m.transparent = src.transparent;
  m.side = src.side;
  if (src.userData.noLight === true) m.userData.noLight = true;
  else delete m.userData.noLight;
  return m;
}

const WHITE = new THREE.Color(1, 1, 1);
const BLACK = new THREE.Color(0, 0, 0);

/** Every field traceMaterialFrom reads, so any edit to one reaches the tracer. Not `version`: three's transmission
 *  pass bumps it twice on every Realtime frame of a double sided glass. */
export function traceMaterialKey(m: THREE.Material): string {
  const s = m as Physical;
  return [
    m.uuid,
    s.color?.getHex(),
    s.emissive?.getHex(),
    s.emissiveIntensity,
    s.metalness,
    s.roughness,
    s.transmission,
    s.ior,
    s.attenuationColor?.getHex(),
    s.attenuationDistance,
    s.dispersion,
    s.iridescence,
    s.iridescenceIOR,
    s.iridescenceThicknessRange?.join("/"),
    s.specularColor?.getHex(),
    s.specularIntensity,
    s.sheen,
    s.sheenColor?.getHex(),
    s.sheenRoughness,
    s.clearcoat,
    s.clearcoatRoughness,
    m.opacity,
    m.transparent,
    m.side,
    m.userData.surfKey ?? "",
    m.userData.noLight === true,
  ].join(".");
}

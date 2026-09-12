// Shadows for rectangle lights.
//
// three.js draws a RectAreaLight (the soft, shaped light a glowing panel gives
// off) but has no shadows for it, so a lit face would light straight through
// the part in front of it. What three DOES shadow is a point light, and it
// renders a point light's shadow map whatever the light's brightness. So each
// shadowed area light is paired with a point light of intensity zero at the
// patch's centre: it adds no light, only its shadow map, and the area light
// loop below reads that map for its own light.
//
// The pairing is by index, and it holds because of how three orders lights:
// shadow casting lights sort first (WebGLLights, a stable sort), the companion
// point lights are the only point lights in the scene, and the viewport adds
// the shadowed area lights first and their companions in the same order. So
// area light i and point shadow i are one emitter for every i below
// NUM_POINT_LIGHT_SHADOWS, and area lights past that are unshadowed.
//
// The shadow is cast from the patch's centre, so it is the shadow of a small
// light softened by the shadow map's filter, not a true penumbra from the whole
// rectangle. That is the rasterised trade: the light's SHAPE is exact, its
// occlusion is approximate.

import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";

/** The stock rectangle light loop, matched loosely on whitespace: the built
 *  three.js strips the blank lines its source has. */
const STOCK = /#pragma unroll_loop_start\s*for \( int i = 0; i < NUM_RECT_AREA_LIGHTS; i \+\+ \) \{\s*rectAreaLight = rectAreaLights\[ i \];\s*RE_Direct_RectArea\( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);\s*\}\s*#pragma unroll_loop_end/;

// The body is wrapped in its own braces: three unrolls this loop into one copy
// per light, and the locals would otherwise be declared once per copy in the
// same scope.
const SHADOWED = `#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
		{
		rectAreaLight = rectAreaLights[ i ];
		vec3 fcDiffuseBefore = reflectedLight.directDiffuse;
		vec3 fcSpecularBefore = reflectedLight.directSpecular;
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS )
		PointLightShadow fcShadow = pointLightShadows[ i ];
		float fcLit = receiveShadow ? getPointShadow( pointShadowMap[ i ], fcShadow.shadowMapSize, fcShadow.shadowIntensity, fcShadow.shadowBias, fcShadow.shadowRadius, vPointShadowCoord[ i ], fcShadow.shadowCameraNear, fcShadow.shadowCameraFar ) : 1.0;
		reflectedLight.directDiffuse = fcDiffuseBefore + ( reflectedLight.directDiffuse - fcDiffuseBefore ) * fcLit;
		reflectedLight.directSpecular = fcSpecularBefore + ( reflectedLight.directSpecular - fcSpecularBefore ) * fcLit;
		#endif
		}
	}
	#pragma unroll_loop_end`;

let installed: boolean | null = null;

/** Patch the shader chunk and load the rectangle light lookup tables, once,
 *  before any material compiles against a rectangle light. Returns whether the
 *  shadow patch is in: false means this three.js has a different chunk, and the
 *  area lights still light, only unshadowed. */
export function installAreaLights(): boolean {
  if (installed !== null) return installed;
  RectAreaLightUniformsLib.init();
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  installed = STOCK.test(chunk);
  if (installed) THREE.ShaderChunk.lights_fragment_begin = chunk.replace(STOCK, SHADOWED);
  else console.warn("area light shadows: lights_fragment_begin changed in this three.js, emitter shadows are off");
  return installed;
}

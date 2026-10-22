// Shadows for RectAreaLight, which three.js lights but never shadows. three renders a point light's shadow map at any
// brightness, so each area light pairs with a zero intensity point light at its centre whose map the loop below reads.

import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";

/** Matched loosely on whitespace: the built three.js strips the blank lines its source has. */
const STOCK =
  /#pragma unroll_loop_start\s*for \( int i = 0; i < NUM_RECT_AREA_LIGHTS; i \+\+ \) \{\s*rectAreaLight = rectAreaLights\[ i \];\s*RE_Direct_RectArea\( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);\s*\}\s*#pragma unroll_loop_end/;

// Area light i pairs with point shadow i: shadow casters sort first in WebGLLights, and the companions are the only
// point lights, added in the area lights' order. Area lights past NUM_POINT_LIGHT_SHADOWS are unshadowed.
// The shadow is cast from the patch centre and softened by the map filter, not a true penumbra of the rectangle.
// The inner braces scope each unrolled copy's locals.
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

/** Call before any material compiles against a rectangle light. False means this three.js has another chunk, so
 *  area lights still light but cast no shadow. */
export function installAreaLights(): boolean {
  if (installed !== null) return installed;
  RectAreaLightUniformsLib.init();
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  installed = STOCK.test(chunk);
  if (installed) THREE.ShaderChunk.lights_fragment_begin = chunk.replace(STOCK, SHADOWED);
  else console.warn("area light shadows: lights_fragment_begin changed in this three.js, emitter shadows are off");
  return installed;
}

// Global replacement of three.js fog with exponential *height* fog and a blue aerial perspective.
// Uses the THREE.Fog uniforms that world/sky.js sets every frame: fogNear = density at sea level,
// fogFar = height falloff (1/m), fogColor = the haze colour (the sky near the horizon).
//  - optical depth of an exponential atmosphere, integrated analytically along the view ray: thick air in the
//    valleys, crisp air on the peaks and near the camera
//  - valley haze: a shallow layer pooling below the viewer, so looking down into a valley goes hazy while the
//    peaks above stay sharp
//  - aerial perspective: light from distant terrain is filtered toward the haze hue before the haze is added, so
//    far rock, trees and snow turn blue (warm at dusk) instead of fading to grey
import * as THREE from 'three';

// haze strength of the distant ranges relative to the physical height fog (world/backdrop.js uses the same)
export const BACKDROP_HAZE = 0.4;

export function installHeightFog() {
  THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
    varying float vFogDepth;
    varying vec3 vFogWorldPos;
  #endif`;
  THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vec4 fogWP = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      fogWP = instanceMatrix * fogWP;
    #endif
    vFogWorldPos = (modelMatrix * fogWP).xyz;
  #endif`;
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vFogWorldPos;
    uniform float fogNear;
    uniform float fogFar;
  #endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
    {
      vec3 rd = vFogWorldPos - cameraPosition;
      float dist = length(rd);
      // atmosphere: density(y) = fogNear * exp(-fogFar * y)
      float x = rd.y * fogFar;
      float k = abs(x) > 1e-4 ? (1.0 - exp(-x)) / x : 1.0;
      float amount = fogNear * exp(-max(cameraPosition.y, 0.0) * fogFar) * dist * k;
      // valley haze: scale height 380 m below the viewer (capped so deep views stay readable)
      float xv = rd.y * (1.0 / 380.0);
      float kv = abs(xv) > 1e-4 ? (1.0 - exp(-xv)) / xv : 1.0;
      amount += fogNear * 0.3 * dist * min(kv, 7.0);
      float fogFactor = clamp(1.0 - exp(-amount), 0.0, 1.0);
      // far field (beyond ~6 km): converge on the haze the painted distant ranges (world/backdrop.js) get at
      // the same distance, so the real terrain's horizon and the ranges standing behind it sit in the same air
      // (the real horizon used to be far hazier than the peaks behind it: an obvious border between them)
      float farK = smoothstep(6000.0, 14000.0, dist);
      if (farK > 0.0) {
        float hb = 1.0 - exp(-fogNear * exp(-max(cameraPosition.y, 0.0) * fogFar) * (7000.0 + dist * 1.05) * k * ${BACKDROP_HAZE.toFixed(3)});
        fogFactor = mix(fogFactor, hb, farK);
      }
      // aerial perspective: transmitted light takes on some of the haze hue (normalised fog colour) as it fades
      vec3 hazeHue = mix(vec3(1.0), fogColor / max(max(fogColor.r, max(fogColor.g, fogColor.b)), 1e-4), 0.6);
      gl_FragColor.rgb = mix(gl_FragColor.rgb * mix(vec3(1.0), hazeHue, fogFactor * 0.45), fogColor, fogFactor);
    }
  #endif`;
  // Sprites have no 'transformed' vertex: their world position comes back from the view-space corner.
  THREE.ShaderLib.sprite.vertexShader = THREE.ShaderLib.sprite.vertexShader.replace('#include <fog_vertex>', `#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vFogWorldPos = (inverse(viewMatrix) * mvPosition).xyz;
  #endif`);
}

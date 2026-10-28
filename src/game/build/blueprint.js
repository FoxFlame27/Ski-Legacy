// Blueprint ghost look for build mode: a blue (or red when it doesn't fit) emissive, transparent,
// wireframe-ish shader. Fresnel rim + a world-space 10 cm grid + a slow scanline, drawn additively,
// plus the model's hard edges as lines.
import * as THREE from 'three';

const BLUE = new THREE.Color(0x3fa9ff);
const RED = new THREE.Color(0xff3b3b);

export function makeBlueprintMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: BLUE.clone() }, uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vView; varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uTime;
      varying vec3 vN; varying vec3 vView; varying vec3 vWorld;
      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vN), vView)), 2.0);
        vec3 g = abs(fract(vWorld * 10.0) - 0.5);
        float grid = smoothstep(0.44, 0.5, max(max(g.x, g.y), g.z));
        float scan = smoothstep(0.0, 0.08, 0.08 - abs(fract(vWorld.y * 0.6 - uTime * 0.5) - 0.5));
        float a = 0.10 + fres * 0.55 + grid * 0.25 + scan * 0.25;
        gl_FragColor = vec4(uColor * (0.6 + fres), a);
      }`,
  });
}

const lineMat = (c) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });

/** Turn a furniture object (from makeFurnitureObject) into a blueprint ghost. Returns { group, setValid(bool), tick(dt) }. */
export function makeGhost(source) {
  const group = source.clone(true);
  const mat = makeBlueprintMaterial();
  const lines = lineMat(BLUE);
  const meshes = [];
  group.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const m of meshes) {
    m.material = mat;
    m.castShadow = m.receiveShadow = false;
    m.renderOrder = 10;
    try {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 35), lines);
      e.renderOrder = 11;
      m.add(e);
    } catch { /* odd geometry: shader only */ }
  }
  group.traverse((o) => { if (o.isLight) o.visible = false; });
  let valid = true;
  return {
    group,
    setValid(v) {
      if (v === valid) return;
      valid = v;
      mat.uniforms.uColor.value.copy(v ? BLUE : RED);
      lines.color.copy(v ? BLUE : RED);
    },
    tick(dt) { mat.uniforms.uTime.value += dt; },
    dispose() {
      mat.dispose(); lines.dispose();
      group.traverse((o) => { if (o.isLineSegments) o.geometry.dispose(); });
    },
  };
}

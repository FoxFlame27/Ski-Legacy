// Ski Legacy native port: the railcars' interior surfaces as the web game shades them.
// train.js cabinPatch gives every surface of the cabin a texture of its own in the shader (onBeforeCompile): the wall
// panels' mottled plastic, the woven seat fabric, the floor's speckled rubber, the ceiling's perforated panels, the
// brushed metal: one small data texture (four channels: grain, perforation, streaks, weave) sampled triplanar in the
// car's frame, tiles per metre by the kind each vertex carries (aTex), multiplied into the surface's colour. A shader
// patch is not something the exporter can capture, so the C++ drew those surfaces flat. Here the same picture is baked:
// each kind becomes a tiling map (the game's own data texture through the game's own mix per kind), the cabin's mesh is
// split by kind and given the triplanar coordinates of each face's main axis, and the meshes take the maps.
// Nothing is invented: the texels, the scales and the mixes are train.js's.

const TILES = [2.5, 7.0, 1.6, 5.5, 3.0];                 // tiles per m by kind (cabinPatch: k)
const DMAX = [1.05, 1.1, 1.12 * 1.03, 1.0 * 1.02, 1.08]; // the brightest factor of each kind (the map holds d / DMAX)
const mix = (a, b, t) => a + (b - a) * t;
// cabinPatch's d per kind from a texel (r, g, b, a in 0..1)
const FACTOR = [
  (t) => mix(0.86, 1.05, t[0]),
  (t) => mix(0.8, 1.1, t[3]),
  (t) => mix(0.78, 1.12, t[0]) * mix(0.94, 1.03, t[3]),
  (t) => mix(0.55, 1.0, t[1]) * mix(0.97, 1.02, t[0]),
  (t) => mix(0.86, 1.08, t[2]),
];
const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

export function bakeCabinDetail(THREE, root, log = () => {}) {
  const maps = new Map(); // detail texture + kind -> CanvasTexture
  const mapFor = (detail, kind) => {
    const key = detail.uuid + '|' + kind;
    if (maps.has(key)) return maps.get(key);
    const S = detail.image.width, src = detail.image.data;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    c.slExact = true; // (the recorder keeps putImageData's pixels only for a canvas marked so)
    const g = c.getContext('2d'), img = g.createImageData(S, S), f = FACTOR[kind];
    for (let i = 0; i < S * S; i++) {
      const o = i * 4, d = f([src[o] / 255, src[o + 1] / 255, src[o + 2] / 255, src[o + 3] / 255]) / DMAX[kind];
      const v = Math.round(255 * Math.min(1, Math.max(0, toSrgb(d))));
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    maps.set(key, t);
    return t;
  };
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.aTex && typeof o.material?.onBeforeCompile === 'function' && !o.userData.slSkip) meshes.push(o); });
  let made = 0;
  for (const o of meshes) {
    // the game's own detail texture, as its shader patch hands it over
    const sh = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>' };
    try { o.material.onBeforeCompile(sh); } catch { /* (not the cabin's patch) */ }
    const detail = sh.uniforms.uDetail?.value;
    if (!detail?.image?.data) continue;
    const g = o.geometry, P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color, X = g.attributes.aTex, I = g.index;
    const nTri = (I ? I.count : P.count) / 3, at = (k) => (I ? I.getX(k) : k);
    const per = TILES.map(() => ({ pos: [], nor: [], col: [], uv: [] }));
    for (let t = 0; t < nTri; t++) {
      const ids = [at(t * 3), at(t * 3 + 1), at(t * 3 + 2)];
      const kind = Math.min(TILES.length - 1, Math.max(0, Math.round(X.getX(ids[0])))), k = TILES[kind], out = per[kind];
      // the face's main axis (cabinPatch blends the three projections by the normal squared: on these flat panels one wins)
      let nx = 0, ny = 0, nz = 0;
      for (const i of ids) { nx += N ? N.getX(i) : 0; ny += N ? N.getY(i) : 1; nz += N ? N.getZ(i) : 0; }
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz), axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
      for (const i of ids) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        out.pos.push(x, y, z);
        out.nor.push(N ? N.getX(i) : 0, N ? N.getY(i) : 1, N ? N.getZ(i) : 0);
        if (C) out.col.push(C.getX(i), C.getY(i), C.getZ(i)); else out.col.push(1, 1, 1);
        if (axis === 0) out.uv.push(z * k, y * k); else if (axis === 1) out.uv.push(x * k, z * k); else out.uv.push(x * k, y * k);
      }
    }
    per.forEach((d, kind) => {
      if (!d.pos.length) return;
      const ng = new THREE.BufferGeometry();
      ng.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
      ng.setAttribute('normal', new THREE.Float32BufferAttribute(d.nor, 3));
      ng.setAttribute('color', new THREE.Float32BufferAttribute(d.col, 3));
      ng.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
      const m = o.material.clone();
      m.onBeforeCompile = () => {};
      m.map = mapFor(detail, kind);
      m.color = o.material.color.clone().multiplyScalar(DMAX[kind]);
      m.vertexColors = true;
      const mesh = new THREE.Mesh(ng, m);
      mesh.name = `${o.name || 'cabin'}-detail${kind}`;
      mesh.position.copy(o.position); mesh.quaternion.copy(o.quaternion); mesh.scale.copy(o.scale);
      mesh.renderOrder = o.renderOrder;
      o.parent.add(mesh);
      made++;
    });
    o.userData.slSkip = true;
  }
  if (made) root.updateMatrixWorld(true);
  log('train detail:', meshes.length, 'cabin meshes baked into', made, 'textured pieces,', maps.size, 'maps');
  return made;
}

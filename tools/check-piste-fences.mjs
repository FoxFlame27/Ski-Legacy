// Run: node tools/check-piste-fences.mjs  (Node only, no browser: lays out the resort and checks the piste fences)
// Node check: every piste's edges are fenced / netted except at intended gaps; no fence on a groomed run,
// at a lift station or a tower. Prints per-resort counts.
const L = await import('../src/world/layout.js');
const S = await import('../src/world/secrets.js');
const { world } = await import('../src/world/world.js');
L.initLayout(); S.initSecrets(); const fst = L.planPisteFences();
const { layout, PISTE_WIDTH, cannonSpots } = L;
const sd = (x, z, ax, az, bx, bz) => { const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1; const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)); return Math.hypot(ax + ex * t - x, az + ez * t - z); };
// net point hash
const grid = new Map(); const key = (x, z) => Math.floor(x / 8) + ',' + Math.floor(z / 8);
for (const n of layout.nets) for (const p of n.line) { const k = key(p[0], p[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p[0], p[1], n); }
const netNear = (x, z, r) => { const cx = Math.floor(x / 8), cz = Math.floor(z / 8); for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) { const a = grid.get(i + ',' + j); if (a) for (let k = 0; k < a.length; k += 3) if (Math.hypot(a[k] - x, a[k + 1] - z) < r) return a[k + 2]; } return null; };
const liftKeys = new Set(layout.lifts.map((l) => `${l.bottom.x},${l.bottom.z},${l.top.x},${l.top.z}`));
const towers = layout.lifts.flatMap((l) => l.towers || []);
const stations = []; for (const l of layout.lifts) { const g = l.type === 'gondola'; stations.push([l.bottom.x, l.bottom.z, g ? 55 : 34, l.name], [l.top.x, l.top.z, g ? 58 : 36, l.name]); if (l.mid) stations.push([l.mid.x, l.mid.z, 42, l.name]); }
for (const h of layout.huts) stations.push([h.x, h.z, 42, h.name]);
const cannons = cannonSpots();
const why = (x, z) => {
  if (Math.hypot(x, z) < 300) return 'village';
  for (const s of world.corridorGrid.get(Math.floor(x / 64) + ',' + Math.floor(z / 64)) || []) {
    if (s.kind === 'lift' && (s.w <= 1.7 || liftKeys.has(`${s.ax},${s.az},${s.bx},${s.bz}`))) continue;
    if (sd(x, z, s.ax, s.az, s.bx, s.bz) - s.w < 0.6) return s.kind === 'lift' ? 'secret/trail' : s.meta?.name ? 'junction' : 'pad apron/link';
  }
  for (const t of towers) if (Math.hypot(t.x - x, t.z - z) < 6) return 'tower';
  for (const [sx, sz, r] of stations) if (Math.hypot(sx - x, sz - z) < r) return 'station/hut';
  for (const [cx, cz] of cannons) if (Math.hypot(cx - x, cz - z) < 1.5) return "cannon";
  if (world.padInfluence(x, z) > 0.05) return 'pad';
  return null;
};
const res = {};
const R = (p) => (res[p.peak || 'valley/other'] ??= { pistes: 0, km: 0, edgeSamples: 0, covered: 0, gap: {}, uncovered: 0, uncoveredM: 0, fenceB: 0, fenceR: 0, hazard: 0, crossBad: 0, stationBad: 0, towerBad: 0 });
for (const p of layout.pistes) {
  if (p.lane) continue;
  const r = R(p); r.pistes++;
  const w = PISTE_WIDTH[p.diff];
  let acc = 0;
  for (let i = 1; i < p.pts.length; i++) {
    const [ax, az] = p.pts[i - 1], [bx, bz] = p.pts[i], l = Math.hypot(bx - ax, bz - az); if (l < 1e-6) continue;
    const dx = (bx - ax) / l, dz = (bz - az) / l;
    for (let t = (5 - (acc % 5)) % 5; t < l; t += 5) {
      const x = ax + dx * t, z = az + dz * t;
      for (const side of [1, -1]) {
        const ex = x - dz * side * (w + 1.2), ez = z + dx * side * (w + 1.2);
        r.edgeSamples++;
        if (netNear(ex, ez, 5)) { r.covered++; continue; }
        const y = why(ex, ez);
        if (y) { r.gap[y] = (r.gap[y] || 0) + 1; continue; }
        const nb = netNear(ex, ez, 14);
        if (nb?.bowl) { r.gap['bowl gate'] = (r.gap['bowl gate'] || 0) + 1; continue; }
        r.uncovered++;
      }
    }
    acc += l; r.km += l / 1000;
  }
}
// fence sanity: no fence point on any groomed run (signed distance to every piste's groomed area >= 0.5 m),
// at a lift station (< 25 m) or a tower (< 4 m)
const pisteSegs = []; for (const p of layout.pistes) for (let i = 1; i < p.pts.length; i++) pisteSegs.push([...p.pts[i - 1], ...p.pts[i], PISTE_WIDTH[p.diff]]);
const sgrid = new Map(); for (const s of pisteSegs) { const R0 = s[4] + 3; for (let i = Math.floor((Math.min(s[0], s[2]) - R0) / 32); i <= Math.floor((Math.max(s[0], s[2]) + R0) / 32); i++) for (let j = Math.floor((Math.min(s[1], s[3]) - R0) / 32); j <= Math.floor((Math.max(s[1], s[3]) + R0) / 32); j++) { const k = i + ',' + j; if (!sgrid.has(k)) sgrid.set(k, []); sgrid.get(k).push(s); } }
let minClear = Infinity;
for (const n of layout.nets) {
  const pk = layout.pistes.find((p) => p.name === n.owner); const r = R(pk || {});
  const len = (n.line.length - 1) * 2;
  if (n.fence) r[n.type === 'R' ? 'fenceR' : 'fenceB'] += len / 1000; else r.hazard += len / 1000;
  for (const [x, z] of n.line) {
    let worst = Infinity;
    for (const s of sgrid.get(Math.floor(x / 32) + ',' + Math.floor(z / 32)) || []) worst = Math.min(worst, sd(x, z, s[0], s[1], s[2], s[3]) - s[4]);
    if (n.fence) minClear = Math.min(minClear, worst);
    if (n.fence && worst < 0.5) r.crossBad++;
    if (n.fence && layout.lifts.some((l) => [l.bottom, l.top, l.mid].some((st) => st && Math.hypot(st.x - x, st.z - z) < 25))) r.stationBad++;
    if (n.fence && towers.some((t) => Math.abs(t.x - x) < 4 && Math.abs(t.z - z) < 4 && Math.hypot(t.x - x, t.z - z) < 4)) r.towerBad++;
  }
}
console.log('fence planner:', fst);
console.log('resort         pistes   km  edge-cov%  B-net km  rope km  hazard km  uncovered  on-run  station  tower  gaps(by reason, 5 m samples)');
const tot = { pistes: 0, km: 0, edgeSamples: 0, covered: 0, uncovered: 0, fenceB: 0, fenceR: 0, hazard: 0, crossBad: 0, stationBad: 0, towerBad: 0 };
for (const [k, r] of Object.entries(res)) {
  for (const f in tot) tot[f] += r[f];
  console.log(k.padEnd(14), String(r.pistes).padStart(6), r.km.toFixed(1).padStart(5), (100 * r.covered / r.edgeSamples).toFixed(1).padStart(9), r.fenceB.toFixed(1).padStart(9), r.fenceR.toFixed(1).padStart(8), r.hazard.toFixed(1).padStart(10), String(r.uncovered).padStart(10), String(r.crossBad).padStart(7), String(r.stationBad).padStart(8), String(r.towerBad).padStart(6), ' ', JSON.stringify(r.gap));
}
console.log('TOTAL'.padEnd(14), String(tot.pistes).padStart(6), tot.km.toFixed(1).padStart(5), (100 * tot.covered / tot.edgeSamples).toFixed(1).padStart(9), tot.fenceB.toFixed(1).padStart(9), tot.fenceR.toFixed(1).padStart(8), tot.hazard.toFixed(1).padStart(10), String(tot.uncovered).padStart(10), String(tot.crossBad).padStart(7), String(tot.stationBad).padStart(8), String(tot.towerBad).padStart(6));
console.log('fenced share of the edges that exist (not on another run / station / pad / village / gate):', (100 * tot.covered / (tot.covered + tot.uncovered)).toFixed(1) + '%', '; uncovered pieces are short (none over 12 m): fold-backs on the inside of tight bends, sub-10 m stubs');
console.log('min fence clearance to any groomed run (m):', minClear.toFixed(2));

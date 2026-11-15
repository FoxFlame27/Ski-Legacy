// Generates the VILLAGE buildings and street pieces of the native (C++) game's new village layout on Meshy
// (text-to-3d preview -> refine): hotels of several styles, shops with ground-floor windows, a café, a bakery, a sports
// shop, the church, the lift base hall, the bus terminal, apartment lodges, chalets of several styles, garages, a
// fountain, retaining walls and stairs for the terraces, bus shelters, banner lamps, kiosks. The C++ places them from
// native/tools/village_layout.mjs (native/data/village.json); the JS game does not use them.
// Raw GLBs go to assets-src/raw/village, optimised copies (webp textures, meshopt) to public/models/village/<id>.glb.
// Resumable: task ids (and the credits each step cost) live in tools/meshy-village-state.json.
// Usage: node tools/meshy-village.mjs [id ...]        (no ids: every asset not done yet)
//        ... --redo id ...                            (discard old tasks for those ids)
//        ... --optimize [id ...]                      (only re-run the optimiser on downloaded raws)
//        ... --list                                   (the plan and what is done, no API calls)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-village-state.json');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'village');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(RAW_DIR, { recursive: true });
const outFile = (a) => path.join(ROOT, 'public', 'models', 'village', `${a.id}.glb`);

// (a building as a whole, standing on a level footprint: the C++ sets it on a terrace and banks snow round its foot)
const B = 'one single complete free-standing building seen from outside, the whole building visible, a flat level base at the bottom of the ground floor, fresh snow on the roof, no terrain, no ground plane, no people, no cars, no trees, photorealistic architecture, game asset';
const P = 'standing alone, flat underside, no ground, no base plate, no background, realistic, game asset';
const BT = 'photorealistic architectural textures, crisp window frames and mullions, sharp details, clean white snow on the roof';
// polys: Meshy's remesh target; px: the texture size after optimisation
const ASSETS = [
  // ---- hotels (3-5 storeys)
  { id: 'hotel_grand', polys: 40000, px: 2048, style: B,
    prompt: 'A grand five storey Belle Epoque alpine palace hotel like in Zermatt or St. Moritz: symmetrical cream stucco facade, tall white framed windows in regular rows, wrought iron balconies, a dark grey slate mansard roof with dormer windows and two corner towers, a covered glass entrance canopy in the middle of the ground floor',
    tex: 'cream and pale yellow stucco walls, white window frames, dark grey slate roof, black wrought iron railings, warm lit interior behind the glass, ' + BT },
  { id: 'hotel_lodge', polys: 36000, px: 2048, style: B,
    prompt: 'A four storey North American mountain lodge hotel like in Whistler or Vail: heavy grey fieldstone ground floor with arched entrance, upper floors clad in dark brown timber with exposed log beams, several large steep gables, big timber framed windows, wooden balconies, stone chimneys, a wide porte cochere entrance roof on timber posts',
    tex: 'grey and brown fieldstone, dark stained brown timber, green metal roof, black window frames, ' + BT },
  { id: 'hotel_tyrol', polys: 36000, px: 2048, style: B,
    prompt: 'A four storey traditional Tyrolean hotel like in St. Anton or Kitzbuehel: white rendered walls, green painted wooden window shutters, long carved wooden balconies with red geraniums on every upper floor, a wide low pitched gable roof with deep overhanging eaves, painted decoration around the windows, a ground floor restaurant with arched windows',
    tex: 'white render, dark brown carved larch balconies, green shutters, red flowers, brown wooden roof eaves, ' + BT },
  { id: 'hotel_modern', polys: 32000, px: 2048, style: B,
    prompt: 'A modern four storey alpine boutique hotel like in Lech or Andermatt: a rectangular block clad in vertical weathered larch boards and natural stone, large floor to ceiling windows, glass balustrade balconies, a shallow pitched roof with thin edges, a glazed lobby on the ground floor',
    tex: 'silver grey weathered larch boards, light granite stone, dark anthracite window frames, clear glass, ' + BT },
  { id: 'hotel_valais', polys: 32000, px: 2048, style: B,
    prompt: 'A three storey old Swiss Valais hotel like in Zermatt village: a whitewashed stone lower floor and sun-blackened dark larch log upper floors, small square windows with red and white striped shutters, stone slab roof, a wooden outside staircase and a small balcony',
    tex: 'sun-darkened brown black larch logs, whitewashed stone, grey stone slab roof, red and white shutters, ' + BT },
  // ---- shops on the main street (ground floor shop windows)
  { id: 'shop_townhouse', polys: 26000, px: 2048, style: B,
    prompt: 'A three storey narrow alpine old town house like in Kitzbuehel main street: ochre yellow rendered facade, a big shop window and a glass shop door on the ground floor with a striped awning, a hanging wrought iron shop sign, two floors of windows with shutters above, a steep gable roof facing the street',
    tex: 'warm ochre yellow render, white stone window surrounds, dark green shutters, red and white striped awning, shop display behind clear glass, ' + BT },
  { id: 'shop_pastel', polys: 26000, px: 2048, style: B,
    prompt: 'A three storey alpine town house with a pale pink rendered facade and a bay oriel window on the first floor, a boutique on the ground floor with two large arched display windows and a wooden door, painted ornaments around the windows, a gable roof with a small dormer',
    tex: 'pale pink and white render, cream stone trim, dark wooden door, clear glass display windows with clothes inside, ' + BT },
  { id: 'shop_timber', polys: 24000, px: 2048, style: B,
    prompt: 'A two storey Canadian mountain town shop building like on Banff Avenue: timber and stone facade, a long row of large shop windows on the ground floor under a timber canopy, a false front parapet with a cornice, upper floor windows with timber frames, a gable roof behind',
    tex: 'honey brown timber, grey river stone pillars, dark green trim, clear glass shop windows with goods inside, ' + BT },
  { id: 'cafe', polys: 24000, px: 2048, style: B,
    prompt: 'A two storey alpine coffee house and pastry shop: a ground floor with large glass windows and a glass door, a wide red fabric awning over the front, a timber upper floor with a balcony and flower boxes, a chalet gable roof with deep eaves',
    tex: 'white render ground floor, warm brown timber upper floor, deep red awning, cakes visible behind clear glass, ' + BT },
  { id: 'bakery', polys: 20000, px: 2048, style: B,
    prompt: 'A small two storey village bakery: a stone ground floor with a curved bay shop window full of bread and a wooden door, a hanging pretzel sign, a timber framed upper floor with small windows, a steep roof with a chimney',
    tex: 'light sandstone ground floor, dark timber framing with white plaster, golden bread in the window, ' + BT },
  { id: 'sports_shop', polys: 26000, px: 2048, style: B,
    prompt: 'A modern three storey ski and sports rental shop building in an alpine resort: a fully glazed ground floor shop front showing skis and snowboards, upper floors clad in dark timber and steel with large windows, a flat projecting canopy over the entrance, a low pitched roof',
    tex: 'dark brown timber cladding, anthracite steel, clear glass shop front with colourful skis inside, ' + BT },
  { id: 'restaurant_stube', polys: 24000, px: 2048, style: B,
    prompt: 'A traditional two storey alpine restaurant inn: a thick rough stone ground floor with small deep arched windows and a heavy wooden door, an upper floor of old dark wood with a long balcony, a wide shingle roof with deep eaves, a sun terrace platform with railings on one side',
    tex: 'rough grey stone, old dark brown wood, wooden shingle roof, warm lit windows, ' + BT },
  // ---- civic and resort buildings
  { id: 'church', polys: 30000, px: 2048, style: B,
    // (the first try came out a squat manor house with a little dome: tools/meshy-village-state.json church_old; the
    // second asks for the tower's proportions outright)
    prompt: 'An Austrian alpine village parish church seen from the side: a long simple white plastered nave with four tall round-arched windows and a steep dark red tiled saddle roof, and at the west end one very tall slender square bell tower, twice as high as the nave roof, with a clock face high up on each side, louvred belfry openings above the clocks and a green copper onion dome with a pointed spire and cross on top',
    tex: 'white plaster, pale yellow trim, red roof tiles, green copper onion dome, gold clock hands, ' + BT },
  { id: 'lift_hall', polys: 30000, px: 2048, style: B,
    prompt: 'A modern ski resort base building with ticket office, ski school and ski lockers: a long two storey building of glass, steel and larch wood, a big sign panel above the glass entrance doors, rows of ticket windows on the front, a cantilevered roof canopy over the queue area',
    tex: 'light larch wood cladding, grey steel frame, clear blue tinted glass, red accent panels, ' + BT },
  { id: 'bus_terminal', polys: 22000, px: 2048, style: B,
    prompt: 'A small alpine railway and bus station building like in Wengen or Grindelwald: a two storey timber station house with a clock on the gable, a long roofed open waiting hall on timber posts on one side, ticket window, benches under the canopy, a gable roof with decorative bargeboards',
    tex: 'brown timber, cream painted window frames, grey stone base, red roof, ' + BT },
  { id: 'town_hall', polys: 26000, px: 2048, style: B,
    prompt: 'A three storey alpine village town hall and post office: white rendered facade with painted corner stones, a small clock turret with a bell on the roof ridge, flags over the entrance, arched ground floor windows, a hip roof',
    tex: 'white render, pale grey painted corner stones, dark grey roof, yellow post office sign plate without text, ' + BT },
  // ---- apartment lodges and chalets (climbing the slope)
  { id: 'apartment_lodge', polys: 28000, px: 2048, style: B,
    prompt: 'A four storey chalet style apartment building in a French ski resort like Val d Isere: grey stone lower floors and timber upper floors, long wooden balconies on every floor, large windows, a broad stone slab roof with deep overhangs and several chimneys',
    tex: 'grey stone, warm brown timber, grey stone slab roof, ' + BT },
  { id: 'apartment_modern', polys: 26000, px: 2048, style: B,
    prompt: 'A modern three storey alpine apartment house: white render and vertical dark timber boards, big glass balconies, a single steep gable roof with a large glazed gable end, an underground garage door at the bottom',
    tex: 'white render, dark brown vertical timber, clear glass, grey metal roof, ' + BT },
  { id: 'chalet_classic', polys: 20000, px: 2048, style: B,
    prompt: 'A classic two and a half storey Swiss wooden chalet: honey coloured log walls on a stone ground floor, a carved wooden balcony across the front, small windows with red shutters, a wide low gable roof with very deep eaves and carved bargeboards',
    tex: 'honey brown logs, grey stone base, red shutters, ' + BT },
  { id: 'chalet_stone', polys: 20000, px: 2048, style: B,
    prompt: 'A two storey alpine house with a white rendered ground floor and a dark wood upper floor, green shutters, a stone outside stair to the front door, a wood shingle gable roof with a small chimney',
    tex: 'white render, dark brown aged wood, green shutters, grey stone stair, ' + BT },
  { id: 'chalet_modern', polys: 20000, px: 2048, style: B,
    prompt: 'A modern luxury ski chalet: a stone plinth, walls of dark charred timber, a huge triangular glass gable facing the valley, a steep roof, a cantilevered terrace with glass railing',
    tex: 'black charred timber, light stone, clear glass with warm interior, ' + BT },
  { id: 'chalet_small', polys: 16000, px: 2048, style: B,
    prompt: 'A small old one and a half storey alpine wooden hut house, darkened weathered timber, small windows with white frames, a steep wood shingle roof, a stack of firewood along one wall, a little covered entrance',
    tex: 'weathered dark grey brown timber, white window frames, ' + BT },
  { id: 'garages', polys: 12000, px: 2048, style: B,
    prompt: 'A row of four single storey timber garages with wooden up and over doors under one long flat roof, stone back wall, alpine village',
    tex: 'brown timber garage doors, grey stone, dark roof edge, ' + BT },
  // ---- street pieces
  { id: 'fountain', polys: 12000, px: 2048, style: P,
    prompt: 'A traditional alpine village square fountain: a large octagonal carved stone basin about 3 metres across, a tall stone column in the centre with four bronze water spouts and a small statue on top',
    tex: 'light grey carved granite, green bronze spouts, ' + BT },
  { id: 'retaining_wall', polys: 8000, px: 2048, style: P,
    prompt: 'A straight section of dry stone retaining wall, 8 metres long, 2.5 metres tall and 1 metre thick, a rectangular block of irregular fitted grey granite stones with a flat capping stone along the top, flat back',
    tex: 'grey granite stones with dark joints, a little moss, realistic stone texture' },
  { id: 'stone_stairs', polys: 8000, px: 2048, style: P,
    prompt: 'A wide outdoor granite staircase of ten steps, 4 metres wide, rising 2.5 metres, solid stone side walls on both sides with a black iron handrail',
    tex: 'grey granite steps, black iron handrail, realistic stone texture' },
  { id: 'bus_shelter', polys: 8000, px: 2048, style: P,
    prompt: 'An alpine village bus shelter: a timber frame with a pitched wooden roof, glass side and back walls, a wooden bench inside, a small timetable panel',
    tex: 'warm brown timber, clear glass, dark roof shingles, ' + BT },
];

function loadKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const m = env.match(/MESHY_API_KEY=(\S+)/);
  if (!m) throw new Error('MESHY_API_KEY missing from .env.local');
  return m[1];
}

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let KEY = null;

async function api(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API + url, {
        method,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt < 10) { await sleep(5000); continue; }
      throw e;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 40) { await sleep(10000); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}

async function waitTask(id, name) {
  for (;;) {
    const t = await api('GET', `/v2/text-to-3d/${id}`);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${name} ${t.status}: ${JSON.stringify(t.task_error)}`);
    await sleep(8000);
  }
}

async function download(url, file) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download -> ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) { if (i > 4) throw e; await sleep(4000); }
  }
}

function optimize(a) {
  const raw = path.join(RAW_DIR, `${a.id}.glb`);
  const out = outFile(a);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!fs.existsSync(raw)) return;
  execFileSync('npx', ['gltf-transform', 'optimize', raw, out,
    '--texture-compress', 'webp', '--texture-size', String(a.px), '--compress', 'meshopt',
    '--simplify', 'false', '--instance', 'false', '--join', 'false'], { cwd: ROOT, stdio: 'ignore' });
  log(`${a.id}: optimised -> ${Math.round(fs.statSync(out).size / 1024)} KB`);
}

const balance = async () => { try { return (await api('GET', '/v1/balance')).balance; } catch { return null; } };

async function build(a) {
  const id = a.id;
  const s = (state[id] ??= {});
  if (!s.preview) {
    s.preview = (await api('POST', '/v2/text-to-3d', {
      mode: 'preview', prompt: `${a.prompt}, ${a.style}`.slice(0, 600), ai_model: 'meshy-6', art_style: 'realistic',
      should_remesh: true, topology: 'triangle', target_polycount: a.polys, target_formats: ['glb'],
    })).result;
    s.previewCost = 20;   // (meshy-6 text-to-3d preview; checked against the balance in the log)
    saveState();
    log(`${id}: preview started`);
  }
  const pv = await waitTask(s.preview, id);
  if (pv.thumbnail_url && !fs.existsSync(path.join(RAW_DIR, `${id}_preview.png`))) await download(pv.thumbnail_url, path.join(RAW_DIR, `${id}_preview.png`)).catch(() => {});
  log(`${id}: preview done`);
  if (!s.refine) {
    s.refine = (await api('POST', '/v2/text-to-3d', {
      mode: 'refine', preview_task_id: s.preview, enable_pbr: false,
      texture_prompt: a.tex.slice(0, 600), target_formats: ['glb'],
    })).result;
    s.refineCost = 10;
    saveState();
    log(`${id}: refine started`);
  }
  const refined = await waitTask(s.refine, id);
  await download(refined.model_urls.glb, path.join(RAW_DIR, `${id}.glb`));
  if (refined.thumbnail_url) await download(refined.thumbnail_url, path.join(RAW_DIR, `${id}.png`)).catch(() => {});
  optimize(a);
  s.done = true;
  saveState();
}

const args = process.argv.slice(2);
if (args[0] === '--list') {
  for (const a of ASSETS) console.log(a.id.padEnd(18), state[a.id]?.done ? 'done' : state[a.id]?.preview ? 'started' : '-');
  process.exit(0);
}
if (args[0] === '--optimize') {
  for (const a of ASSETS) if (args.length < 2 || args.includes(a.id)) optimize(a);
  process.exit(0);
}
if (args[0] === '--redo') {
  args.shift();
  for (const n of args) { state[`${n}_old`] = [...(state[`${n}_old`] || []), state[n]]; delete state[n]; }
  saveState();
}
KEY = loadKey();
const b0 = await balance();
log('credits:', b0);
const selected = args.length ? ASSETS.filter((a) => args.includes(a.id)) : ASSETS;
const queue = selected.filter((a) => !state[a.id]?.done || !fs.existsSync(outFile(a)));
log(`building ${queue.length} village models`);
const failed = [];
await Promise.all(queue.map(async (a) => {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL VILLAGE MODELS DONE');
const b1 = await balance();
log('credits left:', b1, b0 != null && b1 != null ? `(this run: ${b0 - b1})` : '');

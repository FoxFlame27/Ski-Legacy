// Ski Legacy — main entry: boot, loading, game loop and gameplay glue.
import * as THREE from 'three';
import '@fontsource-variable/inter';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/600-italic.css';
import '@fontsource/barlow-condensed/700-italic.css';
import { installHeightFog } from './engine/fog.js';
import { Post } from './engine/post.js';
import { PropDetail } from './engine/detail.js';
import { world } from './world/world.js';
import { layout, initLayout, planPisteFences } from './world/layout.js';
import { Terrain, terrainUniforms } from './world/terrain.js';
import { Environment } from './world/sky.js';
import { Vegetation } from './world/vegetation.js';
import { Atmosphere } from './world/atmosphere.js';
import { Village } from './world/village.js';
import { Lifts } from './world/lifts.js';
import { Railway, RAIL_PRICE } from './world/railway.js'; // the Wolkenspitzbahn (transport agent)
import { Decor } from './world/decor.js';
import { loadAll } from './core/assets.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { SkierRig } from './player/skier.js';
import { Player } from './player/player.js';
import { Trails, Spray, skierFX } from './fx/snowfx.js';
import { FreeCourses, registerFreeWorldCourses, freeCourses, PRIZE_SHARE, AI_LEVELS, aiLevel, prizeFor } from './modes/parkour/freeworld.js'; // the World Racing courses on the mountains (free ride)
import { buildExpressGround } from './world/expressground.js'; // the Legacy Express: the high-speed line to every race (its ground works)
import { Express, EXPRESS_PRICE, FAST as EXPRESS_FAST } from './world/express.js'; // the Legacy Express's trains, boarding and the ride
import { planExpressScenery, buildExpressScenery } from './world/expressscenery.js'; // the frozen lakes under the Legacy Express's viaducts
import { NPCs } from './game/npcs.js';
import { initPeopleHits, playerHitPerson } from './game/peoplehits.js';
import { VehicleHits } from './game/vehiclehits.js'; // cars, buses, ploughs, the tow truck, other players' cars knock you over
import { HUD, CARD_DIALOG } from './ui/hud.js';
import { travelPicker, fmtMin } from './ui/travel.js'; // route map pickers (bus, train, gondola mid-stations) while CARD_DIALOG is on
import { ShopInterior } from './game/interior.js';
import { applyOutfit, getEquipped, outfitZones } from './game/outfits.js';
import { OutfitShop } from './ui/outfitshop.js';
import { SKIER_MODELS, PLAYER_CHARACTERS } from './game/characters.js';
import { AdminPanel } from './ui/admin.js';
import { Heli } from './game/heli.js';
import { Snowmobiles } from './game/snowmobile.js'; // drivable snowmobiles (vehicles agent)
import { Intro } from './ui/intro.js';
import { Menu } from './ui/menu.js';
import { Showcase } from './game/showcase.js';
import { SkiBus, BUS_RIDE } from './game/skibus.js';
import { ParkingLots } from './game/parking.js'; // the car parks (vehicles agent)
import { Hospital } from './game/hospital.js'; // the medical centre the ambulance drives to (vehicles agent)
import { Traffic } from './game/traffic.js'; // cars driving the roads (vehicles agent)
import { Drive } from './game/drive.js'; // drive the parked cars yourself (vehicles agent)
import { CarRental } from './game/carrental.js'; // CAR RENTAL: rent a car (showroom inside), the wreck fee, the tow truck
import { planBusRoads } from './game/bus/roads.js'; // plowed roads for the ski bus (vehicles agent)
import { Crowds } from './world/crowds.js';
import { Snowcats } from './world/snowcats.js';
import { Flags } from './world/flags.js';
import { presentation } from './game/presentation/index.js';
import { wantsBusIntro } from './game/presentation/busintro.js'; // first-time intro: the summer valley, the ski bus
import { Jobs } from './game/jobs.js';
import { Talk } from './game/talk.js';
import { Modes } from './game/modes.js';
import { RaceStandUI } from './ui/racestand.js';
import { RaceHud } from './ui/racehud.js';
import { transition } from './ui/transition.js';
import { COURSES, COURSE_MODELS } from './modes/parkour/courses.js';
import { freeRideHour } from './modes/parkour/looks.js';
import { buildResortDressing } from './world/resortdressing.js';
import { buildPark } from './world/park.js';
import { initSecrets, Secrets } from './world/secrets.js';
import { Backdrop } from './world/backdrop.js';
import { settleProps } from './world/settle.js';
import { SunGlare } from './world/sunglare.js';
import { PisteLights } from './world/pistelights.js'; // static: installs its light-pool shader chunk before any material compiles
import { Headlamp } from './world/headlamp.js';
import { SKIS, PRICES, save, loadSave, writeSave, resetSave, skiById } from './game/economy.js';
import { quality, setQuality, normalizeQuality, detectQuality, lowerQuality, screenDPR, QUALITY_LABELS } from './engine/quality.js';
import { PersonalBests } from './game/bests.js';
import { TrailMap } from './ui/trailmap.js';
import { PhotoMode } from './ui/photomode.js';
import { Chalets } from './game/chalets.js'; // the chalet village (Almdorf): rent a chalet, its interior
import { seating } from './game/seating.js'; // sitting down on benches, chairs, sofas, bed edges (the whole map + your chalet)
import { chaletInteriorAPI } from './game/chaletroom.js';
import { HX as CHALET_HX } from './game/chaletplan.js';
import { FURNITURE_BY_ID } from './game/build/catalog.js';
import { BuildMode } from './game/build/buildmode.js'; // chalet build mode (F inside your rented chalet)
import { startObjective } from './game/build/objectives.js';
import { MP, isMP } from './net/mode.js'; // multiplayer (docs/multiplayer.md): every AI system and the save check isMP()
import { net } from './net/client.js';
import { Multiplayer, errText } from './net/session.js';
import { ST as MPST, F as MPF } from './net/protocol.js';
let multiplayer = null; // the multiplayer session (net/session.js), built at the end of boot
let photo = null; // photo mode (P): frozen world, free orbit camera, no HUD
let bests = null; // personal-best cards in free ride (top speed, longest jump, milestones)

installHeightFog();
loadSave();

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });

// Graphics preset (engine/quality.js): the player's pick, else a fresh guess from the GPU at every launch
// (corrected by the first seconds of play, see autoQuality; such a drop lasts that session only)
if (save.qualitySet !== 'user' || !normalizeQuality(save.quality)) {
  const d = detectQuality(renderer);
  save.quality = d.quality;
  save.qualitySet = 'auto';
  console.info(`Graphics: ${d.quality} (detected: ${d.gpu || 'unknown GPU'}, ${d.mem} GB, ${d.cores} cores)`);
  writeSave();
}
save.quality = setQuality(save.quality);
const DPR = screenDPR();
const basePR = () => Math.min(DPR * quality.scale, quality.prCap);

renderer.setPixelRatio(basePR());
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.72;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = quality.shadow.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 32000);
const env = new Environment(renderer, scene);
env.setShadowQuality(quality.shadow);
env.fogScale = quality.fog;
env.hour = save.hour;

const input = new Input(canvas);
const audio = new Audio();
const hud = new HUD();
const buildMode = new BuildMode({ save, writeSave, spend, hud, audio, input });
const raceHud = new RaceHud({ hud, audio });

// The six Meshy skiers: the race field, the skiers on the pistes and the villagers wear all of them. You play
// the man or the woman (PLAYER_CHARACTERS, game/characters.js) and dress them in the ski shop. Characters have
// no stats: every skier handles the same, only the skis differ.
const CHARACTERS = SKIER_MODELS;
const MODEL_LIST = [
  ...CHARACTERS.flatMap((c) => [`${c.id}_rigged`, `${c.id}_anims`]),
  ...SKIS.map((s) => s.model), 'ski_pole',
  'rail_station_valley', 'rail_station_halt', 'rail_station_glacier', 'rail_car2', // the Wolkenspitzbahn's stations (Meshy)
  // job props (all optional: jobs fall back to built-in props)
  'job_board', 'delivery_backpack', 'patrol_backpack', 'mail_bag', 'ski_glove', 'ski_goggles', 'beanie', 'compact_camera', 'rescue_sled', 'smartphone',
  'rental_shop', 'gondola_station', 'gondola_cabin', 'chairlift_chair', 'lift_tower',
  'gondola_terminal', // the gondola mid-station hall (lifts.js MESHY_MID)
  'chair_terminal', 'chair_bullwheel', // the chairlift terminals: operator hut + bullwheel (lifts.js MESHY_CHAIR)
  'pine_tree', 'pine_tree2', 'hotel_chalet', 'mountain_hut', 'race_arch', 'ticket_booth', 'snow_cannon', 'lamp_post',
  // decoration props
  'wooden_bench', 'outdoor_ski_rack', 'snowman', 'firewood_pile', 'wooden_fence', 'christmas_tree', 'picnic_table', 'wooden_sled', 'deck_chair', 'map_board', 'sign_pole', 'truss_pylon',
  'snowmobile', 'wooden_barrel', 'trash_bin', 'market_stall', 'fire_pit',
  // car parks (game/parking.js): pay machine + P sign (lamp_post is above)
  'parking_pay_machine', 'parking_sign',
  // the medical centre (game/hospital.js) and the one parked car (the user's BMW X3, game/parking.js)
  'medical_centre', 'car_bmw_x3', 'car_audi_rs6', 'car_vw_golf_gti', 'car_tesla_m3', 'car_mercedes_sls', 'car_porsche_taycan', 'car_lamborghini_huracan', 'car_toyota_gr_yaris', 'car_audi_etron_gt', 'car_mercedes_gls',
  // shop interior props
  'helmet_shelf', 'boot_rack', 'jacket_rail', 'shop_counter', 'potted_plant', 'glove_bin', 'shop_bench', 'farm_table',
  // race courses + resort dressing
  ...COURSE_MODELS, 'patrol_hut',
  // heli-skiing + floodlit pistes
  'heli_body', 'floodlight_head_b', 'floodlight_head_c', 'floodlight_mast',
  // living world
  'snowcat',
  // the ski bus (loaded only while its ride is switched on, see skibus.js BUS_RIDE)
  ...(BUS_RIDE ? ['ski_bus'] : []),
  // the ambulance after a heli rescue (game/heli/ambulance.js)
  'ambulance', 'bus_stop_sign',
  'tow_truck', // the CAR RENTAL's tow truck (game/towtruck.js)
].filter((n, i, a) => n !== 'safety_net' && a.indexOf(n) === i);

let menu = null;
let talk = null; // conversations: the camera moves in on whoever you talk to (src/game/talk.js)
const setLoad = (f, t) => menu?.setLoading(f, t);

let railway = null;
let express = null; // the Legacy Express: trains round the ring to every race (world/express.js)
let sleds = null; // snowmobiles you can drive (game/snowmobile.js)
let parking = null; // the car parks (game/parking.js)
let traffic = null; // cars driving the roads (game/traffic.js)
let drive = null; // the car you drive (game/drive.js)
let chaletSeatPrompt = null; // inside your chalet: Sit down / Stand up (game/seating.js)
let chalets = null; // the chalet village: the houses, renting one, its interior (game/chalets.js)
let carRental = null; // CAR RENTAL: the building, its showroom, your rental, the tow truck (game/carrental.js)
let vehicleHits = null; // getting hit by vehicles on foot / on skis (game/vehiclehits.js)
let raceStand = null, raceStandUI = null; // the RACING stand (game/racestand.js) and its panel (ui/racestand.js)
let decor, models, terrain, vegetation, atmosphere, village, lifts, trails, spray, player, races, npcs, post, interior, seller, sellerHeading = 0, shopTarget = null, showcase, modes, backdrop, glare, dressing, park, skibus, jobs, heli, pisteLights, crowds, snowcats, flags;
let secrets = null; // hidden tunnels, couloirs, caves (world/secrets.js)
const jobFrame = { active: false }; // reused every frame
const propDetail = new PropDetail();
let startHouse = null, startHouseGroup = null;
const colliders = [];
let started = false;
let busIntro = null; // first-time intro (game/presentation/busintro.js): the valley cinematic, then the arrival; owns the camera
let gondolaRides = 0;
let headlamp;
let outfitShop = null;
let admin = null; // F2 / ` admin panel (free ride only)

// Skiers carry poles: you (shown in third person only, see SkierRig) and the race bots (ai: a light pole stand-in
// away from the camera); the resort's skiers, villagers, clerks and the menu showcase have none.
function makeRig(charId, skiId, { poles = false, ai = false } = {}) {
  const ski = skiById(skiId) || SKIS[0];
  const skiModel = models[ski.model] || models[ski.fallback] || models.ski_pro;
  // a missing model falls back to the woman's so a race field never fails to spawn
  return new SkierRig(models[`${charId}_rigged`] || models.skier_blue_rigged, {
    ski: skiModel,
    pole: poles ? models.ski_pole : null,
    poleLod: ai,
    clips: clipsFor(charId),
  });
}

function clipsFor(charId) {
  const anims = models[`${charId}_anims`]?.animations || [];
  const find = (re) => anims.find((c) => re.test(c.name));
  return { idle: find(/^Idle/i), walk: find(/Walk/i), run: find(/Run/i) };
}

async function boot() {
  setLoad(0.02, 'Shaping the mountains…');
  initLayout();
  initSecrets(); // the secrets shape their tunnels / couloirs into the terrain before any of it is built
  try { planPisteFences(); } catch (e) { console.warn('piste fences', e); } // nets / rope lines along every run (after the secrets: their trailheads stay open)
  if (BUS_RIDE) { try { planBusRoads(layout.busStops); } catch (e) { console.warn('bus roads / car parks', e); } } // the ski bus's roads are carved in before the terrain is built too
  terrain = new Terrain(scene);
  const modelsLoading = loadAll(MODEL_LIST, (n, total, name) => setLoad(0.05 + (n / total) * 0.55, `Loading ${name.replace(/_/g, ' ')}…`));
  // the eight World Racing courses stand on the mountains around the resort: their regions shape the terrain, so
  // they are registered now, before any of it is built (one per task while the models stream in)
  try { console.log('World Racing courses on the mountains:', await registerFreeWorldCourses(), 'ms'); } catch (e) { console.warn('free-world courses', e); }
  // the Legacy Express's line is fitted on the courses' final ground, its roadbed carved in before any terrain is built
  try { planExpressScenery(freeCourses()); } catch (e) { console.warn('Legacy Express scenery (lakes)', e); } // (first: the line's profile is fitted on the lakes' basins)
  try { buildExpressGround(freeCourses()); } catch (e) { console.warn('Legacy Express ground', e); }
  models = await modelsLoading;
  if (!models.ski_elite) models.ski_elite = models.ski_pro;

  setLoad(0.62, 'Growing forests…');
  vegetation = new Vegetation(scene, renderer, models);
  atmosphere = new Atmosphere(scene, { renderer, crystal: models.crystal });
  backdrop = new Backdrop(scene, { renderer, env });   // the big peaks on the horizon (logo look)
  glare = new SunGlare(scene, { renderer, camera, env }); // starburst sun
  village = new Village(scene, models, colliders, layout);
  lifts = new Lifts(scene, models, colliders, layout);
  railway = new Railway({ scene, colliders, makeRig, models }); // the Wolkenspitzbahn: track, stations, trains
  try { express = new Express({ scene, colliders, models, makeRig, railway, cameraBlockers: village.cameraBlockers }); await express.ready; } catch (e) { console.warn('Legacy Express', e); express = null; } // its trains (+ the line's track, stations)
  try { buildExpressScenery(scene); } catch (e) { console.warn('Legacy Express scenery', e); } // the frozen lakes' ice
  decor = new Decor(scene, models, colliders, village);
  // safety nets, piste signs + markers, patrol huts; Legacy Park (its corridor is registered by initLayout)
  dressing = buildResortDressing(scene, models);
  colliders.push(...(dressing.userData.colliders || []));
  park = buildPark(scene, models);
  colliders.push(...(park.userData.colliders || []));
  // floodlight masts along the pistes for night skiing (before the pre-stream: each mast clears a few trees)
  pisteLights = new PisteLights(scene, { models, layout, world, env, colliders });
  colliders.push(...pisteLights.colliders);
  skibus = new SkiBus({ scene, models, layout, colliders, makeRig, cameraBlockers: village.cameraBlockers }); // stops in the village + at every gondola base (+ the bus, its driver)
  try { parking = new ParkingLots({ scene, models, colliders, cameraBlockers: village.cameraBlockers }); } catch (e) { console.warn('car parks', e); parking = null; } // three car parks (empty)
  try { new Hospital({ scene, models, colliders }); } catch (e) { console.warn('medical centre', e); } // where the ambulance takes you
  secrets = new Secrets({ scene, models, terrain, colliders, cameraBlockers: village.cameraBlockers, hud, audio, save, writeSave, earn: (a, l) => earn(a, l, 'secret'), propDetail });
  // living world: fans along the race finishes, flags in the village, snowcats grooming the pistes
  crowds = new Crowds(scene).addResortArenas({ dressing, models, colliders });
  flags = new Flags(scene, { colliders, village });
  colliders.push(...flags.colliders);
  snowcats = new Snowcats(scene, { models, colliders });
  colliders.push(...snowcats.colliders);
  trails = new Trails(scene);
  spray = new Spray(scene);

  const rig = makeRig(save.character, save.skis || 'rental', { poles: true });
  applyOutfit(rig, save.character, getEquipped(save, save.character)); // bought outfit (no-op when stock)
  rig.addTo(scene);
  player = new Player({ rig, input, camera, colliders, vegetation, audio });
  player.sensitivity = save.sensitivity;
  player.cameraBlockers = village.cameraBlockers;
  player.onStep = (x, z, heading, side) => trails.footprint(x, z, heading, side);
  // flat loading areas where standing on skis is fine: lift stations and race starts
  const zones = () => [
    ...layout.lifts.flatMap((l) => [{ x: l.bottom.x, z: l.bottom.z, r: 45 }, { x: l.top.x, z: l.top.z, r: 60 }]),
    ...freeCourses().flatMap((e) => [{ x: e.start.x, z: e.start.z, r: 45 }, { x: e.finish.x, z: e.finish.z, r: 110 }]), // the courses' start + finish areas
  ];
  player.skiZones = zones();
  layout.onAdd(() => { player.skiZones = zones(); });
  player.hasSkis = !!save.skis;
  if (save.skis) player.ski = skiById(save.skis);
  player.setSkisOn(player.hasSkis);
  rig.setSkisVisible(player.hasSkis);
  player.teleport(4, 34, Math.PI);
  player.camYaw = 0;

  showcase = new Showcase({ scene, camera, makeRig: (id) => { const r = makeRig(id, save.skis || 'rental'); applyOutfit(r, id, getEquipped(save, id)); return r; }, side: 'right' });

  headlamp = new Headlamp(scene, { world }); // helmet lamp: spot light, beam, lit flakes (world/headlamp.js)

  const others = CHARACTERS.map((c) => c.id);
  npcs = new NPCs({
    scene, layout, village, colliders, racing: () => races?.active?.race || null, // (+ the village's people, NPC skiers kept off a running race)
    makeSkier: (k) => ({ rig: makeRig(others[k % others.length], ['rental', 'sport', 'pro'][k % 3]) }),
    fx: (id, r, info, dt) => skierFX(trails, spray, id, r, info, dt),
  });
  player.people = () => npcs.near; // bump into skiers and villagers
  // free ride: skiing into somebody at speed knocks you both over (a 'bump' event: no strike) and costs a fine; the
  // snowmobile and cars knock people over too (game/peoplehits.js). Races / World Racing keep the soft bump.
  try {
    // (off on request, 2026-10-27: people are only a soft bump again: nobody falls, no fines. true turns it back on)
    const PEOPLE_HITS_ON = false;
    initPeopleHits({ player, npcs, hud, audio, enabled: () => PEOPLE_HITS_ON && started && !modes?.active && !races?.active && !heli?.active });
    player.onPersonHit = playerHitPerson;
  } catch (e) { console.warn('people hits', e); }
  modes = new Modes({
    scene, models, player, makeRig: (c, s) => makeRig(c, s, { poles: true, ai: true }), audio, hud, raceHud, transition, trails, spray, save, writeSave,
    botCharacters: () => CHARACTERS.map((c) => c.id).filter((id) => id !== save.character),
    stream: streamAround,
    toMenu: backToMenu,
    toWorld: backToStand, // a fun race from the RACING stand ends back there, in free ride
    lock: () => input.lock(),
  });
  // (the old open-world gate races are gone: free ride races the World Racing courses where they stand, see
  // modes/parkour/freeworld.js; `races` keeps the old name for the checks below)
  races = new FreeCourses({ scene, models, modes, colliders });
  player.onTrick = (t) => { raceHud.trick(t); modes.session?.onTrick?.(t); };
  bests = new PersonalBests({ player, save, writeSave, raceHud, audio });
  photo = new PhotoMode({
    scene, camera, player, hud, onExit: () => input.lock(),
    canEnter: () => started && !paused && !hud.panelOpen && document.getElementById('map').hidden && !modes.active && !races.active && !interior.active && !transition.active && !heli.active && !talk.busy,
  });
  post = new Post(renderer, scene, camera);

  // walk-in ski shop + the ticket seller at the booth window
  interior = new ShopInterior({
    renderer, models,
    makeRig: () => makeRig('skier_black', 'rental'), // the clerk (never the man's or the woman's model: no twin of you)
    makeCharRig: (id) => makeRig(id, save.skis || 'rental'), // your skier on the OUTFITS podium
    getCharacter: () => save.character,
    getOutfit: (id) => getEquipped(save, id),
    getSkiState: (id) => {
      const s = skiById(id);
      return { owned: save.owned.includes(id), equipped: save.skis === id, price: s.price, rent: s.rent, canAfford: save.money >= s.price };
    },
    // the storefront looks out on the village: hide you and the shop's own building for that view
    outside: { scene, env, door: village.shopDoor, front: village.shopFront, hide: () => [player.rig.root, player.rig.gear, village.cameraBlockers[0]] },
  });
  // outfit & gear shop (the OUTFITS corner inside the ski shop)
  outfitShop = new OutfitShop({
    save, writeSave, spend, hud, audio, interior,
    getCharacter: () => save.character,
    onEquip: (id) => { if (id === player.rigChar) applyOutfit(player.rig, id, getEquipped(save, id)); if (isMP()) multiplayer?.sendLook(); },
    onClose: () => input.lock(),
  });
  seller = makeRig('skier_green', 'rental');
  seller.setSkisVisible(false);
  seller.addTo(scene);
  {
    const b = village.booth;
    // behind the ticket window (the booth's left opening as you face it, ~1 m left of its middle), inside the booth:
    // the 1.2 m sill hides the legs (the counter point is 1.2 m in front of the facade)
    const p = b.counter.clone().addScaledVector(b.front, -1.95).add(new THREE.Vector3(-b.front.z, 0, b.front.x).multiplyScalar(1.04));
    seller.root.position.set(p.x, world.height(p.x, p.z), p.z);
    sellerHeading = Math.atan2(b.front.x, b.front.z);
    colliders.push({ x: p.x, z: p.z, r: 0.35 });
  }

  // odd jobs for money: a few job boards (village + summit huts); everything else exists only while a job runs
  talk = new Talk({ camera, player, hud, colliders, blockers: village.cameraBlockers, vegetation });
  jobs = new Jobs({ scene, models, player, hud, audio, save, writeSave, earn: (amount, label) => earn(amount, label), layout, makeRig, talk });
  // heli-skiing: the helipad + the helicopter you fly yourself (every collider exists by now)
  heli = new Heli({ scene, models, player, input, camera, hud, audio, spray, world, layout, colliders, spend, transition, lifts });
  sleds = new Snowmobiles({ scene, models, player, camera, hud, audio, spray, trails, layout, colliders, vegetation, world }); // parked all round the resort (up to 40: lifts, huts, Express stations, race starts and finishes)
  // cars on the roads (needs the player: it keeps away from you and stops for you)
  try { traffic = new Traffic({ scene, models, colliders, player, camera, skibus, makeRig }); } catch (e) { console.warn('traffic: ' + (e?.stack || e)); traffic = null; }
  if (traffic && skibus?.line) skibus.line.traffic = traffic; // (the bus slows behind cars)
  try { drive = new Drive({ scene, player, camera, hud, audio, colliders, vegetation, parking, transition, world, cameraBlockers: village.cameraBlockers, traffic, trails, freeRide: () => started && !modes?.active && !races?.active }); } catch (e) { console.warn('drive: ' + (e?.stack || e)); drive = null; }
  try {
    carRental = new CarRental({ scene, camera, renderer, models, colliders, cameraBlockers: village.cameraBlockers, parking, drive, traffic, hud, audio, save, writeSave, spend, transition, player, input,
      makeRig: () => makeRig('skier_orange', 'rental'), getPost: () => post });
  } catch (e) { console.warn('car rental: ' + (e?.stack || e)); carRental = null; }
  try { chalets = new Chalets({ scene, camera, renderer, colliders, cameraBlockers: village.cameraBlockers, hud, audio, save, writeSave, spend, transition, player, getPost: () => post, getHour: () => env.hour }); } catch (e) { console.warn('chalets: ' + (e?.stack || e)); chalets = null; }
  seating.init({ save, chaletAPI: chaletInteriorAPI, catalog: FURNITURE_BY_ID, chalets });
  seating.setVillage((x, z) => world.height(x, z), CHALET_HX);
  // admin panel: money, time / weather, teleports, unlocks, speed boost, HUD, free camera (ui/admin.js)
  admin = new AdminPanel({
    save, writeSave, hud, audio, env, layout, input, camera, transition, streamAround, equipSkis,
    ctx: { get player() { return player; }, get modes() { return modes; }, get races() { return races; }, get interior() { return interior; }, get heli() { return heli; }, get sleds() { return sleds; },
      get lifts() { return lifts; }, get skibus() { return skibus; }, get jobs() { return jobs; }, get started() { return started; }, get paused() { return paused; },
      get secrets() { return secrets; }, get railway() { return railway; }, get carRental() { return carRental; }, get drive() { return drive; }, get chalets() { return chalets; } },
  });

  // multiplayer: the session object (nothing connects until MULTIPLAYER in the menu)
  try {
    multiplayer = new Multiplayer({
      save, hud, audio, env, camera, scene, getEquipped, colliders,
      makeRig: (c, s) => makeRig(c, s, { poles: true, ai: true }), applyOutfit,
      fx: (id, r, info, dt) => skierFX(trails, spray, id, r, info, dt),
      pose: mpPose, getScene: mpScene, setAI: setAIOn, applySave: applyMpSave, onLost: (why) => leaveMultiplayer(why),
      onRaceStart: mpRaceStart, onKickInterior: mpKickInterior,
    });
    multiplayer.attachTransit({ railway, express, lifts, skibus, player, expressRate: EXPRESS_FAST }); // (shared trains / cabins: net/transit.js)
  } catch (e) { console.warn('multiplayer: ' + (e?.stack || e)); multiplayer = null; }

  // getting hit by a moving vehicle on foot or on skis (a wipeout: a strike; 50+ km/h brings the rescue helicopter).
  // Free ride outdoors only: never seated, riding, driving, inside, or in a race session.
  try {
    const vehicleSources = { traffic: null, skibus: null, carRental: null, snowcats: null, multiplayer: null };
    vehicleHits = new VehicleHits({
      player, audio,
      sources: () => {
        const S = vehicleSources;
        S.traffic = traffic; S.skibus = skibus; S.carRental = carRental; S.snowcats = snowcats; S.multiplayer = isMP() ? multiplayer : null;
        return S;
      },
      enabled: () => started && !paused && !busIntro && !modes?.active && !interior.active && !chalets?.inside && !carRental?.inside
        && !heli.active && !sleds.active && !drive?.active && !seating.seated && !transition.active && !skibus?.riding
        && !railway?.riding && !express?.riding && !player.frozen,
    });
  } catch (e) { console.warn('vehicle hits: ' + (e?.stack || e)); vehicleHits = null; }

  // the RACING stand beside the village job board is gone (Oct 29, the user: "remove this racing day sign");
  // races are the free-ride races at the courses' start houses

  // continue where you were (save.pos, kept while you play free ride): the pre-stream below streams around it
  restoreSpot();

  // pre-stream the world around the start
  setLoad(0.7, 'Streaming terrain…');
  let guard = 0;
  while (terrain.update(player.pos.x, player.pos.z, 40) > 0 && guard++ < 400) {
    setLoad(0.7 + Math.min(0.15, guard / 600), 'Streaming terrain…');
    await new Promise((r) => setTimeout(r, 0));
  }
  setLoad(0.86, 'Planting trees…');
  guard = 0;
  while (vegetation.update(player.pos.x, player.pos.z, 0, 40) > 0 && guard++ < 200) {
    await new Promise((r) => setTimeout(r, 0));
  }
  // props onto the ground as drawn, now that every terrain edit is in (world/settle.js: no floating downhill sides)
  if (new URLSearchParams(location.search).has('settle')) console.info('Props settled', JSON.stringify(settleProps([village.group, decor.group, dressing, jobs.group]))); // (off until checked in game: ?settle)
  // graphics preset for the hand-placed props (LOD distances, small-on-screen culling, shadow range)
  const own = new Set([terrain.group, backdrop.group, pisteLights.group, player.rig.root, player.rig.gear, seller.root, seller.gear]);
  for (const o of scene.children) if ((o.isGroup || o.isMesh) && !own.has(o) && !o.isInstancedMesh) propDetail.add(o);
  // the one-off outfit zone analysis of both player bodies runs behind the loading bar (no hitch on MAN / WOMAN)
  for (const c of PLAYER_CHARACTERS) outfitZones(c.id === save.character ? player.rig : makeRig(c.id, 'rental'));
  setLoad(0.95, 'Compiling shaders…');
  env.update(0.016, camera, player.pos);
  player.update(0.016);
  renderer.compile(scene, camera);
  setLoad(1, 'Ready');
  player.rigChar = save.character;
  menu.setReady();
  window.__game.ready = true;
  requestAnimationFrame(loop);
}

// Stream terrain + trees around a point (behind a loading card or a fade).
async function streamAround(x, z) {
  let guard = 0;
  while (terrain.update(x, z, 40) > 0 && guard++ < 400) await new Promise((r) => setTimeout(r, 0));
  guard = 0;
  while (vegetation.update(x, z, 0, 40) > 0 && guard++ < 200) await new Promise((r) => setTimeout(r, 0));
}

// ------------------------------------------------------------------ where you are, kept in the save
// (Oct 29, the user: "make it so you keep the location you are at when you quit the game"): save.pos = { x, z, y, h,
// skis }, your last outdoor free-ride spot on foot or skis (driving: where you'd step out of the car). Not taken
// inside the shop / car rental / a chalet, in a race or mode, on a lift, bus, train, snowmobile or the helicopter, in
// a fall or a jump, or in the menus: then the last good spot stays. Restored at launch and at PLAY from the main menu;
// a new game (reset save) has none, so it starts in Legacy Village.
const SPOT_LIMIT = 12000;
function outdoorSpot() {
  if (isMP()) return null; // (where you were is single player only)
  if (!started || busIntro || !player || wipeoutBusy || transition?.active) return null;
  if (modes?.active || races?.active) return null;
  if (interior?.active || chalets?.inside || carRental?.inside) return null;
  if (heliRiding() || sleds?.active) return null;
  if (drive?.active) {
    try { const sp = drive.exitSpot(drive.d); return { x: sp.x, z: sp.z, y: drive.d.y, h: sp.heading, skis: false }; } catch { return null; }
  }
  if ((player.mode !== 'walk' && player.mode !== 'ski') || player.air || player.frozen || player.seat) return null;
  return { x: player.pos.x, z: player.pos.z, y: player.pos.y, h: player.heading, skis: player.mode === 'ski' && !!player.skisOn };
}
function rememberSpot() {
  try {
    const sp = outdoorSpot();
    if (!sp || ![sp.x, sp.z, sp.y, sp.h].every(Number.isFinite)) return;
    const r = (v) => Math.round(v * 100) / 100;
    save.pos = { x: r(sp.x), z: r(sp.z), y: r(sp.y), h: r(sp.h), skis: sp.skis };
  } catch { /* (the last good spot stays) */ }
}
// the saved spot if it is still a good place to stand (in the world, on the ground, not in a building / tree / car)
function savedSpot() {
  const sp = save.pos;
  if (!sp || typeof sp !== 'object' || ![sp.x, sp.z, sp.h].every(Number.isFinite)) return null;
  if (Math.abs(sp.x) > SPOT_LIMIT || Math.abs(sp.z) > SPOT_LIMIT) return null;
  try {
    const g = world.groundHeight(sp.x, sp.z, Number.isFinite(sp.y) ? sp.y + 0.5 : Infinity);
    if (!Number.isFinite(g)) return null;
    if (drive?.clearAt && !drive.clearAt(sp.x, sp.z, 0.3)) return null;
    const y = Number.isFinite(sp.y) && Math.abs(g - sp.y) < 3 ? sp.y : undefined;
    return { x: sp.x, z: sp.z, y, h: sp.h, skis: !!sp.skis };
  } catch { return null; }
}
// put the player at the saved spot (no streaming: callers stream around it); false = none, the normal spawn stays
function restoreSpot() {
  const sp = savedSpot();
  if (!sp) { if (save.pos) save.pos = null; return false; }
  try {
    player.frozen = false;
    player.setSkisOn(false);
    player.teleport(sp.x, sp.z, sp.h, sp.y);
    if (sp.skis && player.hasSkis && !player.isFlatHere?.()) player.setSkisOn(true);
    player.rig?.setSkisVisible?.(player.hasSkis);
    player.resumed = true;
    return true;
  } catch (e) { console.warn('restore spot', e); player.teleport(4, 34, Math.PI); player.resumed = false; return false; }
}
function persistSpot() { rememberSpot(); writeSave(); }
addEventListener('beforeunload', persistSpot);
addEventListener('pagehide', persistSpot);
document.addEventListener('visibilitychange', () => { if (document.hidden && started) persistSpot(); });

// Wipeout in free ride: let the tumble play out until you lie in the snow, fade out, wake up in Legacy Village.
let wipeoutBusy = false;
// train PA (public/audio/voice/rail_*.m4a): a chime and the line in German and English as the train departs,
// on the way to the next stop and on arrival; each line once per ride, never over another one
const RAIL_KEY = { Wolkensee: 'wolkensee', Wolkenplatt: 'wolkenplatt', 'Legacy Village': 'village' };
let railAnn = { said: new Set(), pending: [], t: 0 };
function trainAnnounce(hint) {
  try {
    const now = performance.now();
    if (now - railAnn.t > 3000) railAnn = { said: new Set(), pending: [], t: now }; // (a new ride)
    railAnn.t = now;
    let key = null, m;
    if (!hint) { /* nothing new */ }
    else if ((m = /departing for (.+)$/.exec(hint))) key = /Legacy Village/.test(m[1]) ? 'rail_dep_down' : 'rail_dep_up';
    else if ((m = /next stop ([^·]+?) ·/.exec(hint))) key = RAIL_KEY[m[1].trim()] ? `rail_next_${RAIL_KEY[m[1].trim()]}` : null;
    else if ((m = /^(.+?) · (arrived|press E to get off here)/.exec(hint))) key = RAIL_KEY[m[1].trim()] ? `rail_arr_${RAIL_KEY[m[1].trim()]}` : null;
    if (key && !railAnn.said.has(key)) { railAnn.said.add(key); railAnn.pending.push(key); }
    if (railAnn.pending.length && !audio.speaking && audio.announce(railAnn.pending[0])) railAnn.pending.shift();
  } catch { /* the PA never breaks the ride */ }
}
// Legacy Express PA (Oct 27, the user: "add the voice for departure on the train and next stop etc"): the gong and the
// line in German and English in the computer's voices (audio.pa), as the train departs, before each stop and at it;
// each once per ride, never over another one (or over the Wolkenspitzbahn's)
let expressAnn = { said: new Set(), pending: [], t: 0 };
function expressAnnounce(hint) {
  try {
    const now = performance.now();
    if (now - expressAnn.t > 3000) expressAnn = { said: new Set(), pending: [], t: now }; // (a new ride)
    expressAnn.t = now;
    let m, key = null, lines = null;
    if (!hint) { /* nothing new */ }
    else if ((m = /^Legacy Express to (.+?) · departs in/.exec(hint))) {
      key = 'dep'; lines = [{ lang: 'de', text: `Legacy Express nach ${m[1]}. Bitte einsteigen.` }, { lang: 'en', text: `Legacy Express to ${m[1]}. Please board, the doors are closing.` }];
    } else if ((m = /next stop (.+?) · \d+ min/.exec(hint))) {
      key = `next:${m[1]}`; lines = [{ lang: 'de', text: `Nächster Halt: ${m[1]}.` }, { lang: 'en', text: `Next stop: ${m[1]}.` }];
    } else if ((m = /^(.+?) · press E to get off here/.exec(hint))) {
      key = `at:${m[1]}`; lines = [{ lang: 'de', text: `${m[1]}.` }, { lang: 'en', text: `${m[1]}.` }];
    } else if ((m = /^(.+?) · arrived/.exec(hint))) {
      key = `arr:${m[1]}`; lines = [{ lang: 'de', text: `${m[1]}. Bitte aussteigen.` }, { lang: 'en', text: `${m[1]}. This is your stop, please mind the gap.` }];
    }
    if (key && !expressAnn.said.has(key)) { expressAnn.said.add(key); expressAnn.pending.push(lines); }
    if (expressAnn.pending.length && !audio.speaking && !audio.paSpeaking && audio.pa(expressAnn.pending[0])) expressAnn.pending.shift();
  } catch { /* the PA never breaks the ride */ }
}
// riding: the ride's hint for the top-left card (its speed is on the speedometer); hold Space fast-forwards
function rideText(h) { return h ? `${h.replace(/ · \d+ km\/h/, '')} · hold Space to speed up` : null; }
// the speedometer's label while you ride something instead of your skis
function vehicleName() {
  if (railway?.riding) return 'Wolkenspitzbahn';
  if (express?.riding) return 'Legacy Express';
  if (skibus?.riding) return 'Ski bus';
  if (drive?.active) return drive.label; // (the car and its gear: "BMW X3 · D")
  if (sleds?.active) return 'Snowmobile';
  if (heli?.active) return 'Helicopter';
  return null;
}
// free-ride wipeouts: strike one you get up, strike two the rescue helicopter comes (reset by a lift ride or 3 min)
let strikes = 0, lastStrikeAt = -1e9;
const STRIKE_RESET_MS = 180000;
async function wipeoutToVillage() {
  if (wipeoutBusy) return;
  wipeoutBusy = true;
  const t0 = performance.now();
  while (player.mode === 'fall' && player.fall?.state === 'tumble' && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 450));
  await transition.fade(async () => {
    returnToVillage('Wipeout · back in Legacy Village');
    await streamAround(player.pos.x, player.pos.z);
  });
  wipeoutBusy = false;
}

// Leave the menu and drop into the world.
function startGame() {
  if (started) return;
  if (player.rig && save.character !== player.rigChar) swapCharacter(save.character);
  player.camYaw = player.resumed ? player.heading + Math.PI : 0; player.camPitch = -0.12; // (continued: the camera behind you)
  player.resumed = false;
  menu.hide();
  hud.show();
  hud.setMoney(save.money);
  audio.init();
  input.lock();
  started = true;
  writeSave();
  audio.music('freeride');
  if (!player.hasSkis) {
    setTimeout(() => hud.flash('Welcome to Legacy Village', 'good', 3000), 600);
    audio.announce('welcome', { delay: 0.6 });
  }
}

// Menu PLAY / START: always free ride in Legacy Village (no mode chooser: RACE is at the RACING stand there).
async function startFromMenu(sel = {}) {
  if (sel.character && sel.character !== save.character) { save.character = sel.character; writeSave(); }
  // a new skier chosen from the pause menu's SETTINGS: swap in place and play on
  if (started) { if (player.rig && save.character !== player.rigChar) swapCharacter(save.character); menu.hide(); closePause(); return; }
  // (Oct 29, the user: no bus intro: a new game starts straight in Legacy Village)
  // back from the main menu: on where you were (the menu waits in the village); streamed behind the menu
  const sp = savedSpot();
  if (sp && Math.hypot(player.pos.x - sp.x, player.pos.z - sp.z) > 3 && restoreSpot()) {
    await streamAround(player.pos.x, player.pos.z);
    if (started) return;
  }
  startGame();
}
// (Oct 28, the user: "the intro is super bad, it doesn't look like the game at all: you're just in the bus and you
// get driven there, no waiting at the bus stop, no green; you sit in the bus until you arrive at Legacy Village, no
// teleport"): the game's own ski bus, from the farthest stop it can reach, to the village stop in
// real time (hold Space to fast-forward; ~8 min at most); you get off there as after any bus ride
function playBusIntro() {
  save.introBus = true;
  const stops = skibus.stops || [];
  const village = stops.slice().sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
  let from = null;
  try {
    from = village && stops.filter((st) => st !== village && skibus.canRide(st, village))
      .map((st) => ({ st, min: skibus.route(st, village).min })).filter((o) => o.min <= 8)
      .sort((a, b) => b.min - a.min)[0]?.st;
  } catch (e) { console.warn('bus intro', e); }
  startGame();
  if (from) boardBus(from, village);
}

// E at the RACING stand: pick a course and the AI difficulty, then RACE exactly as the old menu option did
// (teleport to the course, 14 AI). Just for fun: RACE pays nothing (prize money: the start houses in free ride).
const RS_PREFS = 'ski-legacy-racestand';
function openRaceStand() {
  if (!raceStandUI || modes.active) return;
  let pr = {};
  try { pr = JSON.parse(localStorage.getItem(RS_PREFS) || '{}') || {}; } catch { /* storage unavailable */ }
  player.vel.set(0, 0, 0);
  raceStandUI.open({
    courses: modes.list(), courseId: pr.course, difficulty: pr.difficulty,
    close: () => input.lock(),
    start: (courseId, difficulty) => {
      try { localStorage.setItem(RS_PREFS, JSON.stringify({ course: courseId, difficulty })); } catch { /* storage unavailable */ }
      jobs.onEvent('teleport'); // a running delivery / rescue ends when you leave for a race
      if (outfitShop?.isOpen) outfitShop.close();
      player.frozen = false;
      modes.start({ courseId, difficulty }).then(() => input.lock(), (err) => { console.warn('stand race', err); input.lock(); });
    },
  });
}

// A fun race's VILLAGE (results / pause): back in free ride in front of the RACING stand (called behind a fade).
async function backToStand() {
  const r = raceStand?.returnPoint() || { x: 4, z: 34, heading: Math.PI };
  player.frozen = false;
  player.setSkisOn(false);
  player.teleport(r.x, r.z, r.heading);
  raceHud.hide();
  await streamAround(player.pos.x, player.pos.z);
  audio.music('freeride');
  hud.flash('Back in Legacy Village · Racing', 'good', 2400);
}

// Back to the main menu over the panorama (called behind a fade): the player waits in the village.
async function backToMenu(opts = {}) {
  if (!opts.mp) rememberSpot(); // (where you were: PLAY, or the next launch, carries on from there; never a multiplayer spot)
  if (outfitShop?.isOpen) outfitShop.close();
  heli.abort();
  if (races.active) races.abort();
  if (player.mode === 'sit') { lifts.ride = null; railway.abort(); express?.abort(); skibus.abort(); sleds.abort(); drive?.abort(); player.seat = null; player.mode = 'walk'; player.rig.root.visible = true; player.rig.gear.visible = true; }
  if (interior.active) { interior.active = false; post.setView(scene, camera); document.getElementById('crosshair').hidden = true; }
  carRental?.leave(true);
  chalets?.leave(true);
  player.frozen = false;
  player.setSkisOn(false);
  player.teleport(4, 34, Math.PI);
  await streamAround(player.pos.x, player.pos.z);
  started = false;
  paused = false;
  hud.el.hidden = true;
  raceHud.hide();
  // (the main menu is always single player: a multiplayer session ends here, the local save comes back)
  const wasMP = isMP();
  if (wasMP) { multiplayer?.leave(); env.hour = save.hour ?? env.hour; env.weatherTimer = 75; }
  if (!opts.mp && !wasMP) save.hour = freeRideHour() ?? env.hour;
  writeSave();
  document.exitPointerLock?.();
  menu.show();
  audio.music('menu');
}

// Pause menu -> MAIN MENU (from free ride or from a race session).
function goToMainMenu() {
  paused = false;
  audio.setPaused(false);
  menu.hidePause();
  if (modes.active) modes.leave();
  else transition.fade(backToMenu);
}

function swapCharacter(id) {
  const old = player.rig;
  old.removeFrom(scene);
  const rig = makeRig(id, save.skis || 'rental', { poles: true });
  applyOutfit(rig, id, getEquipped(save, id));
  rig.addTo(scene);
  player.rig = rig;
  player.setSkisOn(player.skisOn);
  player.rigChar = id;
  if (isMP()) multiplayer?.sendLook();
}

// ------------------------------------------------------------------ economy actions
function spend(amount) {
  if (save.money < amount) { hud.flash(`Not enough money ($${amount} needed)`, 'bad'); audio.play('error'); return false; }
  save.money -= amount;
  hud.setMoney(save.money, -amount);
  audio.play('cash');
  writeSave();
  return true;
}
function earn(amount, label, source = 'job') {
  if (!amount) return;
  // multiplayer: the server pays (jobs, secrets: limits per payout and per hour); race prizes come from its results
  if (isMP()) { multiplayer?.earn(amount, source).then((ok) => { if (ok) { hud.setMoney(save.money, amount); audio.play('cash'); } }); return; }
  save.money += amount;
  save.stats.earned += amount;
  hud.setMoney(save.money, amount);
  audio.play('cash');
  writeSave();
}

function equipSkis(id) {
  const s = skiById(id);
  save.skis = id;
  player.ski = s;
  player.hasSkis = true;
  player.rig.setSkiModel(models[s.model] || models[s.fallback] || models.ski_pro);
  player.setSkisOn(player.skisOn);
  writeSave();
  if (isMP()) multiplayer?.sendLook();
}

function hasPass() { return save.dayPass === save.day; }

// through the shop door: a quick dip to dark covers the swap between the village and the shop scene
function enterShop() {
  if (interior.active || transition.active) return;
  player.frozen = true;
  audio.play('click');
  transition.fade(() => {
    interior.enter();
    post.setView(interior.scene, interior.camera);
    document.getElementById('crosshair').hidden = false;
  });
}

function exitShop() {
  if (!interior.active || transition.active) return;
  if (outfitShop?.isOpen) outfitShop.close();
  audio.play('click');
  transition.fade(() => {
    interior.active = false;
    post.setView(scene, camera);
    document.getElementById('crosshair').hidden = true;
    player.frozen = false;
    const d = village.shopDoor, f = village.shopFront;
    // step out a couple of meters; the camera looks back at you with the shop behind
    player.teleport(d.x + f.x * 2.2, d.z + f.z * 2.2, Math.atan2(f.x, f.z));
    player.camYaw = Math.atan2(f.x, f.z) + 0.5;
    player.camPitch = -0.12;
    player.camPos.copy(player.pos).add(new THREE.Vector3(Math.sin(player.camYaw) * 4, 1.8, Math.cos(player.camYaw) * 4));
  }).then(() => { if (player.hasSkis && !player.skisOn) setTimeout(() => hud.flash('Press G to put your skis on', 'good', 2600), 300); });
}

function shopAction(t) {
  if (!t) return;
  if (t.kind === 'door') return exitShop();
  if (t.kind === 'clerk') {
    // the conversation look from outside (cinema bars, the card beside a portrait of the clerk)
    talk.ensureDom?.();
    interior.talkView?.(true);
    return hud.dialog('<span class="talk-name">Shop clerk</span><span class="talk-role">Ski Rental &amp; Shop</span>', player.hasSkis
      ? 'Back for an upgrade? Faster skis glide a little quicker and hold an edge better.'
      : 'Grüezi! You have everything except skis. The rental pair is on the left; the race skis are further along the wall.',
    [{ label: 'Thanks' }]);
  }
  const s = skiById(t.id);
  if (save.skis === s.id) return;
  if (save.owned.includes(s.id)) { equipSkis(s.id); hud.flash(`${s.name} equipped`, 'good'); return; }
  if (isMP()) { // (the server sells them)
    multiplayer?.buySkis(s.id).then((ok) => { if (ok) { equipSkis(s.id); hud.flash(s.rent ? `${s.name} rented` : `${s.name} purchased`, 'gold', 2200); } });
    return;
  }
  if (!spend(s.price)) return;
  save.owned.push(s.id);
  equipSkis(s.id);
  hud.flash(s.rent ? `${s.name} rented` : `${s.name} purchased`, 'gold', 2200);
}

function talkToSeller() {
  const pass = hasPass();
  talk.say({ id: seller, anchor: seller.root.position, rig: seller }, { name: 'Ticket seller', role: 'Legacy Gondola' },
    pass ? 'Your day pass is good until midnight. Enjoy the mountain!' : 'Grüezi! Where are you headed today?', [
    { label: 'Day pass', sub: pass ? 'active' : `$${PRICES.dayPass} · unlimited rides today`, disabled: pass || save.money < PRICES.dayPass,
      act: () => { if (spend(PRICES.dayPass)) { save.dayPass = save.day; writeSave(); hud.flash('Day pass active', 'gold'); } } },
    { label: 'Gondola ticket', sub: `$${PRICES.gondola} · one ride to the summit`, state: pass ? 'Day pass' : '', disabled: pass || save.money < PRICES.gondola,
      act: () => { if (spend(PRICES.gondola)) { save.tickets = (save.tickets || 0) + 1; writeSave(); hud.flash('Gondola ticket bought', 'gold'); } } },
    { label: 'Nothing, thanks' },
  ]);
}

function boardLift(st) {
  const line = st.line;
  if (!player.hasSkis) { hud.flash('Rent skis first', 'bad'); audio.play('error'); return; }
  if (isMP() && !multiplayer.transit.liftGate(st, () => boardLift(st))) return; // (multiplayer: a seat in the next cabin, when it is there)
  const useTicket = !hasPass() && st.up && line.spec.main && (save.tickets || 0) > 0;
  const free = hasPass() || !st.up || useTicket; // riding the gondola down is free
  const price = line.spec.price;
  if (useTicket) { save.tickets--; writeSave(); }
  if (!free && !spend(price)) return;
  if (!player.skisOn) player.setSkisOn(true);
  const seat = lifts.board(line, st.up, st.stop || null);
  player.sitOn(seat);
  jobs.onEvent('lift', { line });
  // skis ride in the gondola's outside rack; on chairlifts they stay on your feet
  if (line.spec.type === 'gondola') {
    player.rig.setSkisVisible(false);
    // ride the gondola in 3rd person (the cabin interior isn't meant to be seen up close)
    player.viewBeforeRide = player.view;
    player.view = 'third';
  }
  if (line.spec.main) gondolaRides++;
  audio.play('board');
  hud.flash(free ? `${line.spec.name}${hasPass() ? ' · Day pass' : ''}` : `${line.spec.name} · -$${price}`, 'good');
}

// step out of a cabin / chair at a station (or the mid-station) and carry on
function leaveLift(exit, stopName) {
  player.standUp(exit.x, exit.z, exit.heading);
  player.rig.setSkisVisible(player.hasSkis);
  if (player.viewBeforeRide) { player.view = player.viewBeforeRide; player.viewBeforeRide = null; }
  lifts.timeScale = 1;
  hud.flash(stopName ? `Off at ${stopName}` : 'Arrived', 'good');
}

// ------------------------------------------------------------------ the Wolkenspitzbahn
function openRail(rw) {
  if (CARD_DIALOG) return openRailMap(rw);
  if (rw.options.length === 1) return boardRail(rw.station, rw.options[0].up);
  hud.dialog('Wolkenspitzbahn', `${rw.station.name}. Which way?`, [
    ...rw.options.map((o) => ({ label: o.label, act: () => { boardRail(rw.station, o.up); input.lock(); } })),
    { label: 'Not now', act: () => input.lock() },
  ]);
}
// the line on the map: every other station, the ride time, uphill $RAIL_PRICE (or the day pass), downhill free
function openRailMap(rw) {
  const st = rw.station, pass = hasPass(), R = layout.railway;
  const at = (id) => R?.stations.find((s) => s.id === id) || {};
  const dests = railway.destinations(st.id).map((d) => ({
    name: d.name, x: at(d.id).x, z: at(d.id).z, path: d.pts, meta: `${fmtMin(d.min)} · ${d.km.toFixed(1)} km · ${d.up ? 'uphill' : 'downhill'}`,
    price: d.up && !pass ? RAIL_PRICE : undefined, tag: !d.up ? 'FREE' : pass ? 'DAY PASS' : undefined, short: d.up && !pass && save.money < RAIL_PRICE,
    act: () => { boardRail(st, d.up, d.id); input.lock(); },
  }));
  travelPicker({ hud, player, audio }).open({
    mode: 'route', title: 'Wolkenspitzbahn', kicker: pass ? 'DAY PASS ACTIVE' : `UPHILL $${RAIL_PRICE} · DOWNHILL FREE`, sub: `From <b>${at(st.id).name || st.name}</b> · pick your stop`,
    lineStyle: 'rail', lines: R ? [R.pts] : [], stops: R?.stations || [], from: { name: at(st.id).name || st.name, x: at(st.id).x, z: at(st.id).z },
    dests, go: 'RIDE', goLabel: (d) => `Ride to ${d.name.replace(/ Gondola$/, '')}`,
  });
}
function boardRail(st, up, dest = null) {
  if (isMP() && !multiplayer.transit.railGate(st, up, dest, () => boardRail(st, up, dest))) return; // (multiplayer: wait for the train, a seat in it)
  if (up && !hasPass() && !spend(RAIL_PRICE)) return;
  jobs.onEvent('lift', { rail: true });
  const to = dest ? layout.railway?.stations.find((s) => s.id === dest)?.name : null;
  transition.fade(async () => {
    const seat = railway.board(st.id, up, dest);
    if (dynRes.pr < dynRes.max) { dynRes.pr = dynRes.max; setRenderScale(dynRes.max); } // sharp in the train
    player.sitOn(seat);
    player.viewBeforeRide = player.view; // R switches the train's seat / outside view instead
    player.lampBeforeRide = player.headlampOn; player.headlampOn = false; // (no headlamp beam inside the cabin)
    player.rig.root.visible = false; player.rig.gear.visible = false; // you are the passenger in the window seat
    railway.update(0, { viewer: seat.pos });
    await streamAround(seat.pos.x, seat.pos.z);
  });
  audio.play('board');
  hud.flash(up ? `Wolkenspitzbahn to ${to || 'Wolkenplatt'}${hasPass() ? ' · Day pass' : ` · -$${RAIL_PRICE}`}` : `Wolkenspitzbahn to ${to || 'Legacy Village'}`, 'good', 2600);
}
function leaveRail(exit) {
  if (!exit) return;
  transition.fade(async () => {
    railway.abort();
    player.standUp(exit.x, exit.z, exit.heading);
    player.rig.root.visible = true; player.rig.gear.visible = true;
    player.rig.setSkisVisible(player.hasSkis);
    if (player.viewBeforeRide) { player.view = player.viewBeforeRide; player.viewBeforeRide = null; }
    player.headlampOn = player.lampBeforeRide; player.lampBeforeRide = undefined;
    await streamAround(exit.x, exit.z);
  });
  hud.flash(exit.name ? `${exit.name}` : 'Arrived', 'good', 2400);
}

// ------------------------------------------------------------------ the Legacy Express
// E on a station's platform (every race has one beside its start; the village's is by the ski shop): the route
// picker with every other station and its race (its difficulty, the prize, the ride time the shorter way round, the
// fare: $EXPRESS_PRICE or the day pass); the races first, nearest first, the village last. You board the train
// standing at the platform; if it is not in yet you wait there for it (it comes in within the minute)
function openExpress(it) {
  const from = it.from, pass = hasPass(), X = layout.express;
  const list = express.destinations(from.id).sort((a, b) => (!a.course - !b.course) || a.min - b.min);
  const dests = list.map((d) => {
    const e = d.course;
    return {
      name: d.st.name, x: d.st.x, z: d.st.z, path: d.pts, color: e?.D.color, race: e?.id,
      meta: e ? `${e.D.label} · up to $${e.rewardMax.toLocaleString('en-US')} prize · ${fmtMin(d.min)}` : `${fmtMin(d.min)} · ${d.km.toFixed(0)} km · the ski shop`,
      price: pass ? undefined : EXPRESS_PRICE, tag: pass ? 'DAY PASS' : undefined, short: !pass && save.money < EXPRESS_PRICE,
      act: () => { boardExpress(from, d.st); input.lock(); }, info: d,
    };
  });
  const cell = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  travelPicker({ hud, player, audio }).open({
    mode: 'route', title: 'Legacy Express', kicker: pass ? 'DAY PASS ACTIVE · 300 KM/H' : `$${EXPRESS_PRICE} TO ANY RACE · 300 KM/H`,
    sub: `From <b>${from.name}</b> · pick your station`, listHead: 'STATIONS',
    lineStyle: 'express', lines: X ? [X.pts] : [], stops: X?.stations || [], from: { name: from.name, x: from.x, z: from.z },
    dests, go: 'RIDE', goLabel: (d) => `Ride to ${d.name.replace(/ (Giant Slalom|Slalom|Super-G|Downhill)$/, '')}`,
    plan: (d) => {
      const i = d.info, e = i.course;
      return `<div class="tp-name" style="color:${e ? e.D.color : 'inherit'}">${e ? e.D.label : 'Legacy Village'}</div><div class="tp-grid">${cell('RIDE', `${Math.max(1, Math.round(i.min))}<small>min</small>`)}${cell('STOPS', i.stops)}${e ? cell('PRIZE', `≤$${e.rewardMax.toLocaleString('en-US')}`) : cell('KM', i.km.toFixed(0))}</div>`;
    },
  });
}
// the train for `to` stands at the platform: pay and step in (a short fade into the seat); not in yet: wait on the
// platform for it (the loop boards you as it stops: express.waiting)
function boardExpress(from, to) {
  if (!express.trainIn(from.id, to.id)) {
    if (!hasPass() && save.money < EXPRESS_PRICE) { spend(EXPRESS_PRICE); return; } // (not enough money: says so)
    const wait = express.waitFor(from.id, to.id);
    hud.flash(`Legacy Express to ${to.name} · due in ${Math.max(1, Math.ceil(wait ?? 30))} s · wait on the platform`, 'good', 3200);
    return;
  }
  if (isMP() && !multiplayer.transit.expressGate(from, to, () => boardExpress(from, to))) return; // (multiplayer: a seat in it first)
  if (!hasPass() && !spend(EXPRESS_PRICE)) { express.cancelWait(); return; }
  jobs.onEvent('lift', { rail: true });
  transition.fade(async () => {
    const seat = express.board(from.id, to.id);
    if (!seat) return;
    if (dynRes.pr < dynRes.max) { dynRes.pr = dynRes.max; setRenderScale(dynRes.max); } // sharp in the train
    player.sitOn(seat);
    player.viewBeforeRide = player.view; // R switches the train's seat / outside view instead
    player.lampBeforeRide = player.headlampOn; player.headlampOn = false;
    player.rig.root.visible = false; player.rig.gear.visible = false; // you are the passenger in the panorama row
    express.update(0, { viewer: seat.pos });
  });
  audio.play('board');
  hud.flash(`Legacy Express to ${to.name}${hasPass() ? ' · Day pass' : ` · -$${EXPRESS_PRICE}`}`, 'good', 2600);
}
// off the train onto the platform of that station, beside your car (express.arrival): from there you walk (to the
// race's start beside the station, into the village)
async function exitExpress(a) {
  express.abort();
  player.rig.root.visible = true; player.rig.gear.visible = true;
  if (player.viewBeforeRide) { player.view = player.viewBeforeRide; player.viewBeforeRide = null; }
  player.headlampOn = player.lampBeforeRide; player.lampBeforeRide = undefined;
  player.standUp(a.exit.x, a.exit.z, a.exit.heading);
  player.rig.setSkisVisible(player.hasSkis);
  await streamAround(a.exit.x, a.exit.z);
  const e = a.course ? freeCourses().find((c) => c.id === a.course) : null;
  hud.flash(e ? `${a.name} · the start is beside the station` : `${a.name} · Legacy Express`, 'good', 3000);
}
function leaveExpress(a) {
  if (!a) return;
  transition.fade(() => exitExpress(a));
}

// A free-ride race on a World Racing course (E at its start house, modes/parkour/freeworld.js): the podium's
// prize money and the stats ("Races won"), paid once per run when the results card comes up (session.js)
function courseResult(e, { place, dnf }, ai = 'medium') {
  save.stats.races = (save.stats.races || 0) + 1;
  if (place === 1 && !dnf) save.stats.wins = (save.stats.wins || 0) + 1;
  const prize = races.prize(e, place, dnf, ai); // (scaled by the AI field you picked: freeworld.js AI_LEVELS)
  if (prize > 0) earn(prize);
  try { crowds?.cheer(e.finish.x, e.finish.z); } catch (err) { /* (cosmetic) */ }
  writeSave();
  return prize;
}

// E at a course's start house: the race card (entry fee, the AI field and its prize money, your best), then the same
// race as RACE mode right here on the mountain; after the finish you ski on from the finish area
function courseInteraction(e) {
  if (isMP()) return mpCourseInteraction(e);
  const firstFree = (save.stats.races || 0) === 0; // your first race is on the house
  return {
    label: `${e.name} · ${e.D.label} · up to $${e.rewardMax.toLocaleString('en-US')}${firstFree ? ' · first race free' : ''}`,
    act: () => {
      if (!player.hasSkis) { hud.flash('You need skis to race', 'bad'); return; }
      player.vel.set(0, 0, 0);
      player.frozen = true; // stop at the start while deciding
      const fee = firstFree ? 0 : e.D.entry;
      // the AI field: the one you raced last (save.raceAi), else the course's own suggestion; the prizes follow it
      const ai = { levels: AI_LEVELS, pick: AI_LEVELS.some((l) => l.key === save.raceAi) ? save.raceAi : e.D.ai, prizeOf: (k) => prizeFor(e, k) };
      const card = { name: e.name, D: { ...e.D, entry: fee }, reward: e.reward, shares: PRIZE_SHARE, length: e.length, gates: e.course.gates || [], ai };
      hud.raceIntro(card, save.records?.[e.id]?.best, {
        onClose: () => { if (!modes.active) player.frozen = false; },
        onStart: (pick = e.D.ai) => {
          if (fee && !spend(fee)) { player.frozen = false; return; }
          if (firstFree) hud.flash('First race is free · good luck!', 'gold', 2200);
          if (!player.skisOn) player.setSkisOn(true);
          save.raceAi = pick;
          const lvl = aiLevel(pick);
          transition.fade(() => modes.startFree(e.id, {
            difficulty: lvl.key, prizeMult: lvl.mult, result: (r) => courseResult(e, r, lvl.key), retry: () => !e.D.entry || spend(e.D.entry),
          })).then(() => input.lock(), (err) => { console.warn('free-ride race', err); player.frozen = false; });
        },
      });
    },
  };
}

// ------------------------------------------------------------------ ski bus
function openBus(stop) {
  if (CARD_DIALOG) return openBusMap(stop);
  hud.dialog('Ski bus', 'Free shuttle between Legacy Village and every gondola. Where to?', [
    ...skibus.destinations(stop).map(({ stop: d, km }) => ({ label: d.name, sub: `${km.toFixed(1)} km`, act: () => rideBus(d, stop) })),
    { label: 'Stay here', act: () => input.lock() },
  ]);
}
// the bus network on the map: every other stop with the way there, the ride time (free shuttle)
// the stops the bus really drives to from `stop` (over the plowed roads)
function busDests(stop) { return skibus.destinations(stop).map(({ stop: d }) => d).filter((d) => skibus.canRide(stop, d)); }
function openBusMap(stop) {
  // only stops the bus can drive to are listed (a stop with no road can't be reached by bus at all)
  const dests = busDests(stop).map((d) => {
    const r = skibus.route(stop, d);
    return { name: d.name, x: d.x, z: d.z, path: r.pts, meta: `${fmtMin(r.min)} ride · ${r.km.toFixed(1)} km`, tag: 'FREE', act: () => rideBus(d, stop) };
  });
  if (!dests.length) { hud.flash('No bus from here', 'bad', 2400); return; }
  travelPicker({ hud, player, audio }).open({
    mode: 'route', title: 'Ski bus', kicker: 'FREE SHUTTLE', sub: `From <b>${stop.name}</b> · pick your stop`,
    lineStyle: 'bus', lines: skibus.networkLines(), stops: skibus.stops, from: stop, dests, go: 'RIDE',
    goLabel: (d) => `Ride to ${d.name.replace(/ Gondola$/, '')}`,
  });
}
// a gondola's mid-station: the line with its three stations, up (price / day pass) or down (free)
function openLiftMap(st) {
  const line = st.line, s = line.spec, m = line.mid, pass = hasPass();
  const base = s.name.replace(/ Gondola$/, '');
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  const top = { name: cap(s.topName || `${base} summit`), x: s.top.x, z: s.top.z }, bot = { name: cap(s.bottomName || `${base} base`), x: s.bottom.x, z: s.bottom.z };
  const mid = { name: m.name, x: m.x, z: m.z };
  const time = (s0, d) => (line.travelTime ? line.travelTime(s0, d) / 60 : 0);
  const go = (up) => () => { boardLift({ ...st, up }); input.lock(); };
  travelPicker({ hud, player, audio }).open({
    mode: 'route', title: s.name, kicker: 'MID-STATION', sub: `From <b>${m.name}</b> · up or down?`,
    lineStyle: 'lift', lines: [[[s.bottom.x, s.bottom.z], [s.top.x, s.top.z]]], stops: [bot, mid, top], from: mid,
    dests: [
      { ...top, path: [[m.x, m.z], [top.x, top.z]], meta: `${fmtMin(time(m.u, line.L - m.u))} · up`, price: pass ? undefined : s.price, tag: pass ? 'DAY PASS' : undefined, short: !pass && save.money < s.price, act: go(true) },
      { ...bot, path: [[m.x, m.z], [bot.x, bot.z]], meta: `${fmtMin(time(2 * line.L - m.u, m.u))} · down`, tag: 'FREE', act: go(false) },
    ],
    go: 'RIDE', goLabel: (d) => `Ride to ${d.name.replace(/ Gondola$/, '')}`,
  });
}
// a mountain hut's counter: hot chocolate
function openHut(it) {
  let h = null, bd = Infinity;
  for (const q of layout.huts) { const d = Math.hypot(q.x - it.x, q.z - it.z); if (d < bd) { bd = d; h = q; } }
  const p = PRICES.hotChocolate;
  hud.dialog(h?.name || 'Gipfel Hütte', 'Warm up by the stove before the next run.', [
    { label: 'Hot chocolate', sub: 'Hot and sweet, with whipped cream', price: p, disabled: save.money < p, act: () => { if (spend(p)) hud.flash('Hot chocolate', 'gold', 2000); input.lock(); } },
    { label: 'Not now', act: () => input.lock() },
  ], { kicker: 'MOUNTAIN HUT' });
}
async function rideBus(dest, from = null) {
  // the real ride: the bus drives you there over the plowed roads (skibus.js BUS_RIDE)
  if (from && skibus.canRide(from, dest)) { boardBus(from, dest); return; }
  // no road there at all: the branded travel card (as for World Racing) covers the transfer and says so
  await transition.teleport(dest.name, async () => {
    if (races.active) races.abort();
    player.setSkisOn(false);
    // step off the bus in front of the stop, camera behind you
    const x = dest.x + Math.sin(dest.heading) * 2.5, z = dest.z + Math.cos(dest.heading) * 2.5;
    player.teleport(x, z, dest.heading);
    player.camYaw = dest.heading + Math.PI;
    await streamAround(x, z);
  }, { kicker: 'SKI BUS · NO ROAD THERE · QUICK TRANSFER' });
  hud.flash(`Ski bus · ${dest.name}`, 'good', 2200);
  input.lock();
}

function boardBus(from, dest) {
  if (isMP() && !multiplayer.transit.busGate(from, dest, () => boardBus(from, dest))) return; // (multiplayer: wait for a shared bus, a seat in it)
  transition.fade(async () => {
    if (races.active) races.abort();
    const seat = skibus.board(from, dest);
    if (!seat) return;
    player.setSkisOn(false);
    player.sitOn(seat);
    player.viewBeforeRide = player.view; // R switches the bus's seat / outside view instead
    player.lampBeforeRide = player.headlampOn; player.headlampOn = false;
    player.rig.root.visible = false; player.rig.gear.visible = false; // you are the passenger by the window
    await streamAround(seat.pos.x, seat.pos.z);
  });
  audio.play('board');
  hud.flash(`Ski bus to ${dest.name}`, 'good', 2400);
  input.lock();
}
function leaveBus(exit) {
  if (!exit) return;
  transition.fade(async () => {
    skibus.abort();
    player.standUp(exit.x, exit.z, exit.heading);
    player.rig.root.visible = true; player.rig.gear.visible = true;
    player.rig.setSkisVisible(player.hasSkis);
    if (player.viewBeforeRide) { player.view = player.viewBeforeRide; player.viewBeforeRide = null; }
    player.headlampOn = player.lampBeforeRide; player.lampBeforeRide = undefined;
    await streamAround(exit.x, exit.z);
  });
  hud.flash(`Ski bus · ${exit.name}`, 'good', 2400);
}

// ------------------------------------------------------------------ multiplayer (net/session.js, docs/multiplayer.md)
// PLAY -> MULTIPLAYER: your unique name on first launch, then log in, join a world (max 15) and drop into the
// village with the server's save. No AI in multiplayer (traffic, resort skiers, crowds, snowcats, race bots); jobs
// stay. LEAVE MULTIPLAYER (pause menu) or a lost connection: back to the main menu with the single-player save.
let mpCancelled = false;
const EMPTY_PEOPLE = [];
async function startMultiplayer(sel = {}) {
  if (!multiplayer) { menu.mpError('Multiplayer is not available'); return; }
  if (started) return;
  if (sel.character && sel.character !== save.character) { save.character = sel.character; writeSave(); }
  if (!multiplayer.account()) { menu.mpName(); return; }
  mpCancelled = false;
  menu.mpStatus('Connecting to the server…');
  try {
    const d = await multiplayer.start();
    if (mpCancelled) { multiplayer.leave(); return; }
    menu.mpStatus(`World ${d.world.id} · ${d.world.players.length}/${d.world.max} players`);
    // (no "where you were" in multiplayer: everyone starts in Legacy Village)
    player.frozen = false;
    player.setSkisOn(false);
    player.teleport(4, 34, Math.PI);
    player.resumed = false;
    await streamAround(player.pos.x, player.pos.z);
    if (mpCancelled || !isMP()) { multiplayer.leave(); return; }
    startGame();
    hud.flash(`Multiplayer · world ${d.world.id} · ${d.world.players.length}/${d.world.max} players`, 'good', 3200);
  } catch (e) {
    if (mpCancelled) return;
    if (isMP()) multiplayer.leave(); else net.close('failed');
    if (e.code === 'bad_login' || e.code === 'no_account') { menu.mpName(errText(e)); return; }
    menu.mpError(errText(e));
  }
}
async function mpRegister(name) {
  mpCancelled = false;
  menu.mpStatus('Checking your name…');
  try {
    await multiplayer.register(name);
    if (!mpCancelled) startMultiplayer({});
  } catch (e) {
    if (mpCancelled) return;
    net.close('failed');
    if (['name_taken', 'name_invalid', 'rate'].includes(e.code)) menu.mpName(errText(e));
    else menu.mpError(errText(e));
  }
}
// LEAVE MULTIPLAYER, or the connection is gone (message: shown in the menu)
let mpLeaving = false;
function leaveMultiplayer(message = null) {
  if (mpLeaving) return;
  if (!started) { multiplayer?.leave(); if (message) menu.mpError(message); return; }
  mpLeaving = true;
  paused = false;
  audio.setPaused(false);
  menu.hidePause();
  transition.fade(async () => {
    if (modes.active) { modes.end(); modes.unload?.(); modes.current = null; }
    await backToMenu({ mp: true });
    multiplayer?.leave();
    env.hour = save.hour ?? env.hour;
    env.weatherTimer = 75;
    if (message) menu.mpError(message);
  }).finally(() => { mpLeaving = false; });
}
// AI on / off (multiplayer: only real players and the shared transport)
function setAIOn(on) {
  try { traffic?.setOff(!on); } catch (e) { console.warn('mp traffic', e); }
  try { npcs?.setOff(!on); } catch (e) { console.warn('mp npcs', e); }
  try { snowcats?.setOff(!on); } catch (e) { console.warn('mp snowcats', e); }
  if (crowds?.group) crowds.group.visible = on;
  if (express) express.noPassengers = !on; // (the trains' seated passengers)
  if (railway) { railway.noPassengers = !on; if (railway.people?.group) railway.people.group.visible = on; }
  if (modes) modes.botCount = on ? undefined : 0; // (race sessions: no AI field)
  player.people = on ? () => npcs.near : () => EMPTY_PEOPLE;
}
// the swapped save (multiplayer profile <-> single-player save): the player, the rental car, the hooks follow it
function applyMpSave() {
  const on = isMP();
  try {
    player.hasSkis = !!save.skis;
    if (save.skis) player.ski = skiById(save.skis) || player.ski;
    swapCharacter(save.character); // (a fresh rig: skis model and outfit from this save)
    player.setSkisOn(false);
    player.rig.setSkisVisible(player.hasSkis);
  } catch (e) { console.warn('mp player', e); }
  hud.setMoney(save.money);
  try { carRental?.resync(); } catch (e) { console.warn('mp rental', e); }
  if (chalets) chalets.mp = on ? {
    ownerOf: (id) => { const o = MP.chalets?.[id]; return o && o !== MP.name ? o : null; },
    visit: (h, owner) => mpVisitChalet(h, owner),
    buy: (h) => multiplayer.buyChalet(h),
  } : null;
  if (carRental) carRental.mp = on ? {
    rent: (cfg) => multiplayer.rentCar(cfg).then((car) => { if (car) carRental.placeRented({ ...cfg, ...car }); }),
    ended: (cfg) => multiplayer.carEnded(cfg),
    plateCheck: (p) => multiplayer.plateCheck(p), plateIssue: () => multiplayer.plateIssue(), // (the configurator: plates unique for everyone)
    tow: (kind, home, bay) => multiplayer.tow(kind, home, bay), towDone: () => multiplayer.towDone(), // (the tow truck: the fee and the impound on the server)
    carNear: (x, z, r) => multiplayer.carRide.carNear(x, z, r), // (an impound bay with another player's car in it)
  } : null;
  if (outfitShop) outfitShop.buyHook = on ? (id) => multiplayer.buyOutfit(id) : null;
}
// your presence for the other players (filled ~12x a second, no allocation)
const _mpDir = new THREE.Vector3();
function mpPose(o) {
  let cam = null, room = null;
  o.interior = null;
  if (interior.active) { o.interior = 'skishop'; cam = interior.camera; room = interior; }
  else if (carRental?.inside) { o.interior = 'carrental'; cam = carRental.room?.camera; room = carRental.room; }
  else if (chalets?.inside && chalets.current) { o.interior = `chalet:${chalets.current.id}`; cam = chalets.room?.camera; }
  if (room?.pos && Number.isFinite(room.yaw)) { // (the shop / rental: where you walk, not the camera, which swings off to a preview or the clerk)
    o.x = room.pos.x; o.y = room.pos.y || 0; o.z = room.pos.z; o.yaw = room.yaw;
    o.vx = room.vel?.x || 0; o.vy = 0; o.vz = room.vel?.z || 0; o.st = MPST.walk; o.crouch = 0; o.lean = 0; o.flags = 0;
    return;
  }
  if (cam) { // (inside: the interior's own camera is you)
    cam.getWorldDirection(_mpDir);
    o.x = cam.position.x; o.y = cam.position.y - 1.6; o.z = cam.position.z; o.yaw = Math.atan2(_mpDir.x, _mpDir.z);
    o.vx = 0; o.vy = 0; o.vz = 0; o.st = MPST.walk; o.crouch = 0; o.lean = 0; o.flags = 0;
    return;
  }
  const p = player;
  o.x = p.pos.x; o.y = p.pos.y; o.z = p.pos.z; o.yaw = p.heading;
  o.vx = p.vel.x; o.vy = p.vel.y; o.vz = p.vel.z;
  o.st = heli?.active ? MPST.fly : drive?.active || sleds?.active ? MPST.drive : railway?.riding || express?.riding || skibus?.riding ? MPST.ride
    : p.mode === 'sit' ? MPST.sit : p.mode === 'ski' ? MPST.ski : p.mode === 'fall' ? MPST.fall : MPST.walk;
  o.crouch = p.crouch || 0; o.lean = p.lean || 0;
  o.flags = (p.air ? MPF.air : 0) | (p.tuck ? MPF.tuck : 0) | (p.skisOn ? MPF.skisOn : 0) | (p.hasSkis && !p.skisOn ? MPF.carry : 0) | (p.hasSkis ? MPF.hasSkis : 0);
}
function mpScene(id) {
  if (id === 'skishop') return interior?.scene || null;
  if (id === 'carrental') return carRental?.room?.scene || null;
  if (id && id.startsWith('chalet:')) return chalets?.room?.scene || null;
  return null;
}
const mpViewState = { interior: null, camera: null };
function mpView() {
  const v = mpViewState;
  if (interior.active) { v.interior = 'skishop'; v.camera = interior.camera; }
  else if (carRental?.inside) { v.interior = 'carrental'; v.camera = carRental.room.camera; }
  else if (chalets?.inside && chalets.current) { v.interior = `chalet:${chalets.current.id}`; v.camera = chalets.room.camera; }
  // (a chalet door still fading: no change reported half-way; a visit's yes is single use and leaving would end it)
  else if (chalets?.busy && multiplayer?.interior?.startsWith?.('chalet:')) { v.interior = multiplayer.interior; v.camera = camera; }
  else { v.interior = null; v.camera = camera; }
  return v;
}
// a chalet that is somebody else's: ask them (they get Y / N), then in you go
async function mpVisitChalet(h, owner) {
  hud.flash(`Asking ${owner} to let you in…`, 'good', 2400);
  const r = await multiplayer.ask('chaletVisit', { ref: h.id });
  if (!r?.allow) { if (!r?.error) hud.flash(`${owner} did not let you in`, 'bad', 2600); return; }
  // (the furniture first: a yes is single use, and between the server letting you in and chalets.enter() no frame
  // may pass, or the presence loop would report you outside and use the visit up)
  const furniture = (await multiplayer.chaletFurniture(h.id)) || []; // (the owner's furniture: build mode shows it)
  if (!(await multiplayer.setInterior(`chalet:${h.id}`))) { hud.flash('Not allowed in', 'bad', 2200); return; }
  chalets.guestFurniture = furniture;
  chalets.viewing = h;
  chalets.enter(h);
}
function mpKickInterior(id) {
  if (chalets?.inside && id === `chalet:${chalets.current?.id}`) { chalets.leave(); hud.flash('The owner closed the door', 'bad', 2600); }
}
// a course's start house in multiplayer: the race queue (2+ players; 30 s once two are in; everyone in the world or
// 15 queued: at once). The start is the server's, the same moment for everyone; no AI field; the server pays
function mpCourseInteraction(e) {
  const q = multiplayer?.race.queued === e.id;
  const n = MP.queues?.get(e.id)?.n || 0;
  return {
    label: q ? `${e.name} · queued (${n}/${Math.max(2, n)}) · E to leave the queue` : `${e.name} · race other players${n ? ` · ${n} waiting` : ''} · up to $${Math.round(e.reward).toLocaleString('en-US')}`,
    act: () => {
      if (q) { multiplayer.raceLeave(); hud.flash('Left the race queue', 'good', 1800); return; }
      if (!player.hasSkis) { hud.flash('You need skis to race', 'bad'); return; }
      multiplayer.raceJoin(e.id);
    },
  };
}
function mpRaceStart(d) {
  const e = freeCourses().find((c) => c.id === d.race);
  if (!e || modes.active) return;
  jobs.onEvent('teleport');
  transition.fade(() => {
    // wherever you are (a lift, a car, the shop...): to the start gate
    if (outfitShop?.isOpen) outfitShop.close();
    heli.abort();
    if (player.mode === 'sit') { lifts.ride = null; railway.abort(); express?.abort(); skibus.abort(); sleds.abort(); drive?.abort(); player.seat = null; player.mode = 'walk'; player.rig.root.visible = true; player.rig.gear.visible = true; }
    if (interior.active) { interior.active = false; post.setView(scene, camera); document.getElementById('crosshair').hidden = true; }
    carRental?.leave(true);
    chalets?.leave(true);
    player.frozen = false;
    if (player.hasSkis && !player.skisOn) player.setSkisOn(true);
    return modes.startFree(e.id, { bots: 0, syncGo: d.secondsToGo, result: (r) => multiplayer.raceFinished(r), retry: () => false,
      grid: { slot: d.slot, n: d.n }, others: () => multiplayer.raceOthers(), mp: d.mp }); // (your grid slot; the other racers, the server's result)
  }).then(() => input.lock(), (err) => console.warn('multiplayer race', err));
}

// ------------------------------------------------------------------ interactions
function findInteraction() {
  const p = player.pos;
  if (player.mode === 'sit' || races.active || heli.rescuing) return null;
  const carPrompt = drive?.interaction(p);
  if (carPrompt) return carPrompt;
  const ride = isMP() ? multiplayer?.carInteraction(p) : null; // (multiplayer: "Ask <owner> for a ride" at their car)
  if (ride) return ride;
  const rental = carRental?.interaction(p); // the CAR RENTAL's door
  if (rental) return rental;
  const chalet = chalets?.interaction(p); // a chalet's front door (rent it / go in)
  if (chalet) return chalet;
  const sledPrompt = sleds.interaction(p);
  if (sledPrompt) return sledPrompt;
  const heliPrompt = heli.interaction(p);
  if (heliPrompt) return heliPrompt;
  const job = jobs.interaction(p);
  if (job) return job;
  const stand = raceStand?.interaction(p); // the RACING stand (RACE just for fun)
  if (stand) return stand;
  const seat = seating.interaction(player); // a bench, a deck chair... (game/seating.js)
  if (seat) return seat;
  for (const it of village.interactables) {
    if (Math.hypot(p.x - it.x, p.z - it.z) < it.r) {
      if (it.id === 'shop') return { label: 'Enter the ski shop', act: enterShop };
      if (it.id === 'tickets') return { label: 'Talk to the ticket seller', act: talkToSeller };
      if (it.id === 'hut') return CARD_DIALOG ? { label: `Mountain hut · hot chocolate $${PRICES.hotChocolate}`, act: () => openHut(it) }
        : { label: `Buy a hot chocolate ($${PRICES.hotChocolate})`, act: () => { if (spend(PRICES.hotChocolate)) hud.flash('Hot chocolate', 'gold', 2000); } };
    }
  }
  const stop = skibus.stopNear(p);
  if (stop && busDests(stop).length) return { label: 'Take the ski bus', act: () => openBus(stop) }; // (no road: no bus from here)
  const rw = railway.interaction(p, { hasPass: hasPass() });
  if (rw) return { label: rw.label, act: () => openRail(rw) };
  const ex = express?.interaction(p, { hasPass: hasPass() }); // a station's platform (waiting for your train: E cancels)
  if (ex) return { label: ex.label, act: () => { if (ex.cancel) { express.cancelWait(); hud.flash('Legacy Express · not waiting', 'good', 1600); } else openExpress(ex); } };
  const st = lifts.nearestStation(p);
  if (st && st.dist < (st.line.spec.type === 'gondola' ? 20 : 13)) {
    const s = st.line.spec;
    const price = hasPass() ? 'Day pass' : `$${s.price}`;
    if (st.stop) {
      return {
        label: `${st.stop.name} · ${s.name}`,
        act: () => CARD_DIALOG && st.line.mid ? openLiftMap(st) : hud.dialog(s.name, `${st.stop.name}. Which way?`, [
          ...st.options.map((o) => ({ label: o.label, sub: o.up ? price : 'free', act: () => { boardLift({ ...st, up: o.up }); input.lock(); } })),
          { label: 'Not now', act: () => input.lock() },
        ]),
      };
    }
    return { label: st.up ? `Ride ${s.name} · ${price}` : `Ride ${s.type === 'chair' ? s.name + ' ' : ''}down to ${s.bottomName || (s.main ? 'the village' : 'the valley')}`, act: () => boardLift(st) };
  }
  const course = races.nearStart(p); // a World Racing course's start house, on its mountain
  if (course) return courseInteraction(course);
  return null;
}

function objective() {
  const start = startObjective(save, player, buildMode); // rent a chalet -> furnish it -> rent skis
  if (start) return start;
  if (!player.hasSkis) return 'Rent skis at the ski shop';
  if (gondolaRides === 0 && Math.hypot(player.pos.x, player.pos.z) < 400 && save.stats.races === 0) return 'Take the gondola up the mountain';
  if (save.stats.wins === 0) return 'Find a race and win it';
  return '';
}

function locationName() {
  const p = player.pos;
  const secretHere = secrets?.locationName(); // inside a secret you have found
  if (secretHere) return secretHere;
  if (Math.hypot(p.x, p.z) < 260) return 'Legacy Village';
  for (const h of layout.huts) if (Math.hypot(p.x - h.x, p.z - h.z) < 140) return h.label || 'Summit · Gipfel Hütte';
  for (const l of layout.lifts) if (l.mid && Math.hypot(p.x - l.mid.x, p.z - l.mid.z) < 70) return l.mid.name;
  const c = world.corridorAt(p.x, p.z);
  if (c.d < 2 && c.kind === 'piste') {
    const seg = world.corridorGrid.get(Math.floor(p.x / 64) + ',' + Math.floor(p.z / 64))?.find((s) => s.meta);
    if (seg?.meta?.name) return seg.meta.park || seg.meta.lane ? seg.meta.name : `${seg.meta.name} piste`;
  }
  if (c.d < 2 && c.kind === 'race') {
    const seg = world.corridorGrid.get(Math.floor(p.x / 64) + ',' + Math.floor(p.z / 64))?.find((s) => s.kind === 'race');
    if (seg?.meta?.name) return `${seg.meta.name} course`;
  }
  return p.y > 900 ? 'High Alpine · Off-piste' : 'Backcountry';
}

function waypoint() {
  const p = player.pos;
  const to = (x, z, label) => ({ label, ang: Math.atan2(x - p.x, z - p.z), dist: Math.hypot(x - p.x, z - p.z) });
  const jw = jobs.waypoint(p);
  if (jw) return to(jw.x, jw.z, jw.label);
  // a place you marked on the trail map, until you get there
  const mk = trailMap?.target;
  if (mk && Math.hypot(mk.x - p.x, mk.z - p.z) < 30) { trailMap.target = null; hud.flash(`Arrived · ${mk.label}`, 'good', 2200); }
  else if (mk) return to(mk.x, mk.z, mk.label);
  if (!player.hasSkis && startObjective(save, player)?.startsWith('Rent a chalet')) { const cv = layout.chaletVillage; return cv ? to(cv.x, cv.z, 'Chalet village') : null; } // (the chalet village)
  if (!player.hasSkis) return to(village.shopDoor.x, village.shopDoor.z, 'Ski shop');
  const g = layout.lifts[0];
  if (gondolaRides === 0 && Math.hypot(p.x, p.z) < 400 && save.stats.races === 0) return to(g.bottom.x, g.bottom.z, 'Gondola');
  // nothing else to point at: your own chalet, only once you're close by (the chalet village and the road beside
  // it, within ~350 m), until you're at its door
  const home = chalets?.inside ? null : chalets?.homeWaypoint?.();
  const dHome = home ? Math.hypot(home.x - p.x, home.z - p.z) : 0;
  if (home && dHome > 6 && dHome < 350) return to(home.x, home.z, home.label); // (only close by: the village and its road)
  return null;
}

// ------------------------------------------------------------------ map
// the trail map (M): a piste map of the live layout in the house style (ui/trailmap.js)
let trailMap = null;
function openMap() {
  trailMap ??= new TrailMap({
    player, locationName, onClose: () => input.lock(),
    markers: () => ({ jobs: jobs.mapMarkers(), heli: heli.mapMarkers(), secrets: secrets?.mapMarkers() || [],
      places: carRental?.door ? [{ x: carRental.door.x, z: carRental.door.z, label: 'Car Rental', kind: 'car' }] : [] }),
  });
  if (trailMap.toggle()) document.exitPointerLock?.();
}

let paused = false;
const heliRiding = () => !!heli && (heli.active || heli.rescuing || heli.state === 'boarding');
function openPause() {
  paused = true;
  audio.setPaused(true); // the whole soundscape and the music pause with the game
  hud.el.hidden = true;
  const inSession = modes.active;
  menu.showPause({
    onResume: closePause,
    onRestart: inSession && !isMP() ? () => { closePause(); modes.session?.restart?.(); } : undefined,
    // (a fun race from the RACING stand: RETURN TO VILLAGE takes you back to the stand)
    // (Oct 28, the user: no RETURN TO VILLAGE while you ride the helicopter: a heli-ski flight, boarding, or a rescue
    // with its ambulance ride)
    onVillage: heliRiding() ? undefined : !inSession ? () => { returnToVillage(); closePause(); } : modes.current && !modes.current.free ? () => { closePause(); modes.home(); } : undefined,
    onMainMenu: isMP() ? undefined : goToMainMenu,
    onLeaveMP: isMP() ? () => leaveMultiplayer() : undefined, // (multiplayer: LEAVE MULTIPLAYER instead of MAIN MENU)
    onQuit: () => { if (!isMP()) save.hour = freeRideHour() ?? env.hour; rememberSpot(); writeSave(); },
  });
}
function closePause() {
  paused = false;
  audio.setPaused(false);
  hud.el.hidden = false;
  menu.hidePause();
  input.lock();
}
// Ski bus back to Legacy Village from anywhere in the world.
function returnToVillage(message = 'Back in Legacy Village') {
  if (outfitShop?.isOpen) outfitShop.close();
  heli.abort();
  if (races.active) races.abort();
  if (player.mode === 'sit') { lifts.ride = null; railway.abort(); express?.abort(); skibus.abort(); sleds.abort(); drive?.abort(); player.seat = null; player.mode = 'walk'; player.rig.root.visible = true; player.rig.gear.visible = true; }
  player.frozen = false;
  if (interior.active) { interior.active = false; post.setView(scene, camera); document.getElementById('crosshair').hidden = true; }
  carRental?.leave(true);
  chalets?.leave(true);
  player.setSkisOn(false);
  player.teleport(4, 34, Math.PI);
  player.camYaw = 0;
  hud.flash(message, 'good', 2400);
}
addEventListener('keydown', (e) => { if (e.code === 'Escape' && paused) closePause(); });

// Overlays that free the mouse on purpose (panels, dialogs, map, admin, photo mode, outfits, conversations):
// opening one, or closing it with Esc, releases pointer lock too, and that must never open the pause menu
const overlayOpen = () => input.cursorFree || hud.panelOpen || !!trailMap?.isOpen || !!admin?.isOpen || !!photo?.active || !!outfitShop?.isOpen
  || !!talk?.active || !document.getElementById('map').hidden || document.getElementById('travel')?.hidden === false; // (travel: route / flight map pickers)
let escClosedAt = -1e9;
addEventListener('keydown', (e) => { if (e.code === 'Escape' && overlayOpen()) escClosedAt = performance.now(); }, true); // capture: before the overlay closes itself
document.addEventListener('pointerlockchange', () => {
  if (!started || document.pointerLockElement) return;
  if (overlayOpen() || performance.now() - escClosedAt < 700) return;
  if (!paused && !transition.active) openPause();
});
document.getElementById('panel').addEventListener('click', (e) => { if (e.target.id === 'panel') { hud.close(); input.lock(); } });
document.getElementById('map').addEventListener('click', () => { document.getElementById('map').hidden = true; input.lock(); });

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post?.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
// menu flyover: the village, Silberhorn (west), the Legacy main mountain, Adlerhorn (east), back to the village
const PANO_POS = new THREE.CatmullRomCurve3([
  new THREE.Vector3(260, 140, 320), new THREE.Vector3(-700, 260, 260), new THREE.Vector3(-1800, 520, -100),
  new THREE.Vector3(-1200, 950, -1400), new THREE.Vector3(300, 1050, -1300), new THREE.Vector3(1500, 700, -500),
  new THREE.Vector3(1200, 320, 600),
], true, 'centripetal');
const PANO_LOOK = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 700, -2350), new THREE.Vector3(-1600, 700, -900), new THREE.Vector3(-3170, 1100, -330),
  new THREE.Vector3(0, 1100, -2350), new THREE.Vector3(1800, 900, -900), new THREE.Vector3(3190, 1100, -800),
  new THREE.Vector3(0, 500, -1800),
], true, 'centripetal');
let titleT = 0.02, saveTimer = 0, spotTimer = 0, lastDay = env.hour, interaction = null, prevMode = null;
const tmpLight = new THREE.Color(), tmpLight2 = new THREE.Color();

// Dynamic resolution: hold the preset's frame rate by scaling the render resolution between its floor and its
// base scale. Coarse steps with hysteresis: every change reallocates the render targets.
const dynRes = { pr: 1, min: 1, max: 1, acc: 0, frames: 0, low: 0, high: 0 };
function resetDynRes() {
  dynRes.max = basePR();
  dynRes.min = Math.min(dynRes.max, Math.max(DPR * quality.dynMin, quality.dynFloor));
  dynRes.pr = dynRes.max;
  dynRes.low = dynRes.high = dynRes.acc = dynRes.frames = 0;
}
resetDynRes();
function setRenderScale(pr) {
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  post?.setSize(innerWidth, innerHeight);
}
function updateDynRes(dt) {
  dynRes.acc += dt; dynRes.frames++;
  if (dynRes.acc < 1) return;
  const fps = dynRes.frames / dynRes.acc;
  dynRes.acc = 0; dynRes.frames = 0;
  dynRes.low = fps < quality.fpsDrop ? dynRes.low + 1 : 0;
  dynRes.high = fps > quality.fpsRaise ? dynRes.high + 1 : 0;
  let pr = dynRes.pr;
  if (dynRes.low >= 2) pr -= fps < quality.fpsDrop * 0.7 ? 0.25 : 0.125;
  else if (dynRes.high >= 4) pr += 0.125;
  else return;
  dynRes.low = dynRes.high = 0;
  pr = Math.min(dynRes.max, Math.max(railway?.riding || express?.riding ? dynRes.max : dynRes.min, pr)); // (sharp while riding the train)
  if (Math.abs(pr - dynRes.pr) > 0.01) { dynRes.pr = pr; setRenderScale(pr); }
}

// Switch the graphics preset while playing (the auto-drop below). Systems that read `quality` as they update
// (terrain LOD, forests, clouds, snowfall, floodlights, skiers) follow by themselves.
function applyQuality(name, persist = true) {
  const soft = quality.shadow.soft;
  const q = setQuality(name);
  if (persist) { save.quality = q; writeSave(); } // (auto drops are not saved: one slow minute never sticks)
  if (soft !== quality.shadow.soft) {
    renderer.shadowMap.type = quality.shadow.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
  }
  env.setShadowQuality(quality.shadow);
  env.fogScale = quality.fog;
  post.dispose();
  post = new Post(renderer, scene, camera);
  if (interior.active) post.setView(interior.scene, interior.camera);
  if (carRental?.inside) post.setView(carRental.room.scene, carRental.room.camera);
  if (chalets?.inside) post.setView(chalets.room.scene, chalets.room.camera);
  resetDynRes();
  setRenderScale(menuRes && !started ? Math.min(dynRes.pr, 1.5) : dynRes.pr);
}

// The first seconds of play: averaging under 30 fps drops one preset (live, with a note), then measures again,
// for up to a minute. Not when the player picked the level in SETTINGS (or in automated tests).
const autoQ = { t: 0, frames: 0, windows: 0, done: !!navigator.webdriver };
function updateAutoQuality(dt) {
  if (autoQ.done) return;
  if (save.qualitySet === 'user') { autoQ.done = true; return; }
  autoQ.t += dt;
  if (autoQ.t < 2) return; // streaming and shader warm-up
  autoQ.frames++;
  if (autoQ.t < 12) return;
  const fps = autoQ.frames / (autoQ.t - 2), lower = lowerQuality(quality.name);
  if (fps < 30 && lower) {
    applyQuality(lower, false);
    hud.flash(`Graphics set to ${QUALITY_LABELS[lower]} for a smoother frame rate`, 'good', 3600);
    console.info(`Graphics: ${fps.toFixed(1)} fps -> ${lower}`);
  }
  autoQ.t = 0; autoQ.frames = 0;
  if (fps >= 30 || !lower || ++autoQ.windows >= 4) autoQ.done = true;
}
window.addEventListener('blur', () => { autoQ.t = 0; autoQ.frames = 0; }); // a hidden window says nothing about speed

// Menus stay instant: the paused world is frozen (re-rendered 4x/s only, so at full resolution: no blurry world
// behind the pause menu) and the title panorama runs at ~30 fps at up to 1.5x, so hovers and clicks never wait
// behind a heavy frame.
let lastRender = 0, menuRes = false;
function menuThrottle() {
  const inMenu = (!started && !busIntro) || paused;
  if (inMenu !== menuRes) {
    menuRes = inMenu;
    renderer.setPixelRatio(inMenu && !started ? Math.min(dynRes.pr, 1.5) : dynRes.pr);
    renderer.setSize(innerWidth, innerHeight);
    post?.setSize(innerWidth, innerHeight);
  }
  const now = performance.now(), gap = paused ? 250 : !started ? 30 : 0;
  if (gap && now - lastRender < gap) return true;
  lastRender = now;
  return false;
}

// Dev profiler: __game.profile(true) times every system in the loop (CPU ms per frame); off it costs nothing.
// ?perf=1 starts it with the page (dev measurements; without the flag nothing changes).
const prof = { on: new URLSearchParams(location.search).has('perf'), last: 0, t: {}, frames: 0 };
function mark(name) {
  if (!prof.on) return;
  const now = performance.now();
  prof.t[name] = (prof.t[name] || 0) + now - prof.last;
  prof.last = now;
}

// A system that throws must never freeze the picture (Oct 29: a throw in the chalet's build mode, every frame, skipped
// the render: a frozen picture, then black behind the pause menu). The update runs guarded, the render always
// follows; each fault is logged with its stack the first time, then at most every 10 s with a count.
const loopFaults = new Map();
function loopFault(where, e) {
  const k = `${where}: ${e?.message || e}`, f = loopFaults.get(k) || { n: 0, at: -1e9 }, now = performance.now();
  f.n++;
  if (now - f.at > 10000) { console.error(`[loop] ${where} failed${f.n > 1 ? ` (x${f.n})` : ''}:`, e); f.at = now; f.n = 0; }
  loopFaults.set(k, f);
}
function loop() {
  requestAnimationFrame(loop);
  if (menuThrottle()) return;
  let dt = 0;
  try { dt = loopUpdate(); } catch (e) { loopFault('update', e); }
  try {
    post.setSun(env.sunDir, tmpLight.copy(env.sun.color).multiplyScalar(env.sun.intensity), env.sunVisible * (1 - env.nightFactor));
    post.render(dt, player.mode === 'ski' ? player.speed : 0, player.mode === 'fall' ? Math.max(0, 1 - player.fallT * 2) : 0);
  } catch (e) { loopFault('render', e); }
  mark('render');
  input.endFrame();
}
// every system's update for one frame; returns the frame's dt (for the render)
function loopUpdate() {
  if (prof.on) { prof.last = performance.now(); prof.frames++; }
  const realDt = clock.getDelta(), rawDt = Math.min(0.05, realDt);
  if (started && !paused) { // paused frames are throttled on purpose
    const frameDt = Math.min(0.25, Math.max(realDt, 1 / 240)); // (a one-off streaming hitch says little)
    updateDynRes(frameDt);
    if (!hud.panelOpen && !interior.active) updateAutoQuality(frameDt);
  }
  const frozen = paused || !!photo?.active; // the world freezes while the pause menu / photo mode is open
  presentation.update(rawDt, { player, paused: frozen }); // slow-motion moments (big airs, photo finishes)
  const dt = frozen ? 0 : rawDt * presentation.timeScale;
  const menu = frozen || hud.panelOpen || !document.getElementById('map').hidden;
  input.enabled = started && !menu && !busIntro;
  const inSession = modes?.active; // RACE / WORLD RACING: the session runs the show

  if (interior.active) {
    shopTarget = interior.update(dt, menu ? { mdx: 0, mdy: 0, down: () => false } : input, save.sensitivity);
    if (!menu && shopTarget && input.hit('KeyE')) { audio.play('click'); shopAction(shopTarget); }
    interaction = null;
  } else if (chalets?.inside) { // inside a chalet (its own scene)
    try {
      chalets.frame(dt, menu || hud.panelOpen ? null : input, save.sensitivity);
      chaletSeatPrompt = seating.chaletFrame(menu || hud.panelOpen ? null : input, chalets.target, buildMode.on); // (sit on your furniture)
    } catch (e) { loopFault('chalet', e); }
    interaction = null;
  } else if (carRental?.inside) { // inside the CAR RENTAL (its own scene)
    seating.leftChalet();
    carRental.frame(dt, menu ? null : input, save.sensitivity);
    interaction = null;
  } else if (started && !menu && !busIntro) {
    seating.leftChalet();
    if (input.hit('KeyM') && !inSession) openMap();
    if (input.hit('KeyL')) player.headlampOn = !player.headlampOn;
    interaction = inSession ? null : findInteraction();
    if (interaction && input.hit('KeyE')) { audio.play('click'); interaction.act(); }
  }
  if (started) { try { buildMode.update(dt, input); } catch (e) { loopFault('build mode', e); } } // (no-op until you're inside your rented chalet)
  // the ticket seller idles at the booth window
  if (seller.root.position.distanceToSquared(player.pos) < 150 * 150) {
    seller.update(dt, { mode: 'idle', heading: talk.yawFor(seller, sellerHeading, dt), speed: 0, crouch: 0, lean: 0, plow: 0, normal: new THREE.Vector3(0, 1, 0) });
  }

  // day rollover -> new day, day pass expires
  if (env.hour < lastDay && !isMP()) { save.day++; writeSave(); } // (multiplayer: the world clock's day, net/session.js)
  lastDay = env.hour;
  mark('input');
  env.update(dt, camera, player.pos);
  mark('env');

  // lift riding: move the cars first, then seat the rider on the updated car (no lag)
  lifts.timeScale = player.mode === 'sit' && !seating.seated && !heli.active && !skibus.riding && !sleds.active && !drive?.active && input.down('Space') ? 16 : 1; // Space climbs in the helicopter
  lifts.update(dt, player.pos);
  mark('lifts');
  let rideLine = null, ridePrompt = null; // riding: the line for the top-left card, the stop to get off at (E)
  railway.update(dt, { viewer: camera.position, fast: railway.riding && !menu && input.down('Space'), player: railway.riding || express?.riding ? null : player.pos, audio }); // (player: the trains stop for you on the track)
  mark('railway');
  express?.update(dt, { viewer: camera.position, fast: express.riding && !menu && input.down('Space'), walker: player.mode !== 'sit' && !heli.active && !drive?.active && !sleds.active ? player.pos : null, player: railway.riding || express.riding ? null : player.pos, audio });
  if (express && !express.riding && express.wait && !transition.active) { // waiting on a platform for your train
    const w = express.wait, ws = express.waiting(player.pos);
    if (ws === 'ready') boardExpress(express.stations[w.from], express.stations[w.dest]);
    else if (ws === 'gone') hud.flash('Legacy Express · you left the platform', 'good', 1800);
  }
  mark('express');
  if (railway.riding) {
    const r = railway.updateRide();
    if (r?.seat) player.seat = r.seat; // (still seated while the arrival fades out)
    if (r?.exit) leaveRail(r.exit);
    else if (r?.stop && !menu && input.hit('KeyE')) leaveRail(railway.leaveAtStop());
    hud.rideHint(null); // (the ride's line goes in the top-left card, its stop in the E prompt, its speed in the speedometer)
    rideLine = r?.stop ? null : rideText(r?.hint);
    ridePrompt = r?.stop ? `Get off at ${r.stop.name}` : null;
    trainAnnounce(r?.hint);
  } else if (express?.riding) {
    const r = express.updateRide();
    if (r?.seat) player.seat = r.seat;
    if (r?.arrive) leaveExpress(r.arrive);
    else if (r?.stop && !menu && input.hit('KeyE')) leaveExpress(express.leaveAtStop());
    else if (!menu && !transition.active && !isMP() && input.hit('Enter')) transition.fade(async () => { const a = express.skip(); if (a) await exitExpress(a); }); // skip to the arrival (the train jumps on to your stop)
    hud.rideHint(null);
    rideLine = r?.stop ? null : r?.hint ? `${r.hint} · hold Space ×${EXPRESS_FAST}${isMP() ? '' : ' · Enter to skip'}` : null;
    ridePrompt = r?.stop ? `Get off at ${r.stop.name}` : null;
    expressAnnounce(r?.hint);
  } else if (skibus.riding) {
    const r = skibus.updateRide(dt, !menu && input.down('Space'));
    if (r?.seat) player.seat = r.seat;
    if (r?.exit) leaveBus(r.exit);
    hud.rideHint(null);
    rideLine = rideText(r?.hint);
  } else if (seating.seated) { // on a bench / a chair: E or a move key stands you up
    ridePrompt = seating.updateSeated(dt, input, menu);
    hud.rideHint(null);
  } else if (player.mode === 'sit') {
    const r = lifts.updateRide();
    if (r?.seat) {
      player.seat = r.seat;
      // passing through a mid-station: E gets you off here
      if (r.stop && !menu && input.hit('KeyE')) {
        const ex = lifts.leaveAtStop();
        if (ex) leaveLift(ex, r.stop.name);
      }
    } else if (r?.exit) leaveLift(r.exit, null);
    hud.rideHint(null);
    if (player.mode === 'sit') { rideLine = r?.stop ? null : rideText(lifts.ride?.line.spec.name); ridePrompt = r?.stop ? `Get off at ${r.stop.name}` : null; }
  } else hud.rideHint(null);
  mark('ride');

  player.update(dt);
  if (railway.riding) railway.applyCamera(camera, { ...input, hit: (c) => input.hit(c), sensitivity: player.sensitivity, mdx: menu ? 0 : input.mdx, mdy: menu ? 0 : input.mdy, wheel: input.wheel }, dt);
  if (express?.riding) express.applyCamera(camera, { hit: (c) => input.hit(c), sensitivity: player.sensitivity, mdx: menu ? 0 : input.mdx, mdy: menu ? 0 : input.mdy, wheel: input.wheel }, dt);
  if (skibus.riding) skibus.applyCamera(camera, { hit: (c) => input.hit(c), sensitivity: player.sensitivity, mdx: menu ? 0 : input.mdx, mdy: menu ? 0 : input.mdy, wheel: input.wheel }, dt);
  mark('player');
  if (multiplayer && isMP()) multiplayer.update(rawDt, mpView()); // presence out, remote players, shared clock, money guard
  mark('mp');
  // the helicopter: your flight (seat, controls, chase camera) or its trip home; parked: the pad and windsock
  heli.update(dt, started && !menu && !inSession ? input : null);
  mark('heli');
  sleds.update(dt, started && !menu && !inSession ? input : null); // driving: the sled, your seat on it, its chase camera
  mark('sleds');
  skibus?.updateFleet(dt, player.pos); // the other buses on their rounds (bus.js)
  traffic?.update(dt); // cars on the roads (after you moved: they stop for you)
  mark('traffic');
  drive?.update(dt, started && !menu && !inSession ? input : null); // the car you drive: physics, cameras, sound
  if (isMP()) multiplayer?.late(dt, started && !menu && !inSession ? input : null); // (riders in your car; you in theirs)
  carRental?.update(dt); // the tow truck, the rental's sign at night
  chalets?.update(dt); // the full-detail chalet nearest you
  try { vehicleHits?.update(dt); } catch (e) { loopFault('vehicle hits', e); } // after every vehicle moved: a car / bus running into you
  mark('drive');
  modes.update(dt, input); // after the player (positions, checkpoints, barriers, respawns)
  mark('modes');
  jobFrame.active = started && !paused && !inSession && !interior.active; // the map / dialogs don't stop the job clock
  jobs.update(dt, jobFrame);
  mark('jobs');
  talk.update(dt); // after the player's camera and the people: the conversation shot, the person talking
  admin.update(dt); // speed boost; the free-fly camera takes over the view
  races.update(dt, player); // the courses on the mountains: meshes built / dropped by distance (guarded inside)
  mark('game');
  npcs.update(dt, player.pos, env, camera);
  mark('npcs');
  const fastRide = heli.active || !!express?.riding; // (a fast trip: a bigger streaming budget, ahead of it)
  const streamAt = admin.streamPos || (express?.riding ? express.streamPos : null) || heli.streamPos; // ahead of the helicopter / the express / free camera, otherwise where you are
  terrain.update(streamAt.x, streamAt.z, fastRide ? 8 : 5);
  mark('terrain');
  vegetation.update(streamAt.x, streamAt.z, dt, fastRide ? 4 : 3);
  mark('vegetation');
  atmosphere.update(dt, camera, env);
  mark('atmosphere');
  village.update(dt, env, spray, player.pos);
  mark('village');
  decor.update(dt, Math.max(env.nightFactor, (1 - env.dayFactor) * 0.6));
  dressing.userData.setNight?.(Math.max(env.nightFactor, (1 - env.dayFactor) * 0.6)); // same as the village signs
  dressing.userData.update?.(camera.position); // hides far net chunks (fewer draw calls)
  mark('dressing');

  // inside the cloud layer: whiteout
  scene.fog.near += atmosphere.cloudInside * 0.012;
  terrainUniforms.uSnowCover.value = env.snowCover ?? env.snow; // fresh snow builds up while it snows (sky.js)
  terrainUniforms.uSparkle.value = env.dayFactor * (1 - env.snow * 0.7) + env.nightFactor * 0.25;

  // snow FX for the player
  const info = { grounded: player.mode === 'ski' && !player.air, speed: player.speed, vel: player.vel, sideslip: player.sideslip, plow: player.plow, lean: player.lean };
  skierFX(trails, spray, 0, player.rig, info, dt);
  player._wasAir = player.air;
  if (player.events.length) {
    for (const e of player.events) if (e === 'tooFlat') hud.flash('Too flat to ski here — walk to a slope or a lift', 'bad', 2400);
    else if (e === 'skisOff') hud.flash('Skis off — walk on the flat (G to put them on at a slope)', 'good', 2600);
    else if (e === 'tooSteep') hud.flash('Too steep to walk up — take a lift or the ski bus', 'bad', 2400);
    // ('bump': knocked over running into somebody, game/peoplehits.js: you just get up, no strike)
    else if (e === 'crash') {
      // sessions respawn at the checkpoint, open-world races fade back; free ride: you get up after the
      // first wipeout, the second (within 3 min, no lift ride between) calls the rescue helicopter
      const hitBy = vehicleHits?.take(); // (knocked over by a vehicle, game/vehiclehits.js; a hard hit: the helicopter at once)
      if (!inSession) {
        jobs.onEvent('crash');
        if (performance.now() - lastStrikeAt > STRIKE_RESET_MS) strikes = 0;
        lastStrikeAt = performance.now();
        const what = hitBy ? `Hit by a ${hitBy.what} · ${hitBy.kmh} km/h` : 'Wipeout';
        if (hitBy?.hard) strikes = Math.max(strikes, 1); // (a big crash: this one calls the rescue helicopter)
        if (races.active) { hud.flash(what, 'bad'); wipeoutToVillage(); }
        else if (++strikes < 2) hud.flash(`${what} · one more and the rescue helicopter comes`, 'bad', 3200);
        else {
          strikes = 0;
          hud.flash(`${what} · the rescue helicopter is on its way`, 'bad', 3200);
          if (!heli.rescueMe({ fallback: wipeoutToVillage })) wipeoutToVillage();
        }
      }
    }
    player.events.length = 0;
  }
  prevMode = player.mode;
  if (player.mode === 'sit' && !sleds.active && !drive?.active) strikes = 0; // a lift ride starts a fresh run (a snowmobile or a car doesn't)
  trails.update(dt, env.snow, env); // env: sun + sky light for the snow marks
  tmpLight.copy(env.hemi.color).multiplyScalar(0.25 + env.dayFactor * 0.75).add(tmpLight2.copy(env.sun.color).multiplyScalar(env.sun.intensity * 0.12));
  spray.update(dt, tmpLight);
  mark('fx');

  // headlamp (auto at night unless toggled off)
  // headlamp: off in the helicopter (it has its own landing light) and on floodlit pistes
  const lampOn = !heli.active && !sleds.active && !drive?.active && (player.headlampOn ?? (env.nightFactor > 0.5 && pisteLights.litAt(player.pos.x, player.pos.z) < 0.2));
  headlamp.update(dt, { on: lampOn, rig: player.rig, camera, firstPerson: player.view === 'first', env, pos: player.pos });
  mark('headlamp');

  // audio
  audio.setState({
    speed: heli.active ? heli.speed * 0.35 : player.mode === 'sit' ? 4 : player.speed, grounded: !player.air, sideslip: player.sideslip + player.plow * 0.5,
    skiing: player.mode === 'ski', riding: player.mode === 'sit' && !heli.active && !sleds.active && !drive?.active, altitude: player.pos.y, snow: env.snow,
  });

  // HUD
  if (started) {
    const ski = player.hasSkis ? skiById(save.skis)?.name : '';
    const weather = env.weather === 'clear' && env.nightFactor > 0.5 ? 'Clear night' : env.weatherLabel;
    const cd = camera.getWorldDirection(new THREE.Vector3());
    const camYaw = Math.atan2(cd.x, cd.z);
    if (interior.active) {
      hud.frame({
        speed: 0, loc: 'Ski Rental & Shop', time: env.timeString, weather, ski, heading: 0, waypoint: null,
        prompt: shopTarget?.label || null, objective: player.hasSkis ? '' : 'Look at a pair of skis and press E',
      });
    } else if (chalets?.inside) {
      hud.frame({ speed: 0, loc: chalets.roomName(), time: env.timeString, weather, ski, heading: 0, waypoint: null, prompt: chalets.target?.label || chaletSeatPrompt || null, objective: objective() || '' });
    } else if (carRental?.inside) {
      hud.frame({ speed: 0, loc: 'Car Rental', time: env.timeString, weather, ski, heading: 0, waypoint: null, prompt: carRental.target?.label || null, objective: carRental.current ? '' : 'Look at a car or the clerk and press E' });
    } else if (inSession) hud.frame({
      speed: player.speed, loc: modes.course?.name || 'World Racing', time: env.timeString, weather, ski,
      prompt: null, objective: '', heading: camYaw, waypoint: null,
    });
    else hud.frame({
      speed: railway.riding ? railway.speed : express?.riding ? express.speed : skibus.riding ? skibus.speed : drive?.active ? drive.speed : sleds.active ? sleds.speed : heli.active ? heli.speed : player.mode === 'walk' ? 0 : player.speed, loc: (express?.riding && express.locName()) || railway.locName(player.pos) || express?.locName(player.pos) || locationName(), time: env.timeString, weather,
      ski: vehicleName() || (player.skisOn || !player.hasSkis ? ski : `${ski} (off)`),
      prompt: ridePrompt || interaction?.label || (player.hasSkis && !player.skisOn && player.mode === 'walk' && !player.isFlatHere() ? 'Put on skis' : null), promptKey: ridePrompt || interaction ? 'E' : 'G', objective: races.active ? '' : (rideLine || heli.hudLine() || sleds.hudLine() || jobs.hudLine() || objective()),
      heading: camYaw, waypoint: races.active ? null : heli.active ? heli.waypoint(player.pos) || waypoint() : waypoint(), // (also while riding: train, bus, lifts, snowmobile)
      speedo: player.mode !== 'sit' || railway.riding || !!express?.riding || skibus.riding || sleds.active || heli.active || !!drive?.active, // (vehicles show their own speed; chairs and gondolas don't)
    });
    if (player.mode === 'ski') save.stats.distance += player.speed * dt;
    save.stats.topSpeed = Math.max(save.stats.topSpeed, player.topSpeed);
    bests?.update(dt, inSession || !!races.active || heli.active);
    saveTimer += dt;
    spotTimer += dt;
    if (spotTimer > 1) { spotTimer = 0; rememberSpot(); } // (written with the save below, and on quit)
    if (saveTimer > 5) { saveTimer = 0; save.hour = freeRideHour() ?? env.hour; writeSave(); }
  }

  if (!started && showcase.active) showcase.update(dt);
  else if (!started && !busIntro) {
    // menu panorama: a slow cinematic flight around the valley and the main mountain
    if (!window.__game.panoFrozen) titleT = (titleT + dt / 150) % 1;
    const p = PANO_POS.getPointAt(titleT), l = PANO_LOOK.getPointAt(titleT);
    p.y = Math.max(p.y, world.height(p.x, p.z) + 110);
    camera.position.copy(p);
    camera.lookAt(l);
    camera.fov = 50; camera.updateProjectionMatrix();
  }
  mark('hud');
  pisteLights.update(dt, camera, env);
  mark('pistelights');
  let crowdCourse = null; // (free ride: the fans at the finish arena of the course you are near)
  try { crowdCourse = modes.course ? null : races.crowdCourse(player.pos)?.course || null; } catch (e) { crowdCourse = null; }
  if (!isMP()) crowds.update(dt, { camera, player, course: modes.course || crowdCourse, courseGroup: modes.group || crowdCourse?.group || null, models }); // (multiplayer: no crowds)
  mark('crowds');
  snowcats.update(dt, camera, env, player, renderer);
  mark('snowcats');
  secrets.update(dt, { player, camera, env, active: started && !paused && !inSession });
  mark('secrets');
  flags.update(dt, env);
  parking?.update(camera); // car-park lamps at night; parked cars detailed only up close
  mark('living');
  // the racer lines up inside the start house: hide its walls while the camera is in there
  if (modes.group !== startHouseGroup) {
    startHouseGroup = modes.group;
    startHouse = modes.group?.getObjectByName('start-house') || null;
    if (modes.group) propDetail.add(modes.group);
  }
  propDetail.update(camera);
  if (startHouse) startHouse.visible = Math.hypot(camera.position.x - startHouse.position.x, camera.position.z - startHouse.position.z) > 4.2;
  mark('propdetail');
  backdrop.update(dt, camera, env);
  mark('backdrop');
  glare.update(dt, camera, env);
  mark('glare');
  railway.lateUpdate(camera, env, atmosphere, dt); // tunnels: the daylight fades out deep inside
  express?.lateUpdate(camera, env, atmosphere, dt); // (the Legacy Express's tunnels too; the cabin light after both)
  mark('railLate');
  busIntro?.update(frozen ? 0 : rawDt); // (after everything else: it poses the camera)
  return dt;
}

// intro plays while the world loads in the background; then the menu over the live panorama
audio.init();
audio.setVolume(save.volume ?? 0.8);
audio.setMusicVolume(save.musicVolume ?? 0.7);
menu = new Menu({
  characters: PLAYER_CHARACTERS, audio,
  onStart: (sel) => startFromMenu(sel),
  onShowcase: (id) => { if (!showcase) return; if (id) showcase.show(id); else showcase.hide(); },
  onShowcaseSpin: (d) => { if (showcase) showcase.spin += d; },
  getCourses: () => COURSES.map((c) => ({
    id: c.id, name: c.name, tagline: c.tagline, difficulty: c.difficulty, length: c.length, drop: c.drop,
    par: c.par, medals: c.medals, record: save.records?.[c.id] || null,
  })),
  onMainMenu: goToMainMenu,
  onQuality: (q) => { save.quality = q; save.qualitySet = 'user'; writeSave(); location.reload(); },
  onSens: (v) => { save.sensitivity = v; if (player) player.sensitivity = v; writeSave(); },
  onVolume: (v) => audio.setVolume(v),
  // multiplayer (net/session.js): MULTIPLAYER -> START, the name on first launch, BACK while connecting
  onMultiplayer: (sel) => startMultiplayer(sel),
  onMpName: (name) => mpRegister(name),
  onMpCancel: () => { mpCancelled = true; if (!isMP()) net.close('cancel'); },
  mpActive: () => isMP(),
});
const skipIntro = new URLSearchParams(location.search).has('nointro');
(skipIntro ? Promise.resolve() : new Intro(audio).play()).then(() => { menu.show(); audio.music('menu'); });
boot().catch((e) => {
  console.error(e);
  setLoad(1, 'Error: ' + e.message);
});

window.__game = {
  get player() { return player; }, env, layout, world, scene, camera, renderer,
  get races() { return races; }, get lifts() { return lifts; }, get railway() { return railway; }, get express() { return express; }, get village() { return village; }, get post() { return post; }, get interior() { return interior; }, get menu() { return menu; }, get showcase() { return showcase; }, get modes() { return modes; }, get skibus() { return skibus; }, get jobs() { return jobs; }, get talk() { return talk; }, get heli() { return heli; }, get sleds() { return sleds; }, get traffic() { return traffic; }, get drive() { return drive; }, get carRental() { return carRental; }, get chalets() { return chalets; }, get pisteLights() { return pisteLights; }, get crowds() { return crowds; }, get snowcats() { return snowcats; }, get flags() { return flags; }, get outfitShop() { return outfitShop; }, get admin() { return admin; }, transition,
  // handles for building new systems inside the running game (dev tests)
  get terrain() { return terrain; }, get secrets() { return secrets; }, get vegetation() { return vegetation; }, get atmosphere() { return atmosphere; }, get backdrop() { return backdrop; }, get glare() { return glare; }, get npcs() { return npcs; }, get dressing() { return dressing; }, propDetail, get decor() { return decor; },
  streamAround, applyQuality, autoQ, get quality() { return quality; }, get dynRes() { return dynRes; }, get started() { return started; }, get paused() { return paused; },
  // dev profiler: profile(true) starts, profile() returns the average CPU ms per frame of each system
  profile(on) {
    if (on !== undefined) { prof.on = !!on; prof.t = {}; prof.frames = 0; return true; }
    const out = {};
    for (const [k, v] of Object.entries(prof.t)) out[k] = +(v / Math.max(1, prof.frames)).toFixed(2);
    return out;
  },
  get multiplayer() { return multiplayer; }, MP, net,
  get models() { return models; }, get spray() { return spray; }, get trails() { return trails; }, get hud() { return hud; }, audio, colliders, makeRig, spend, earn, save, writeSave, raceHud, input, setPano: (t) => { titleT = t; }, swapCharacter, startGame, equipSkis, boardLift, get busIntro() { return busIntro; }, playBusIntro,
};

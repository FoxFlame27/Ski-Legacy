// SETTINGS (Nov 1 2026, the user: "a lot more settings"): the defaults of every device setting beyond graphics,
// mouse and volume, and `live`, the current values the game systems read as they run (player / drive camera,
// post chain, input, HUD, name tags). main.js fills `live` from the save (syncLive) and applies what needs a call.
// The values are stored flat in the save (economy.js DEVICE_PREFS keeps them through multiplayer); an old save
// without them reads these defaults.
export const SETTING_DEFAULTS = {
  // graphics
  renderScale: 1,      // x the preset's resolution (0.5..1)
  shadows: true,       // the sun's shadows
  bloom: true,         // glow around bright lights (on the presets that have it)
  fog: 1,              // haze density x (0.6 light, 1 normal, 1.4 heavy)
  brightness: 1,       // exposure x (0.7..1.3)
  fpsCap: 0,           // frame rate limit: 30, 60 or 0 = unlimited
  // audio
  musicVolume: 0.7,
  sfxVolume: 1,
  voiceVolume: 0.95,   // announcer and train PA
  muteUnfocused: false,
  // controls
  invertY: false,
  // camera
  fov: 65,             // third-person field of view (first person sits 13 deg wider)
  camShake: true,      // crash / landing / speed shake
  speedFx: true,       // speed streaks at the edges at high speed
  vignette: true,      // darker frame corners
  defaultView: 'third',// view at the start of a session
  // HUD
  speedUnit: 'kmh',    // 'kmh' | 'mph'
  clock12: false,      // 12-hour clock
  showSpeedo: true,
  showInfo: true,      // location, clock and weather (top left)
  showMoney: true,
  showForecast: true,  // "Later: Snow" under the clock
  showFps: false,
  hudScale: 1,         // 0.8..1.3
  flashSize: 'm',      // notifications: 's' | 'm' | 'l'
  nameTags: true,      // multiplayer: names above other players
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

/** The current values, read every frame by the systems that use them. */
export const live = { ...SETTING_DEFAULTS };

/** Copy the stored values (or the defaults) into `live`. */
export function syncLive(save) {
  for (const k of SETTING_KEYS) live[k] = save?.[k] ?? SETTING_DEFAULTS[k];
  return live;
}

/** A stored value or its default. */
export const prefOf = (save, k) => save?.[k] ?? SETTING_DEFAULTS[k];

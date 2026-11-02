// npm run steam:vdf -- writes ready-to-run SteamPipe scripts to steam/output/scripts/ from the templates in steam/,
// filled in with the IDs from package.json "steam" ({ appId, depots: { windows, mac, linux }, buildDesc, setLive }).
// Environment variables override them: STEAM_APP_ID, STEAM_DEPOT_WINDOWS, STEAM_DEPOT_MAC, STEAM_DEPOT_LINUX,
// STEAM_SET_LIVE (a branch name, e.g. beta; empty = set it live by hand in Steamworks).
// Only depots with an ID and a built folder are included (build them first: npm run steam:win / steam:mac / steam:linux).
// Then:  steamcmd +login <steam_user> +run_app_build "<the printed path>" +quit
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).steam || {};
const num = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

const appId = num(process.env.STEAM_APP_ID) || num(cfg.appId);
if (!appId) { console.error('No Steam App ID: set "steam": { "appId": ... } in package.json or STEAM_APP_ID.'); process.exit(1); }

const OS = [
  { key: 'windows', env: 'STEAM_DEPOT_WINDOWS', dir: 'release/steam/win/win-unpacked', check: 'Ski Legacy.exe' },
  { key: 'mac', env: 'STEAM_DEPOT_MAC', dir: 'release/steam/mac/mac-universal', check: 'Ski Legacy.app' },
  { key: 'linux', env: 'STEAM_DEPOT_LINUX', dir: 'release/steam/linux/linux-unpacked', check: 'ski-legacy' },
];
const out = path.join(HERE, 'output', 'scripts');
fs.mkdirSync(out, { recursive: true });
const q = (s) => String(s).replace(/\\/g, '/').replace(/"/g, '');

const depots = [];
for (const o of OS) {
  const id = num(process.env[o.env]) || num(cfg.depots?.[o.key]);
  const dir = path.join(ROOT, o.dir);
  if (!id) { console.log(`- ${o.key}: no depot ID, skipped`); continue; }
  if (!fs.existsSync(path.join(dir, o.check))) { console.log(`- ${o.key}: ${o.dir}/${o.check} not built, skipped`); continue; }
  const file = `depot_build_${id}.vdf`;
  fs.writeFileSync(path.join(out, file), `"DepotBuild"
{
	"DepotID" "${id}"
	"ContentRoot" "${q(dir)}/"
	"FileMapping"
	{
		"LocalPath" "*"
		"DepotPath" "."
		"Recursive" "1"
	}
	"FileExclusion" "steam_appid.txt"
	"FileExclusion" "*.pdb"
}
`);
  depots.push([id, file]);
  console.log(`+ ${o.key}: depot ${id} <- ${o.dir}`);
}
if (!depots.length) { console.error('No depot to upload.'); process.exit(1); }

const setLive = q(process.env.STEAM_SET_LIVE ?? cfg.setLive ?? '');
const app = path.join(out, `app_build_${appId}.vdf`);
fs.writeFileSync(app, `"AppBuild"
{
	"AppID" "${appId}"
	"Desc" "${q(cfg.buildDesc || 'Ski Legacy')} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}"
	"ContentRoot" "${q(ROOT)}/"
	"BuildOutput" "${q(path.join(HERE, 'output'))}/"
	"Preview" "0"
	"SetLive" "${setLive}"
	"Depots"
	{
${depots.map(([id, f]) => `		"${id}" "${f}"`).join('\n')}
	}
}
`);
console.log(`\nWrote ${app}\nUpload:  steamcmd +login <steam_user> +run_app_build "${app}" +quit`);

// After `npm run app:win`: drop electron-builder's leftovers so release/ holds just the one file to share,
// release/Ski Legacy.exe (a portable app: double-click it, nothing to install).
import fs from 'node:fs';

for (const f of ['win-unpacked', 'builder-debug.yml', 'builder-effective-config.yaml', 'Ski Legacy.exe.blockmap']) {
  fs.rmSync(`release/${f}`, { recursive: true, force: true });
}
const exe = 'release/Ski Legacy.exe';
if (!fs.existsSync(exe)) { console.error(`${exe} was not built`); process.exit(1); }
console.log(`\nDone: ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB). Send that one file to your friends.`);

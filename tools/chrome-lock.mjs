// Machine-wide limit for headless browsers (8 GB Mac). One test browser may always run; a second one only
// starts while the Mac has plenty of free memory and isn't swapping much (two game instances at once otherwise push it into swap,
// which makes everything slower and once caused WebGL context losses).
// await acquireChromeLock('my-label') before puppeteer.launch(); released automatically on exit.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const BASE = '/private/tmp/claude-501/-Users-mohanchennupati-Ski-legacy/a01f6f23-3263-4ebf-becc-4543a0a64f23/scratchpad/chrome.lock';
const SLOTS = [BASE, `${BASE}-2`];
const SECOND_SLOT_FREE_GB = 2.5;
const SECOND_SLOT_MAX_SWAP_GB = 2.5; // ...and not while the Mac is already swapping hard

// swap in use in GB (macOS sysctl vm.swapusage); Infinity if it can't be read
function swapUsedGB() {
  try {
    const out = execSync('sysctl -n vm.swapusage', { encoding: 'utf8' });
    const m = /used = ([\d.]+)M/.exec(out);
    return m ? +m[1] / 1024 : Infinity;
  } catch { return Infinity; }
}
const STALE_MS = 12 * 60 * 1000;

// free + inactive + speculative memory in GB (macOS vm_stat); 0 if it can't be read
function freeGB() {
  try {
    const out = execSync('vm_stat', { encoding: 'utf8' });
    const page = +(/page size of (\d+)/.exec(out)?.[1] || 16384);
    const get = (k) => +(new RegExp(`${k}:\\s+(\\d+)`).exec(out)?.[1] || 0);
    return ((get('Pages free') + get('Pages inactive') + get('Pages speculative')) * page) / 1e9;
  } catch { return 0; }
}

function tryTake(lock, label) {
  try {
    fs.mkdirSync(lock);
  } catch {
    let age = 0;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { return null; }
    if (age > STALE_MS) fs.rmSync(lock, { recursive: true, force: true }); // stale lock
    return null;
  }
  fs.writeFileSync(`${lock}/owner`, `${label} pid=${process.pid} at ${new Date().toISOString()}`);
  const release = () => { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130); });
  return release;
}

export async function acquireChromeLock(label = 'chrome') {
  const t0 = Date.now();
  for (;;) {
    const first = tryTake(SLOTS[0], label);
    if (first) return first;
    if (freeGB() >= SECOND_SLOT_FREE_GB && swapUsedGB() <= SECOND_SLOT_MAX_SWAP_GB) {
      const second = tryTake(SLOTS[1], label);
      if (second) return second;
    }
    if (Date.now() - t0 > 2000 && (Date.now() - t0) % 30000 < 1000) {
      let owner = '?'; try { owner = fs.readFileSync(`${SLOTS[0]}/owner`, 'utf8'); } catch {}
      console.log(`waiting for a browser slot (held by ${owner}; free memory ${freeGB().toFixed(1)} GB)`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

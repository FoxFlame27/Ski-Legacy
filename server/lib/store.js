// Persistent JSON store: accounts and profiles, each one file under the data directory, written atomically
// (write to a temp file, fsync, rename over the old one) and debounced, so a crash never leaves half a file.
import fs from 'node:fs';
import path from 'node:path';

export class JsonFile {
  constructor(file, fallback) {
    this.file = file;
    this.data = fallback;
    this.timer = null;
    this.dirty = false;
    try {
      if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // a damaged file is kept aside, never overwritten silently
      const bad = `${file}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(file, bad); } catch { /* ignore */ }
      console.error(`[store] ${file} unreadable (${e.message}); copied to ${bad}, starting empty`);
    }
  }

  /** Mark changed; written within `delay` ms. */
  save(delay = 500) {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.dirty = true; // try again next time
      console.error(`[store] writing ${this.file} failed: ${e.message}`);
    }
  }
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // accounts: { [nameKey]: { name, hash, created } }   (nameKey = lower-case name; hash = sha256 of the token)
    this.accounts = new JsonFile(path.join(dir, 'accounts.json'), {});
    // profiles: { [nameKey]: profile }  (see server.js newProfile)
    this.profiles = new JsonFile(path.join(dir, 'profiles.json'), {});
  }

  flush() { this.accounts.flush(); this.profiles.flush(); }
}

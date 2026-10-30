// The connection to the multiplayer server: one WebSocket, an event emitter, request/response with promises,
// clock sync (ping / pong, best-of-N offset) and automatic reconnects. The singleton `net` is what every system
// uses (docs/multiplayer.md):
//
//   import { net } from '../net/client.js';
//   const off = net.on('seats', (d) => { ... });     // server events ({ t, d } frames); returns an unsubscribe fn
//   net.send('look', { c, o, s });                    // fire and forget (false when not connected)
//   const r = await net.request('seatClaim', { k: 'bus', v: 'line1-0' });   // resolves with d, or throws
//   //   (a refusal throws an Error with .code = the server's err ('full', 'money', ...) and .data)
//   net.serverNow()                                   // ms on the server's clock (shared timeline for everything)
//
// Local events (not from the server): 'open', 'close' ({ code, reason }), 'status' (string), 'lost' (gave up
// reconnecting), 'reopen' (reconnected: the session logs in again).
import { PROTO } from './protocol.js';

const PING_EVERY = 2000;
const REQ_TIMEOUT = 10000;
// reconnect waits (the last one repeats) until GIVE_UP_MS after the drop; only then 'lost' (back to the menu)
const BACKOFF = [300, 1000, 2000, 3000, 5000];
const GIVE_UP_MS = 120000;
// liveness: the server answers our pings every 2 s and relays presence; nothing at all for STALE_MS means the socket
// is dead (a network change, a sleeping laptop): drop it and reconnect. A check that itself ran late (the main thread
// was busy loading terrain, the tab was in the background) proves nothing and is skipped.
const STALE_MS = 20000, CHECK_EVERY = 4000;

export class NetClient {
  constructor() {
    this.handlers = new Map();
    this.pending = new Map();
    this.ws = null;
    this.url = null;
    this.nextId = 1;
    this.status = 'off';
    this.offset = 0;          // serverNow = performance.now() + offset
    this.rtt = 0;
    this.samples = [];        // [rtt, offset] (last 10)
    this.synced = false;
    this.wantOpen = false;
    this.tries = 0;
    this.pingT = null;
    this.retryT = null;
    this.lastMsg = 0;         // performance.now() of the last frame from the server
    this.lastCheck = 0;
    this.downSince = 0;       // performance.now() the connection dropped (0: up)
    if (typeof document !== 'undefined') {
      // back from the background: check the socket now (a laptop lid, a phone screen: often dead by then)
      document.addEventListener('visibilitychange', () => { if (!document.hidden && this.open) { this.lastCheck = performance.now(); this.ping(); } });
    }
  }

  // ---------------------------------------------------------------- events
  on(type, fn) {
    let s = this.handlers.get(type);
    if (!s) { s = new Set(); this.handlers.set(type, s); }
    s.add(fn);
    return () => s.delete(fn);
  }
  off(type, fn) { this.handlers.get(type)?.delete(fn); }
  once(type, fn) { const off = this.on(type, (d) => { off(); fn(d); }); return off; }
  emit(type, d) {
    const s = this.handlers.get(type);
    if (!s) return;
    for (const fn of s) { try { fn(d); } catch (e) { console.warn(`[net] handler for ${type}`, e); } }
  }

  // ---------------------------------------------------------------- sending
  get open() { return !!this.ws && this.ws.readyState === 1; }
  send(t, d) {
    if (!this.open) return false;
    this.ws.send(JSON.stringify({ t, d }));
    return true;
  }
  request(t, d = {}, timeout = REQ_TIMEOUT) {
    if (!this.open) { const e = new Error('offline'); e.code = 'offline'; return Promise.reject(e); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const start = performance.now();
      let due = start + timeout;
      // A timer that fires late (the main thread was busy: loading terrain on a slow machine) proves nothing: the
      // answer may be waiting in the queue behind it. Then it waits a little longer (up to 4x the timeout in all).
      const check = () => {
        const p = this.pending.get(id);
        if (!p) return;
        const now = performance.now();
        if (now - due > 1000 && now - start < timeout * 4) { due = now + 2000; p.timer = setTimeout(check, 2000); return; }
        this.pending.delete(id);
        const e = new Error('timeout'); e.code = 'timeout'; reject(e);
      };
      this.pending.set(id, { resolve, reject, timer: setTimeout(check, timeout) });
      this.ws.send(JSON.stringify({ t, d, id }));
    });
  }
  /** presence row (see protocol.js / docs): sent as-is, the server stamps pid, vehicle and interior */
  sendPresence(row) { if (this.open && this.ws.bufferedAmount < 65536) this.ws.send(JSON.stringify({ t: 'p', d: row })); }

  // ---------------------------------------------------------------- clock
  // (before the first pong: the system clock, which is the server's give or take NTP, instead of performance.now()
  // alone: that is ms since this page loaded, so every train, bus and cabin would stand somewhere else for each
  // player until the first answer came)
  serverNow() { return this.hasOffset ? performance.now() + this.offset : Date.now(); }
  ping() { this.send('ping', { c: performance.now() }); }
  onPong(d) {
    const now = performance.now(), rtt = now - d.c;
    if (!(rtt >= 0) || rtt > 10000) return;
    const off = d.s - (d.c + rtt / 2);
    // Each sample puts the true offset within +-rtt/2 of its own. One that overlaps none of the kept ones means the
    // clock jumped (a laptop that slept: performance.now() stood still; the system clock set): the old samples are
    // all wrong now, and the quickest of them would otherwise keep the old offset (every train, bus and cabin in the
    // wrong place) until it fell out of the window 20 s later. Start over from this one.
    if (this.samples.length && this.samples.every((s) => Math.abs(s[1] - off) > (s[0] + rtt) / 2 + 25)) this.samples.length = 0;
    this.samples.push([rtt, off]);
    if (this.samples.length > 10) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s[0] < best[0]) best = s;
    // (small corrections ease in, a big one jumps: no visible snapping of remote players)
    const target = best[1];
    this.offset = !this.synced || Math.abs(target - this.offset) > 250 ? target : this.offset + (target - this.offset) * 0.2;
    this.rtt = rtt;
    this.synced = true; this.hasOffset = true;
  }

  // ---------------------------------------------------------------- connection
  setStatus(s) { if (s !== this.status) { this.status = s; this.emit('status', s); } }

  /** Open the socket (resolves on open, rejects if it cannot connect). Reconnects by itself afterwards. */
  connect(url) {
    this.url = url;
    this.wantOpen = true;
    this.tries = 0;
    return this.openSocket();
  }

  openSocket() {
    clearTimeout(this.retryT);
    this.setStatus(this.tries ? 'reconnecting' : 'connecting');
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { if (this.tries) this.retry(); reject(e); return; }
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        if (this.ws !== ws) return;
        opened = true;
        const again = this.tries > 0 || this.downSince > 0;
        this.tries = 0;
        this.downSince = 0;
        this.samples.length = 0;
        this.synced = false;
        this.lastMsg = this.lastCheck = performance.now();
        this.setStatus('open');
        for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 120);
        clearInterval(this.pingT);
        this.pingT = setInterval(() => { this.ping(); this.checkAlive(); }, PING_EVERY);
        this.emit('open');
        if (again) this.emit('reopen');
        resolve();
      };
      ws.onmessage = (ev) => {
        if (this.ws !== ws) return;
        this.lastMsg = performance.now();
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'res') {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve(m.d);
          else { const e = new Error(m.err || 'error'); e.code = m.err; e.data = m.d; p.reject(e); }
          return;
        }
        if (m.t === 'pong') { this.onPong(m.d); return; }
        this.emit(m.t, m.d);
      };
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        if (!opened && this.tries === 0 && !this.downSince) { this.dropSocket(); this.wantOpen = false; this.setStatus('off'); reject(new Error(ev.reason || 'Could not reach the server')); return; }
        this.onDrop(ev.code, ev.reason);
        if (!opened) reject(new Error('reconnect failed'));
      };
    });
  }

  /** Forget the current socket (its late events are ignored) and fail what was waiting on it. */
  dropSocket() {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.pingT);
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(4000, 'stale'); } catch { /* closed */ } }
    for (const [id, p] of this.pending) { clearTimeout(p.timer); const e = new Error('offline'); e.code = 'offline'; p.reject(e); this.pending.delete(id); }
  }

  // The connection is gone. Anything but another login of this account (4001) or LEAVE MULTIPLAYER reconnects, with
  // backoff, for up to GIVE_UP_MS (the server holds the player for a minute meanwhile: same world, seat, chalet...).
  onDrop(code, reason) {
    this.dropSocket();
    this.emit('close', { code, reason });
    if (!this.wantOpen || code === 4001) {
      this.wantOpen = false; this.setStatus('off');
      if (code === 4001) this.emit('lost', { reason: reason || 'replaced' });
      return;
    }
    if (!this.downSince) this.downSince = performance.now();
    this.retry();
  }
  retry() {
    clearTimeout(this.retryT);
    if (!this.wantOpen) return;
    if (performance.now() - this.downSince > GIVE_UP_MS) { this.wantOpen = false; this.setStatus('off'); this.emit('lost', { reason: 'Connection lost' }); return; }
    const wait = BACKOFF[Math.min(this.tries++, BACKOFF.length - 1)];
    this.setStatus('reconnecting');
    this.retryT = setTimeout(() => this.openSocket().catch(() => {}), wait);
  }
  /** The socket is open but useless (e.g. the login after a reconnect timed out): drop it and reconnect. */
  reconnect(why = 'retry') { if (this.ws && this.wantOpen) this.onDrop(4000, why); }

  checkAlive() {
    const now = performance.now(), late = now - this.lastCheck > PING_EVERY * 2 + 1000;
    this.lastCheck = now;
    if (late || !this.open) return; // (this check itself ran late: the main thread was busy, not the network)
    if (now - this.lastMsg > STALE_MS) { console.warn('[net] no word from the server for', Math.round((now - this.lastMsg) / 1000), 's: reconnecting'); this.reconnect('stale'); }
  }

  /** Close for good (LEAVE MULTIPLAYER). */
  close(reason = 'leave') {
    this.wantOpen = false;
    clearTimeout(this.retryT);
    clearInterval(this.pingT);
    this.downSince = 0; this.tries = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(1000, reason); } catch { /* closed */ } }
    for (const [, p] of this.pending) { clearTimeout(p.timer); const e = new Error('offline'); e.code = 'offline'; p.reject(e); }
    this.pending.clear();
    this.setStatus('off');
  }
}

export const net = new NetClient();
export { PROTO };

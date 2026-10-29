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
const BACKOFF = [500, 1000, 2000, 4000, 6000, 8000];

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
      const timer = setTimeout(() => { this.pending.delete(id); const e = new Error('timeout'); e.code = 'timeout'; reject(e); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ t, d, id }));
    });
  }
  /** presence row (see protocol.js / docs): sent as-is, the server stamps pid, vehicle and interior */
  sendPresence(row) { if (this.open && this.ws.bufferedAmount < 65536) this.ws.send(JSON.stringify({ t: 'p', d: row })); }

  // ---------------------------------------------------------------- clock
  serverNow() { return performance.now() + this.offset; }
  ping() { this.send('ping', { c: performance.now() }); }
  onPong(d) {
    const now = performance.now(), rtt = now - d.c;
    if (!(rtt >= 0) || rtt > 10000) return;
    this.samples.push([rtt, d.s - (d.c + rtt / 2)]);
    if (this.samples.length > 10) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s[0] < best[0]) best = s;
    // (small corrections ease in, a big one jumps: no visible snapping of remote players)
    const target = best[1];
    this.offset = !this.synced || Math.abs(target - this.offset) > 250 ? target : this.offset + (target - this.offset) * 0.2;
    this.rtt = rtt;
    this.synced = true;
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
      try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        const again = this.tries > 0;
        this.tries = 0;
        this.samples.length = 0;
        this.synced = false;
        this.setStatus('open');
        for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 120);
        clearInterval(this.pingT);
        this.pingT = setInterval(() => this.ping(), PING_EVERY);
        this.emit('open');
        if (again) this.emit('reopen');
        resolve();
      };
      ws.onmessage = (ev) => {
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
        clearInterval(this.pingT);
        for (const [id, p] of this.pending) { clearTimeout(p.timer); const e = new Error('offline'); e.code = 'offline'; p.reject(e); this.pending.delete(id); }
        this.emit('close', { code: ev.code, reason: ev.reason });
        if (!opened && this.tries === 0) { this.wantOpen = false; this.setStatus('off'); reject(new Error(ev.reason || 'Could not reach the server')); return; }
        // kicked for a second login, or a deliberate close: no reconnect
        if (!this.wantOpen || ev.code === 4001 || ev.code === 1008) { this.wantOpen = false; this.setStatus('off'); if (ev.code === 4001 || ev.code === 1008) this.emit('lost', { reason: ev.reason }); return; }
        if (this.tries >= BACKOFF.length) { this.wantOpen = false; this.setStatus('off'); this.emit('lost', { reason: 'Connection lost' }); return; }
        const wait = BACKOFF[this.tries++];
        this.setStatus('reconnecting');
        this.retryT = setTimeout(() => this.openSocket().catch(() => {}), wait);
      };
    });
  }

  /** Close for good (LEAVE MULTIPLAYER). */
  close(reason = 'leave') {
    this.wantOpen = false;
    clearTimeout(this.retryT);
    clearInterval(this.pingT);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000, reason); } catch { /* closed */ } }
    for (const [, p] of this.pending) { clearTimeout(p.timer); const e = new Error('offline'); e.code = 'offline'; p.reject(e); }
    this.pending.clear();
    this.setStatus('off');
  }
}

export const net = new NetClient();
export { PROTO };

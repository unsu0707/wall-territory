// Transport layer. Two modes with the same message protocol:
//  - 'ws'  : a Node server (server.js) runs the engine; browsers talk to it over WebSocket.
//  - 'p2p' : static hosting (GitHub Pages). The room creator's browser runs the engine and the
//            others connect to it directly over WebRTC (PeerJS; its public broker only does signalling).
import { createEngine, randomCode } from './engine.js';

const PEER_PREFIX = 'wall-territory-v1-';
const PEER_OPTS = { debug: 1 };

const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} },
};

export async function detectMode() {
  const forced = new URLSearchParams(location.search).get('mode');
  if (forced === 'p2p' || forced === 'ws') return forced;
  try {
    const r = await fetch('healthz', { cache: 'no-store' });
    if (r.ok && (await r.text()).trim() === 'ok') return 'ws';
  } catch {}
  return 'p2p';
}

// handlers: { message(obj), status(key, info?) }
export function createNet(mode, handlers) {
  return mode === 'ws' ? wsNet(handlers) : p2pNet(handlers);
}

// ---------------- WebSocket ----------------
function wsNet(h) {
  let ws = null, retry = 0, pending = null, joined = false;
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    ws.onopen = () => {
      retry = 0;
      const code = ss.get('wt_room');
      if (pending) { ws.send(JSON.stringify(pending)); pending = null; }
      else if (code && h.resumeMsg) ws.send(JSON.stringify(h.resumeMsg(code)));
    };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'joined') { joined = true; ss.set('wt_room', m.code); } h.message(m); };
    ws.onclose = () => {
      setTimeout(connect, Math.min(5000, 400 * 2 ** retry++));
      if (joined) h.status('disconnected');
    };
  }
  connect();
  const send = (obj) => { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); else { pending = obj; h.status('connecting'); } };
  return {
    mode: 'ws',
    isHostDevice: () => false,
    send,
    create: (msg) => send(msg),
    join: (code, msg) => send(msg),
    leave() { joined = false; ss.set('wt_room', null); },
  };
}

// ---------------- P2P (PeerJS / WebRTC, with MQTT relay fallback) ----------------
// The room creator's browser runs the engine. Guests first try a direct WebRTC connection; if that
// does not open (same-machine tabs, strict NAT/firewall), they fall back to a public MQTT broker over
// WebSocket that relays messages between guest and host. The host listens on both at once.
// HiveMQ first: EMQX's public broker silently drops bursts above ~10 msg/s.
const RELAY_BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const RELAY_PREFIX = 'wall-territory-v1/';
const RTC_TIMEOUT = 7000;
const RELAY_TIMEOUT = 9000;
const HOST_PING_MS = 5000;
const HOST_SILENT_MS = 20000;
// Paced publisher: at most one message per `gap` ms. 'room' messages are full snapshots,
// so a newer one replaces any unsent older one.
function pacedSender(publish, gap = 120) {
  const q = [];
  let timer = null;
  const flush = () => {
    timer = null;
    const next = q.shift();
    if (!next) return;
    publish(next);
    if (q.length) timer = setTimeout(flush, gap);
  };
  return (obj) => {
    if (obj && obj.t === 'room') { const i = q.findIndex((o) => o.t === 'room'); if (i !== -1) q.splice(i, 1); }
    if (q.length > 30) q.splice(0, q.length - 30);
    q.push(obj);
    if (!timer) timer = setTimeout(flush, q.length === 1 ? 0 : gap);
  };
}
const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

function p2pNet(h) {
  let peer = null;      // our Peer (host: fixed id, guest: random id)
  let engine = null;    // host only
  let relays = [];      // host: one MQTT client per broker; guest: the one in use
  let pingTimer = null;
  let hostConns = null;  // host: connId -> send(obj)
  let link = null;      // guest: { kind, send, close }
  let role = ss.get('wt_role');
  let code = ss.get('wt_room');
  let closed = false;
  let session = 0;      // bumps on every create/join/leave so stale callbacks are ignored
  let joinedOnce = false;
  let lostCount = 0;
  const deliver = (obj) => queueMicrotask(() => {
    if (obj.t === 'joined') { ss.set('wt_room', obj.code); joinedOnce = true; lostCount = 0; }
    h.message(obj);
  });
  const topic = (c, ...rest) => RELAY_PREFIX + [c, ...rest].join('/');

  function connectBroker(url, opts = {}) {
    return new Promise((resolve) => {
      if (!window.mqtt) return resolve(null);
      const client = window.mqtt.connect(url, { connectTimeout: 6000, reconnectPeriod: 2000, clean: true, ...opts });
      const t = setTimeout(() => { if (!client.connected) { client.end(true); resolve(null); } }, 7000);
      client.once('connect', () => { clearTimeout(t); resolve(client); });
    });
  }

  // ===== host =====
  function startHost(firstMsg, restoring) {
    const my = ++session;
    closed = false;
    role = 'host'; ss.set('wt_role', 'host');
    if (!code) code = randomCode();
    ss.set('wt_room', code);
    let ready = false;
    const conns = new Map(); // connId -> send(obj)
    hostConns = conns;
    const hostReady = () => {
      if (ready || my !== session) return;
      ready = true;
      engine = createEngine({
        fixedCode: code,
        sendTo(connId, obj) {
          if (connId === 'local') return deliver(obj);
          conns.get(connId)?.(obj);
        },
        onChange() { const s = engine?.exportRoom(code); if (s) ss.set('wt_hoststate', s); },
      });
      const saved = ss.get('wt_hoststate');
      if (restoring && saved) { try { engine.importRoom(saved); } catch { ss.set('wt_hoststate', null); } }
      engine.handle('local', firstMsg({ code }));
      startHostRelay(my, conns);
    };

    // WebRTC listener (fixed peer id = room code)
    let idRetry = 0;
    const openPeer = () => {
      if (!window.Peer || my !== session) return hostReady();
      peer = new window.Peer(PEER_PREFIX + code, PEER_OPTS);
      peer.on('open', hostReady);
      peer.on('connection', (conn) => {
        const id = 'rtc:' + conn.connectionId;
        conn.on('open', () => conns.set(id, (o) => conn.open && conn.send(o)));
        conn.on('data', (msg) => engine?.handle(id, msg));
        const gone = () => { conns.delete(id); engine?.disconnect(id); };
        conn.on('close', gone);
        conn.on('error', gone);
      });
      peer.on('disconnected', () => { if (!closed && my === session) setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 1500); });
      peer.on('error', (e) => {
        if (my !== session) return;
        if (e.type === 'unavailable-id') {
          peer.destroy();
          if (restoring || ready) {
            // After a refresh our old id stays registered for a few seconds — retry; relay works meanwhile.
            if (idRetry++ < 15) setTimeout(openPeer, 2000);
            hostReady();
          } else { code = randomCode(); ss.set('wt_room', code); openPeer(); }
        } else if (['network', 'server-error', 'socket-error', 'browser-incompatible'].includes(e.type)) {
          hostReady(); // signalling broker unreachable: run on the relay only
        }
      });
    };
    openPeer();
    setTimeout(hostReady, 8000); // never leave the host stuck if the PeerJS broker is slow
  }

  async function startHostRelay(my, conns) {
    const gidBroker = new Map(); // guest id -> client that guest uses
    const clients = (await Promise.all(RELAY_BROKERS.map((u) => connectBroker(u)))).filter(Boolean);
    if (my !== session) { clients.forEach((c) => c.end(true)); return; }
    relays = clients;
    for (const client of clients) {
      client.subscribe(topic(code, 'h'));
      client.on('message', (_t, buf) => {
        let m; try { m = JSON.parse(buf.toString()); } catch { return; }
        if (!m || typeof m.from !== 'string' || m.from.length > 40) return;
        const id = 'mq:' + m.from;
        if (m.bye) { conns.delete(id); engine?.disconnect(id); return; }
        if (!m.msg) return;
        if (gidBroker.get(m.from) !== client) {
          gidBroker.set(m.from, client);
          const to = topic(code, 'g', m.from);
          conns.set(id, pacedSender((o) => client.publish(to, JSON.stringify(o))));
        }
        engine?.handle(id, m.msg);
      });
    }
    clearInterval(pingTimer);
    pingTimer = setInterval(() => relays.forEach((c) => c.connected && c.publish(topic(code, 'ping'), '1')), HOST_PING_MS);
  }

  // ===== guest =====
  function startGuest(joinMsg) {
    const my = ++session;
    closed = false;
    role = 'guest'; ss.set('wt_role', 'guest');
    ss.set('wt_room', code);
    attempt(my, joinMsg);
  }

  async function attempt(my, joinMsg) {
    if (my !== session) return;
    h.status('joining');
    if (await tryRtc(my, joinMsg)) return;
    if (my !== session) return;
    if (await tryRelay(my, joinMsg)) { h.status('relay'); return; }
    if (my !== session) return;
    if (joinedOnce && lostCount++ < 6) { setTimeout(() => attempt(my, joinMsg), 3000); return; }
    h.status('joinFailed');
    deliver({ t: 'error', key: joinedOnce ? 'hostLost' : 'connectFail' });
    shutdown();
  }

  function linkLost(my, joinMsg) {
    if (closed || my !== session) return;
    link = null;
    h.status('hostGone');
    setTimeout(() => attempt(my, joinMsg), 1500);
  }

  function tryRtc(my, joinMsg) {
    return new Promise((resolve) => {
      if (!window.Peer) return resolve(false);
      let settled = false;
      const finish = (ok, conn) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (!ok) { try { conn?.close(); } catch {} }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false, current), RTC_TIMEOUT);
      let current = null;
      const go = () => {
        if (my !== session) return finish(false);
        const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        current = conn;
        conn.on('open', () => {
          if (settled || my !== session) { conn.close(); return; }
          link = { kind: 'rtc', send: (o) => conn.open && conn.send(o), close: () => conn.close() };
          conn.on('data', (obj) => deliver(obj));
          conn.on('close', () => { if (link?.kind === 'rtc') linkLost(my, joinMsg); });
          conn.send(joinMsg());
          finish(true, conn);
        });
      };
      if (peer && !peer.destroyed && peer.open) go();
      else {
        try { peer?.destroy(); } catch {}
        peer = new window.Peer(PEER_OPTS);
        peer.on('open', go);
        peer.on('error', () => finish(false, current)); // peer-unavailable, network, ... → try the relay
      }
    });
  }

  async function tryRelay(my, joinMsg) {
    for (const url of RELAY_BROKERS) {
      if (my !== session) return false;
      const gid = rid(); // fresh id per relay connection, so a late "bye" can't drop a newer one
      const client = await connectBroker(url, { will: { topic: topic(code, 'h'), payload: JSON.stringify({ from: gid, bye: true }), qos: 0 } });
      if (!client) continue;
      const ok = await new Promise((resolve) => {
        let heard = false;
        let lastPing = Date.now();
        const t = setTimeout(() => { if (!heard) resolve(false); }, RELAY_TIMEOUT);
        client.subscribe([topic(code, 'g', gid), topic(code, 'ping')], () => {
          client.publish(topic(code, 'h'), JSON.stringify({ from: gid, msg: joinMsg() }));
        });
        client.on('message', (tp, buf) => {
          if (tp.endsWith('/ping')) { lastPing = Date.now(); return; }
          let obj; try { obj = JSON.parse(buf.toString()); } catch { return; }
          lastPing = Date.now();
          if (!heard) {
            heard = true; clearTimeout(t);
            const watch = setInterval(() => {
              if (link?.client !== client) return clearInterval(watch);
              if (Date.now() - lastPing > HOST_SILENT_MS) { clearInterval(watch); client.end(true); linkLost(my, joinMsg); }
            }, 3000);
            link = {
              kind: 'relay', client,
              send: pacedSender((o) => client.publish(topic(code, 'h'), JSON.stringify({ from: gid, msg: o }))),
              close: () => { client.publish(topic(code, 'h'), JSON.stringify({ from: gid, bye: true })); setTimeout(() => client.end(true), 200); },
            };
            resolve(true);
          }
          deliver(obj);
        });
      });
      if (ok && my === session) return true;
      client.end(true);
    }
    return false;
  }

  function shutdown() {
    if (role === 'host' && hostConns) for (const send of hostConns.values()) { try { send({ t: 'error', key: 'hostClosed' }); } catch {} }
    hostConns = null;
    session++;
    closed = true;
    try { link?.close(); } catch {}
    try { peer?.destroy(); } catch {}
    const old = relays;
    setTimeout(() => old.forEach((c) => { try { c.end(true); } catch {} }), 300);
    clearInterval(pingTimer);
    peer = null; engine = null; link = null; relays = []; role = null; code = null; joinedOnce = false; lostCount = 0;
    ss.set('wt_role', null); ss.set('wt_room', null); ss.set('wt_hoststate', null);
  }

  // resume after a page refresh
  queueMicrotask(() => {
    if (!code || !h.resumeMsg) return;
    if (role === 'host') startHost(({ code: c }) => h.resumeMsg(c), true);
    else if (role === 'guest') startGuest(() => h.resumeMsg(code));
  });

  return {
    mode: 'p2p',
    isHostDevice: () => role === 'host',
    send(obj) {
      if (role === 'host' && engine) engine.handle('local', obj);
      else if (link) link.send(obj);
      else h.status('connecting');
    },
    create(msg) {
      shutdown();
      code = null;
      h.status('creating');
      startHost(() => msg, false);
    },
    join(c, msg) {
      shutdown();
      code = c;
      startGuest(() => msg);
    },
    leave() { shutdown(); },
  };
}

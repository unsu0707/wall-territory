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

// ---------------- P2P (PeerJS / WebRTC) ----------------
function p2pNet(h) {
  let peer = null;      // our Peer
  let engine = null;    // host only
  let hostConn = null;  // guest only: DataConnection to host
  let role = ss.get('wt_role');
  let code = ss.get('wt_room');
  let retry = 0;
  let closed = false;
  const deliver = (obj) => queueMicrotask(() => {
    if (obj.t === 'joined') { ss.set('wt_room', obj.code); }
    h.message(obj);
  });

  function needPeerJs() {
    if (!window.Peer) { h.status('peerError', 'PeerJS failed to load'); return false; }
    return true;
  }

  // ----- host -----
  function startHost(firstMsg, restoring) {
    if (!needPeerJs()) return;
    closed = false;
    role = 'host'; ss.set('wt_role', 'host');
    if (!code) code = randomCode();
    ss.set('wt_room', code);
    peer = new window.Peer(PEER_PREFIX + code, PEER_OPTS);
    const conns = new Map();
    peer.on('open', () => {
      retry = 0;
      engine = createEngine({
        fixedCode: code,
        sendTo(connId, obj) {
          if (connId === 'local') return deliver(obj);
          const c = conns.get(connId);
          if (c?.open) c.send(obj);
        },
        onChange() { const s = engine?.exportRoom(code); if (s) ss.set('wt_hoststate', s); },
      });
      const saved = ss.get('wt_hoststate');
      if (restoring && saved) { try { engine.importRoom(saved); } catch { ss.set('wt_hoststate', null); } }
      engine.handle('local', firstMsg({ code }));
    });
    peer.on('connection', (conn) => {
      const id = conn.connectionId;
      conns.set(id, conn);
      conn.on('data', (msg) => engine?.handle(id, msg));
      conn.on('close', () => { conns.delete(id); engine?.disconnect(id); });
      conn.on('error', () => { conns.delete(id); engine?.disconnect(id); });
    });
    peer.on('disconnected', () => { if (!closed) setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 1500); });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') {
        peer.destroy();
        if (restoring) {
          // Our old peer id is still registered for a few seconds after a refresh — retry.
          if (retry++ < 15) setTimeout(() => startHost(firstMsg, true), 2000);
          else h.status('peerError', e.type);
        } else {
          code = randomCode();
          startHost(firstMsg, false);
        }
      } else if (e.type !== 'peer-unavailable') {
        h.status('peerError', e.type);
      }
    });
  }

  // ----- guest -----
  function startGuest(joinMsg) {
    if (!needPeerJs()) return;
    closed = false;
    role = 'guest'; ss.set('wt_role', 'guest');
    ss.set('wt_room', code);
    if (!peer || peer.destroyed) {
      peer = new window.Peer(PEER_OPTS);
      peer.on('open', () => connectToHost(joinMsg));
      peer.on('error', (e) => {
        if (e.type === 'peer-unavailable') {
          if ((hostConn?.everOpen || retry > 0) && retry < 8) scheduleReconnect(joinMsg);
          else { h.message({ t: 'error', key: 'noRoom' }); shutdown(); }
        } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
          scheduleReconnect(joinMsg);
        } else h.status('peerError', e.type);
      });
      peer.on('disconnected', () => { if (!closed) setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 1500); });
    } else connectToHost(joinMsg);
  }
  function connectToHost(joinMsg) {
    if (closed) return;
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
    hostConn = conn;
    conn.on('open', () => {
      retry = 0;
      conn.everOpen = true;
      conn.send(joinMsg());
    });
    conn.on('data', (obj) => deliver(obj));
    conn.on('close', () => { if (!closed && hostConn === conn) { h.status('hostGone'); scheduleReconnect(joinMsg); } });
  }
  function scheduleReconnect(joinMsg) {
    if (closed) return;
    setTimeout(() => connectToHost(joinMsg), Math.min(5000, 800 * 2 ** retry++));
  }

  function shutdown() {
    closed = true;
    try { hostConn?.close(); } catch {}
    try { peer?.destroy(); } catch {}
    peer = null; engine = null; hostConn = null; role = null; code = null;
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
      else if (hostConn?.open) hostConn.send(obj);
      else h.status('connecting');
    },
    create(msg) {
      shutdown();
      code = null;
      startHost(() => msg, false);
    },
    join(c, msg) {
      shutdown();
      code = c; retry = 0;
      startGuest(() => msg);
    },
    leave() { shutdown(); },
  };
}

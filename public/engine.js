// Authoritative room/game engine. Transport-agnostic: runs inside the Node server (WebSocket mode)
// and inside the host's browser (P2P mode for static hosting such as GitHub Pages).
//
//   const engine = createEngine({ sendTo: (connId, obj) => ... });
//   engine.handle(connId, msg); engine.disconnect(connId);
import {
  COLORS, PIECE_TYPES, MAX_PLAYERS, emptyWalls, setWall, pieceAt, findMove, mustStay, freeSides, freeSidesAfter,
  legalActions, analyze,
} from './rules.js';

const isDirs = (a) => Array.isArray(a) && a.length <= 2 && a.every((d) => ['up', 'down', 'left', 'right'].includes(d));
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randInt(n) {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] % n;
}
export function randomCode() { return Array.from({ length: 4 }, () => CODE_CHARS[randInt(CODE_CHARS.length)]).join(''); }
const randomId = () => Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randInt(36)]).join('');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

export function createEngine({ sendTo, fixedCode = null, onChange = null }) {
  const rooms = new Map(); // code -> room
  const conns = new Map(); // connId -> { token, code }

  function createRoom(code) {
    if (!code) do { code = randomCode(); } while (rooms.has(code));
    const room = {
      code, hostId: null, members: [], // { id, token, name, conn, connected }
      settings: { size: 7, turnSeconds: 90 },
      game: null, chat: [], timer: null, emptySince: null,
    };
    rooms.set(code, room);
    return room;
  }

  function roomView(room) {
    const g = room.game;
    return {
      code: room.code, hostId: room.hostId, settings: room.settings,
      members: room.members.map((m) => ({ id: m.id, name: m.name, connected: m.connected })),
      chat: room.chat.slice(-60),
      game: g && {
        n: g.n, settings: g.settings, phase: g.phase, walls: g.walls,
        players: g.players.map((p) => ({ id: p.id, name: p.name, color: p.color, pieces: p.pieces, breakUsed: p.breakUsed })),
        current: g.current, deadline: g.deadline, placeIndex: g.placeIndex, placeTotal: g.placeOrder.length,
        last: g.last, result: g.result, turnCount: g.turnCount,
      },
    };
  }

  function broadcast(room) {
    const payload = { t: 'room', room: roomView(room), now: Date.now() };
    for (const m of room.members) if (m.connected && m.conn) sendTo(m.conn, payload);
    onChange?.(room);
  }
  const err = (connId, key, params) => {
    sendTo(connId, { t: 'error', key, params });
    if (['notPlacement', 'notPlay', 'notYourTurn', 'occupied', 'cantMove', 'cantWall', 'badType', 'breakUsed', 'mustMove'].includes(key)) resync(connId);
  };
  const sysChat = (room, key, params = {}) => room.chat.push({ sys: true, key, params, at: Date.now() });

  // ---------- game flow ----------
  function startGame(room) {
    const seated = room.members.filter((m) => m.connected).slice(0, MAX_PLAYERS);
    const P = seated.length;
    const s = room.settings;
    const n = s.size;
    const per = PIECE_TYPES.length; // one square + one round piece each
    for (let i = seated.length - 1; i > 0; i--) { const j = randInt(i + 1); [seated[i], seated[j]] = [seated[j], seated[i]]; }
    const order = [...Array(P).keys()];
    const placeOrder = [...order, ...order.slice().reverse()]; // first piece in seat order, second in reverse
    room.game = {
      n, settings: { ...s, pieces: per }, phase: 'placement', walls: emptyWalls(n),
      players: seated.map((m, i) => ({ id: m.id, name: m.name, color: COLORS[i], pieces: [], breakUsed: false })),
      placeOrder, placeIndex: 0, current: placeOrder[0], deadline: 0, last: null, result: null, turnCount: 0,
    };
    sysChat(room, 'start', { P, per, n });
    armTimer(room);
  }

  function armTimer(room) {
    clearTimeout(room.timer);
    const g = room.game;
    if (!g || g.phase === 'ended') return;
    const secs = g.settings.turnSeconds;
    if (!secs) { g.deadline = 0; return; }
    if (!g.deadline || g.deadline < Date.now()) g.deadline = Date.now() + secs * 1000;
    room.timer = setTimeout(() => autoAct(room), g.deadline - Date.now() + 300);
  }
  const resetDeadline = (room) => { if (room.game) room.game.deadline = 0; armTimer(room); };

  function autoAct(room) {
    const g = room.game;
    if (!g || g.phase === 'ended') return;
    const name = g.players[g.current].name;
    if (g.phase === 'placement') {
      const empty = [];
      for (let r = 0; r < g.n; r++) for (let c = 0; c < g.n; c++) if (!pieceAt(g.players, r, c)) empty.push({ r, c });
      const cell = empty[randInt(empty.length)];
      const left = remainingTypes(g.players[g.current]);
      sysChat(room, 'timeoutPlace', { name });
      doPlace(room, g.current, cell.r, cell.c, left[randInt(left.length)]);
    } else {
      // Time-out: no move, a wall goes up on a random free side of a random piece.
      const pl = g.players[g.current];
      const choices = [];
      pl.pieces.forEach((pc, k) => freeSides(g, pc.r, pc.c).forEach((dir) => choices.push({ piece: k, dir })));
      sysChat(room, 'timeoutMove', { name });
      if (choices.length) {
        const ch = choices[randInt(choices.length)];
        const pc = pl.pieces[ch.piece];
        doMove(room, g.current, ch.piece, { r: pc.r, c: pc.c, path: [], broken: null }, ch.dir);
      } else advanceTurn(room);
    }
    broadcast(room);
  }

  function remainingTypes(pl) { return PIECE_TYPES.filter((t) => !pl.pieces.some((pc) => pc.type === t)); }

  function doPlace(room, p, r, c, type) {
    const g = room.game;
    g.players[p].pieces.push({ r, c, type });
    g.last = { type: 'place', player: p, r, c };
    g.placeIndex++;
    if (g.placeIndex >= g.placeOrder.length) {
      g.phase = 'play';
      sysChat(room, 'placeDone');
      g.current = g.players.length - 1; // advanceTurn steps to seat 0
      advanceTurn(room);
    } else {
      g.current = g.placeOrder[g.placeIndex];
      resetDeadline(room);
    }
  }

  function doMove(room, p, piece, opt, dir) {
    const g = room.game;
    const pl = g.players[p];
    const pc = pl.pieces[piece];
    const from = { r: pc.r, c: pc.c };
    if (opt.broken) {
      setWall(g.walls, opt.broken.r, opt.broken.c, opt.broken.dir, false);
      pl.breakUsed = true;
      sysChat(room, 'broke', { name: pl.name });
    }
    pc.r = opt.r; pc.c = opt.c;
    setWall(g.walls, opt.r, opt.c, dir);
    g.turnCount++;
    g.last = { type: 'move', player: p, piece, from, path: opt.path, r: opt.r, c: opt.c, dir, broken: opt.broken };
    advanceTurn(room);
  }

  function advanceTurn(room) {
    const g = room.game;
    const a = analyze(g);
    if (a.allSealed) return endGame(room, a);
    const P = g.players.length;
    for (let i = 1; i <= P; i++) {
      const next = (g.current + i) % P;
      // A separated player keeps playing only while their wall-break could still get them out.
      const active = !a.sealed[next] || !g.players[next].breakUsed;
      if (active && legalActions(g, next).length) { g.current = next; resetDeadline(room); return; }
    }
    endGame(room, a);
  }

  function endGame(room, a) {
    const g = room.game;
    clearTimeout(room.timer);
    g.phase = 'ended';
    g.deadline = 0;
    const ranking = g.players
      .map((p, i) => ({ idx: i, name: p.name, score: a.scores[i], biggest: a.biggest[i] }))
      .sort((x, y) => y.score - x.score || y.biggest - x.biggest);
    ranking.forEach((r, i) => {
      const prev = ranking[i - 1];
      r.rank = prev && prev.score === r.score && prev.biggest === r.biggest ? prev.rank : i + 1;
    });
    g.result = { ranking };
    sysChat(room, 'end', { winners: ranking.filter((r) => r.rank === 1).map((r) => r.name).join(', '), score: ranking[0].score });
  }

  // ---------- membership ----------
  function memberOf(connId) {
    const s = conns.get(connId);
    if (!s?.code) return {};
    const room = rooms.get(s.code);
    if (!room) return {};
    return { room, me: room.members.find((m) => m.token === s.token) };
  }

  function joinRoom(connId, room, token, name) {
    let me = room.members.find((m) => m.token === token);
    if (me) {
      if (me.conn && me.conn !== connId && me.connected) sendTo(me.conn, { t: 'kicked', key: 'otherWindow' });
      me.conn = connId; me.connected = true; if (name) me.name = name;
    } else {
      me = { id: randomId(), token, name: name || 'Player', conn: connId, connected: true };
      room.members.push(me);
      sysChat(room, 'join', { name: me.name, spectate: !!(room.game && room.game.phase !== 'ended') });
    }
    if (!room.hostId || !room.members.find((m) => m.id === room.hostId)) room.hostId = me.id;
    room.emptySince = null;
    conns.set(connId, { token, code: room.code });
    sendTo(connId, { t: 'joined', code: room.code, you: me.id });
    broadcast(room);
  }

  function leave(connId) {
    const s = conns.get(connId);
    if (!s?.code) return;
    const room = rooms.get(s.code);
    conns.set(connId, { token: s.token });
    if (!room) return;
    const idx = room.members.findIndex((m) => m.token === s.token);
    if (idx === -1) return;
    const me = room.members[idx];
    const inGame = room.game && room.game.phase !== 'ended' && room.game.players.some((p) => p.id === me.id);
    if (inGame) me.connected = false; // keep seat; their turns time out
    else room.members.splice(idx, 1);
    sysChat(room, 'leave', { name: me.name });
    reassignHost(room);
    broadcast(room);
  }

  function reassignHost(room) {
    if (fixedCode) return; // P2P: the browser that runs the engine stays host
    const host = room.members.find((m) => m.id === room.hostId);
    if (!host || !host.connected) {
      const next = room.members.find((m) => m.connected);
      if (next) room.hostId = next.id;
    }
    if (!room.members.some((m) => m.connected)) room.emptySince = Date.now();
  }

  // ---------- messages ----------
  function handle(connId, msg) {
    if (!msg || typeof msg !== 'object') return;
    try { handleInner(connId, msg); } catch (e) { console.error(e); err(connId, 'server'); }
  }

  // A rejected action usually means the client's view is stale (e.g. a dropped relay message):
  // send that player the current state so it heals itself.
  function resync(connId) {
    const { room } = memberOf(connId);
    if (room) sendTo(connId, { t: 'room', room: roomView(room), now: Date.now() });
  }

  function handleInner(connId, msg) {
    const s = conns.get(connId);
    const token = clean(msg.token || s?.token, 64);
    if (!token) return err(connId, 'noToken');
    conns.set(connId, { ...s, token });
    const name = clean(msg.name, 12);

    switch (msg.t) {
      case 'create': {
        if (!name) return err(connId, 'needName');
        leave(connId);
        joinRoom(connId, rooms.get(fixedCode) || createRoom(fixedCode), token, name);
        return;
      }
      case 'join': {
        const room = rooms.get(clean(msg.code, 8).toUpperCase());
        if (!room) return err(connId, 'noRoom');
        if (!name && !room.members.find((m) => m.token === token)) return err(connId, 'needName');
        if (s?.code && s.code !== room.code) leave(connId);
        joinRoom(connId, room, token, name);
        return;
      }
    }

    const { room, me } = memberOf(connId);
    if (!room || !me) return err(connId, 'notInRoom');
    const g = room.game;
    const isHost = room.hostId === me.id;
    const myIdx = g ? g.players.findIndex((p) => p.id === me.id) : -1;

    switch (msg.t) {
      case 'leave': leave(connId); sendTo(connId, { t: 'left' }); return;
      case 'chat': {
        const text = clean(msg.text, 200);
        if (!text) return;
        room.chat.push({ from: me.name, id: me.id, text, at: Date.now() });
        if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
        break;
      }
      case 'settings': {
        if (!isHost) return err(connId, 'hostOnlySettings');
        if (g && g.phase !== 'ended') return err(connId, 'noChangeInGame');
        const st = room.settings;
        const int = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
        if ('size' in msg) st.size = int(msg.size, 5, 9, st.size);
        if ('turnSeconds' in msg) st.turnSeconds = int(msg.turnSeconds, 0, 300, st.turnSeconds);
        break;
      }
      case 'start': {
        if (!isHost) return err(connId, 'hostOnlyStart');
        if (g && g.phase !== 'ended') return err(connId, 'alreadyPlaying');
        if (room.members.filter((m) => m.connected).length < 2) return err(connId, 'needTwo');
        try { startGame(room); } catch (e) { return err(connId, e.message); }
        break;
      }
      case 'lobby': {
        if (!isHost) return err(connId, 'hostOnly');
        if (g && g.phase !== 'ended') return err(connId, 'afterGame');
        room.game = null;
        break;
      }
      case 'place': {
        if (!g || g.phase !== 'placement') return err(connId, 'notPlacement');
        if (myIdx !== g.current) return err(connId, 'notYourTurn');
        const r = Number(msg.r), c = Number(msg.c);
        if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= g.n || c >= g.n) return err(connId, 'badCell');
        if (pieceAt(g.players, r, c)) return err(connId, 'occupied');
        const left = remainingTypes(g.players[myIdx]);
        const type = left.length === 1 ? left[0] : String(msg.type);
        if (!left.includes(type)) return err(connId, 'badType');
        doPlace(room, myIdx, r, c, type);
        break;
      }
      case 'move': {
        if (!g || g.phase !== 'play') return err(connId, 'notPlay');
        if (myIdx !== g.current) return err(connId, 'notYourTurn');
        const pl = g.players[myIdx];
        const piece = Number(msg.piece), dir = String(msg.dir), brk = !!msg.brk;
        const pc = pl.pieces[piece];
        if (!pc) return err(connId, 'badPiece');
        if (!isDirs(msg.path)) return err(connId, 'cantMove');
        if (brk && pl.breakUsed) return err(connId, 'breakUsed');
        let opt;
        if (msg.path.length === 0) {
          if (!mustStay(g, myIdx)) return err(connId, 'mustMove');
          opt = { r: pc.r, c: pc.c, path: [], broken: null };
        } else {
          opt = findMove(g, myIdx, piece, msg.path, brk);
          if (!opt) return err(connId, 'cantMove');
        }
        if (!freeSidesAfter(g, opt).includes(dir)) return err(connId, 'cantWall');
        doMove(room, myIdx, piece, opt, dir);
        break;
      }
      default: return err(connId, 'unknown');
    }
    broadcast(room);
  }

  function disconnect(connId) {
    const { room, me } = memberOf(connId);
    if (room && me && me.conn === connId) {
      me.connected = false;
      reassignHost(room);
      broadcast(room);
    }
    conns.delete(connId);
  }

  // Remove rooms nobody has been connected to for `ms`.
  function sweep(ms = 10 * 60 * 1000) {
    for (const [code, room] of rooms) {
      if (room.emptySince && Date.now() - room.emptySince > ms) { clearTimeout(room.timer); rooms.delete(code); }
    }
  }

  // P2P host persistence: lets the host refresh the page without losing the game.
  function exportRoom(code) {
    const room = rooms.get(code);
    if (!room) return null;
    const { timer, ...rest } = room;
    return JSON.stringify({ ...rest, members: room.members.map((m) => ({ ...m, conn: null, connected: false })) });
  }
  function importRoom(json) {
    const data = JSON.parse(json);
    const room = { ...data, timer: null, emptySince: null };
    rooms.set(room.code, room);
    if (room.game && room.game.phase !== 'ended') armTimer(room);
    return room;
  }

  return { handle, disconnect, sweep, exportRoom, importRoom };
}

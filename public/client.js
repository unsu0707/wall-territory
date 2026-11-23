import { moveOptions, mustStay, freeSidesAfter, pieceAt, analyze, PIECE_TYPES, MAX_PLAYERS } from './rules.js?v=__V__';
import { t, setLang, applyStatic } from './i18n.js?v=__V__';
import { detectMode, createNet } from './net.js?v=__V__';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// Name lives in localStorage; identity token + room live per tab (sessionStorage) so a refresh
// reconnects you, while two tabs in the same browser count as two different players.
const storageFor = (k) => (k === 'wt_name' ? localStorage : sessionStorage);
const store = {
  get(k) { try { return storageFor(k).getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? storageFor(k).removeItem(k) : storageFor(k).setItem(k, v); } catch {} },
};

let token = store.get('wt_token');
if (!token) { token = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)); store.set('wt_token', token); }

let room = null;
let you = null;
let skew = 0;
let sel = null; // { piece, opt } — opt is a move option from rules.moveOptions
let placeType = 'square';
let breakMode = false;
let awaitingUntil = 0; // after sending an action, ignore board clicks until the host answers
let lastSeenChat = 0;

// ---------- connection ----------
function onMessage(msg) {
  if (msg.t === 'joined') {
    setBusy(false);
    you = msg.you;
    store.set('wt_room', msg.code);
    history.replaceState(null, '', `?room=${msg.code}`);
    show('room');
  } else if (msg.t === 'room') {
    awaitingUntil = 0;
    skew = msg.now - Date.now();
    const prevTurn = room?.game && `${room.game.phase}:${room.game.current}:${room.game.turnCount}:${room.game.placeIndex}`;
    room = msg.room;
    const g = room.game;
    const nowTurn = g && `${g.phase}:${g.current}:${g.turnCount}:${g.placeIndex}`;
    if (prevTurn !== nowTurn) { sel = null; breakMode = false; }
    render();
  } else if (msg.t === 'error') {
    awaitingUntil = 0;
    toast(t('err.' + msg.key, msg.params));
    if (['connectFail', 'hostLost', 'hostClosed'].includes(msg.key) || (msg.key === 'noRoom' && !room)) goHome();
    setBusy(false);
  } else if (msg.t === 'left') {
    goHome();
  } else if (msg.t === 'kicked') {
    toast(t('err.' + msg.key)); room = null; show('home');
  }
}
function goHome() {
  room = null;
  setBusy(false);
  net.leave();
  store.set('wt_room', null);
  history.replaceState(null, '', location.pathname);
  show('home');
}
function setBusy(kind) {
  const c = $('createBtn'), j = $('joinBtn');
  c.disabled = j.disabled = !!kind;
  c.textContent = t(kind === 'creating' ? 'home.creating' : 'home.create');
  j.textContent = t(kind === 'joining' ? 'home.joining' : 'home.join');
}
function onStatus(key, info) {
  if (key === 'joining' || key === 'creating') { if (!room) setBusy(key); return; }
  if (key === 'relay') { toast(t('toast.relay'), true); return; }
  if (key === 'joinFailed') { setBusy(false); return; }
  if (key === 'disconnected' || key === 'hostGone') { if (room) toast(t('toast.' + key), true); }
  else if (key === 'connecting') toast(t('toast.connecting'));
  else if (key === 'peerError') toast(t('toast.peerError', { info: info || '' }));
}
const net = createNet(await detectMode(), {
  message: onMessage,
  status: onStatus,
  resumeMsg: (code) => ({ t: 'join', code, name: store.get('wt_name') || '', token }),
});
function send(obj) { net.send({ ...obj, token }); }

let toastTimer;
function toast(text, info = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast show' + (info ? ' info' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast' + (info ? ' info' : '')), 2400);
}
function show(screen) { $('home').classList.toggle('hidden', screen !== 'home'); $('room').classList.toggle('hidden', screen !== 'room'); }

// ---------- home ----------
$('nameInput').value = store.get('wt_name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('codeInput').value = urlRoom.toUpperCase();

function getName() {
  const name = $('nameInput').value.trim();
  if (!name) { toast(t('toast.needName')); $('nameInput').focus(); return null; }
  store.set('wt_name', name);
  return name;
}
$('createBtn').onclick = () => { const name = getName(); if (name) net.create({ t: 'create', name, token }); };
$('joinBtn').onclick = () => {
  const name = getName(); if (!name) return;
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) return toast(t('toast.needCode'));
  net.join(code, { t: 'join', code, name, token });
};
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('codeInput').value ? $('joinBtn') : $('createBtn')).click(); });

// ---------- room controls ----------
$('leaveBtn').onclick = () => {
  const g = room?.game;
  if (net.isHostDevice() && room.members.length > 1) { if (!confirm(t('confirm.hostLeave'))) return; }
  else if (g && g.phase !== 'ended' && g.players.some((p) => p.id === you) && !confirm(t('confirm.leave'))) return;
  send({ t: 'leave' });
};
$('codeChip').onclick = async () => {
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  try { await navigator.clipboard.writeText(link); toast(t('toast.copied'), true); } catch { prompt(t('prompt.link'), link); }
};
function fillOptions() {
  const opts = (list) => list.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  $('setSize').innerHTML = opts([5, 6, 7, 8, 9].map((s) => [s, `${s}×${s}`]));
  $('setTime').innerHTML = opts([...[30, 60, 90, 120].map((k) => [k, t('opt.secs', { k })]), [0, t('opt.none')]]);
}
function refreshLang() { applyStatic(); fillOptions(); render(); }
document.querySelectorAll('[data-lang]').forEach((b) => (b.onclick = () => { setLang(b.dataset.lang); refreshLang(); }));
refreshLang();
const bindSetting = (id, key) => ($(id).onchange = (e) => send({ t: 'settings', [key]: Number(e.target.value) }));
bindSetting('setSize', 'size'); bindSetting('setTime', 'turnSeconds');
$('startBtn').onclick = () => send({ t: 'start' });
$('againBtn').onclick = () => send({ t: 'lobby' });
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (text) send({ t: 'chat', text });
  $('chatInput').value = '';
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sel) { sel = null; render(); } });

// ---------- render ----------
function render() {
  if (!room) return;
  const g = room.game;
  const isHost = room.hostId === you;
  $('roomCode').textContent = room.code;

  const inLobby = !g;
  $('lobbyPanel').classList.toggle('hidden', !inLobby);
  $('resultPanel').classList.toggle('hidden', !(g && g.phase === 'ended'));

  // lobby settings
  const st = room.settings;
  $('setSize').value = st.size; $('setTime').value = st.turnSeconds;
  for (const id of ['setSize', 'setTime']) $(id).disabled = !isHost;
  const online = room.members.filter((m) => m.connected).length;
  $('startBtn').disabled = !isHost || online < 2;
  $('startBtn').classList.toggle('hidden', !isHost);
  const seats = Math.min(online, MAX_PLAYERS);
  $('lobbyHint').textContent = !isHost
    ? t('lobby.wait')
    : online < 2 ? t('lobby.invite')
    : t('lobby.ready', { seats }) + (online > MAX_PLAYERS ? t('lobby.overflow') : '');

  $('p2pHint').classList.toggle('hidden', net.mode !== 'p2p');
  renderPlayers();
  renderStatus();
  renderBoard();
  renderResult();
  renderChat();
}

function renderPlayers() {
  const g = room.game;
  const list = $('playerList');
  if (!g) {
    $('playersTitle').textContent = t('players.members', { n: room.members.length });
    list.innerHTML = room.members.map((m) => `
      <li class="${m.connected ? '' : 'off'}"><span class="sw" style="background:#5b6475"></span>
      <span class="nm">${esc(m.name)}${m.id === you ? t('players.me') : ''}</span>
      ${m.id === room.hostId ? `<span class="badge">${t('badge.host')}</span>` : ''}${m.connected ? '' : `<span class="badge">${t('badge.offline')}</span>`}</li>`).join('');
    return;
  }
  const a = analyze(g);
  $('playersTitle').textContent = t(g.phase === 'ended' ? 'players.final' : 'players.live');
  const memberById = Object.fromEntries(room.members.map((m) => [m.id, m]));
  list.innerHTML = g.players.map((p, i) => {
    const m = memberById[p.id];
    const off = m && !m.connected;
    return `<li class="${g.phase !== 'ended' && g.current === i ? 'turn' : ''}">
      <span class="sw" style="background:${p.color}"></span>
      <span class="nm ${off ? 'off' : ''}">${esc(p.name)}${p.id === you ? t('players.me') : ''}</span>
      ${a.sealed[i] && g.phase === 'play' ? `<span class="badge">${t('badge.sealed')}</span>` : ''}
      ${g.phase !== 'ended' ? `<span class="badge ${p.breakUsed ? 'used' : ''}" title="${t('badge.breakTip')}">${t('badge.break')}</span>` : ''}
      ${off ? `<span class="badge">${t('badge.offline')}</span>` : ''}
      <span class="score">${a.scores[i]}</span></li>`;
  }).join('');
  const spect = room.members.filter((m) => !g.players.some((p) => p.id === m.id));
  if (spect.length) list.insertAdjacentHTML('beforeend', `<li class="off"><span class="nm">${t('players.spectators', { names: spect.map((m) => esc(m.name)).join(', ') })}</span></li>`);
}

function myIndex() { return room.game ? room.game.players.findIndex((p) => p.id === you) : -1; }

function renderStatus() {
  const g = room.game;
  const el = $('status');
  const bar = $('actionBar');
  if (!g) {
    el.className = 'status';
    el.textContent = t('status.lobby');
    bar.textContent = '';
    return;
  }
  const me = myIndex();
  const cur = g.players[g.current];
  const mine = g.current === me && g.phase !== 'ended';
  el.className = 'status' + (mine ? ' mine' : '');
  let text;
  const prog = { i: g.placeIndex + 1, n: g.placeTotal, name: esc(cur.name) };
  if (g.phase === 'placement') text = t(mine ? 'status.placeMine' : 'status.placeOther', prog);
  else if (g.phase === 'play') text = t(mine ? 'status.playMine' : 'status.playOther', prog);
  else text = t('status.ended');
  el.innerHTML = `${g.phase !== 'ended' ? `<span class="dot" style="background:${cur.color}"></span>` : ''}<span>${text}</span><span class="timer" id="timer"></span>`;
  tickTimer();

  bar.innerHTML = '';
  if (g.phase === 'placement' && mine) {
    const left = remainingTypes(g.players[me]);
    if (!left.includes(placeType)) placeType = left[0];
    bar.innerHTML = `<span>${t('bar.placeType')}</span>` + left.map((ty) =>
      `<button class="btn small type-btn ${ty === placeType ? 'on' : ''}" data-type="${ty}">${typeIcon(ty)} ${t('piece.' + ty)}</button>`).join('');
    bar.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => { placeType = b.dataset.type; render(); }));
  } else if (g.phase === 'play' && mine) {
    const pl = g.players[me];
    const stay = mustStay(g, me);
    let hint;
    if (!sel) hint = stay ? t('bar.stuck') : t('bar.pick');
    else if (!sel.opt) hint = t('bar.dest');
    else hint = t('bar.wall');
    bar.innerHTML = `<span>${hint}</span>`;
    if (!pl.breakUsed && !stay) {
      bar.insertAdjacentHTML('beforeend', `<button class="btn small break-btn ${breakMode ? 'on' : ''}" id="breakBtn">${t(breakMode ? 'bar.breakOn' : 'bar.breakOff')}</button>`);
      $('breakBtn').onclick = () => { breakMode = !breakMode; if (sel) sel.opt = null; render(); };
    }
    if (sel) {
      bar.insertAdjacentHTML('beforeend', `<button class="btn small ghost" id="cancelSel">${t('bar.repick')}</button>`);
      $('cancelSel').onclick = () => { sel = null; render(); };
    }
  } else if (g.phase === 'ended') {
    bar.textContent = t('bar.ended');
  } else {
    bar.textContent = me === -1 ? t('bar.spectating') : '';
  }
}

function remainingTypes(pl) { return PIECE_TYPES.filter((ty) => !pl.pieces.some((pc) => pc.type === ty)); }
const typeIcon = (ty) => (ty === 'square' ? '■' : '●');

function tickTimer() {
  const el = document.getElementById('timer');
  const g = room?.game;
  if (!el || !g) return;
  if (!g.deadline || g.phase === 'ended') { el.textContent = ''; return; }
  const left = Math.max(0, Math.ceil((g.deadline - (Date.now() + skew)) / 1000));
  el.textContent = `${left}s`;
  el.classList.toggle('low', left <= 10);
}
setInterval(tickTimer, 250);

// Board geometry
const S = 64, PAD = 18;
const cx = (c) => PAD + c * S, cy = (r) => PAD + r * S;
function edgeCoords(r, c, dir) {
  const x = cx(c), y = cy(r);
  switch (dir) {
    case 'up': return [x, y, x + S, y];
    case 'down': return [x, y + S, x + S, y + S];
    case 'left': return [x, y, x, y + S];
    case 'right': return [x + S, y, x + S, y + S];
  }
}

// Move options for the selected piece, grouped by destination cell. Prefer a path that breaks nothing.
function optionsByCell(g, me, k) {
  const map = new Map();
  for (const o of moveOptions(g, me, k, breakMode && !g.players[me].breakUsed)) {
    const key = o.r * g.n + o.c;
    const prev = map.get(key);
    if (!prev || (prev.broken && !o.broken)) map.set(key, o);
  }
  return map;
}

function renderBoard() {
  const svg = $('board');
  const g = room.game;
  const n = g ? g.n : room.settings.size;
  const W = n * S + PAD * 2;
  svg.setAttribute('viewBox', `0 0 ${W} ${W}`);
  const parts = [];
  const me = myIndex();
  const mine = g && g.current === me && g.phase !== 'ended';
  const a = g && g.phase !== 'placement' ? analyze(g) : null;

  let reach = new Map();
  if (g && g.phase === 'play' && mine && sel && !sel.opt) reach = optionsByCell(g, me, sel.piece);
  const brokenPreview = sel?.opt?.broken || null;

  parts.push(`<rect x="${PAD - 6}" y="${PAD - 6}" width="${n * S + 12}" height="${n * S + 12}" rx="10" fill="#141820" stroke="#2a313d"/>`);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = r * n + c;
    let cls = 'cell' + ((r + c) % 2 ? ' alt' : '');
    if (reach.has(i)) cls += reach.get(i).broken ? ' reach breakreach' : ' reach';
    if (g && g.phase === 'placement' && mine && !pieceAt(g.players, r, c)) cls += ' placeable';
    parts.push(`<rect class="${cls}" data-r="${r}" data-c="${c}" x="${cx(c) + 1.5}" y="${cy(r) + 1.5}" width="${S - 3}" height="${S - 3}" rx="6"/>`);
    if (a && a.cellOwner[i] !== -1) {
      const col = g.players[a.cellOwner[i]].color;
      parts.push(`<rect pointer-events="none" x="${cx(c) + 1.5}" y="${cy(r) + 1.5}" width="${S - 3}" height="${S - 3}" rx="6" fill="${col}" opacity="${g.phase === 'ended' ? 0.32 : 0.18}"/>`);
    }
  }
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) parts.push(`<circle class="grid-dot" cx="${cx(c)}" cy="${cy(r)}" r="2.2"/>`);

  if (g) {
    const last = g.last?.type === 'move' ? g.last : null;
    const isLast = (r, c, dir) => last && edgeKey(r, c, dir) === edgeKey(last.r, last.c, last.dir);
    const isBrokenPreview = (r, c, dir) => brokenPreview && edgeKey(r, c, dir) === edgeKey(brokenPreview.r, brokenPreview.c, brokenPreview.dir);
    const wallLine = (r, c, dir, x1, y1, x2, y2) => {
      if (isBrokenPreview(r, c, dir)) return `<line class="wall broken" stroke-width="7" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      return `<line class="wall${isLast(r, c, dir) ? ' new' : ''}" stroke-width="7" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    };
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n; c++) if (g.walls.h[r][c]) parts.push(wallLine(r, c, 'down', cx(c) + 3, cy(r + 1), cx(c + 1) - 3, cy(r + 1)));
    for (let r = 0; r < n; r++) for (let c = 0; c < n - 1; c++) if (g.walls.v[r][c]) parts.push(wallLine(r, c, 'right', cx(c + 1), cy(r) + 3, cx(c + 1), cy(r + 1) - 3));
    // where the last broken wall used to be
    if (last?.broken) {
      const [x1, y1, x2, y2] = edgeCoords(last.broken.r, last.broken.c, last.broken.dir);
      parts.push(`<line pointer-events="none" stroke="#ff6b6b" stroke-width="3" stroke-dasharray="3 7" stroke-linecap="round" opacity=".8" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    }
    // last move trail (follows the actual path, so the round piece's turn is visible)
    if (last && last.path?.length) {
      const DR = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
      let rr = last.from.r, cc = last.from.c;
      const pts = [[cx(cc) + S / 2, cy(rr) + S / 2]];
      for (const d of last.path) { rr += DR[d][0]; cc += DR[d][1]; pts.push([cx(cc) + S / 2, cy(rr) + S / 2]); }
      const col = g.players[last.player].color;
      parts.push(`<polyline pointer-events="none" points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${col}" stroke-width="3" stroke-dasharray="4 6" opacity=".6"/>`);
      parts.push(`<circle pointer-events="none" cx="${pts[0][0]}" cy="${pts[0][1]}" r="6" fill="none" stroke="${col}" opacity=".5"/>`);
    }
    g.players.forEach((p, pi) => p.pieces.forEach((pc, k) => {
      const selected = sel && pi === me && sel.piece === k;
      const movable = mine && g.phase === 'play' && pi === me;
      const moved = selected && sel.opt && (sel.opt.r !== pc.r || sel.opt.c !== pc.c);
      parts.push(pieceSvg(pc.r, pc.c, p.color, pc.type, `piece${movable ? ' mine' : ''}${selected ? ' sel' : ''}${moved ? ' ghost-piece' : ''}`, pi, k, pi === me));
    }));
    if (mine && g.phase === 'play' && sel?.opt) {
      const { r, c } = sel.opt;
      const pc = g.players[me].pieces[sel.piece];
      if (pc.r !== r || pc.c !== c) parts.push(pieceSvg(r, c, g.players[me].color, pc.type, 'piece sel', me, sel.piece, true));
      for (const dir of freeSidesAfter(g, sel.opt)) {
        const [x1, y1, x2, y2] = edgeCoords(r, c, dir);
        const sx = (x2 - x1) ? 6 : 0, sy = (y2 - y1) ? 6 : 0;
        parts.push(`<line class="edge-opt" data-wall="${dir}" stroke-width="9" x1="${x1 + sx}" y1="${y1 + sy}" x2="${x2 - sx}" y2="${y2 - sy}"/>`);
        parts.push(`<line class="edge-hit" data-wall="${dir}" stroke-width="26" x1="${x1 + sx}" y1="${y1 + sy}" x2="${x2 - sx}" y2="${y2 - sy}"/>`);
      }
    }
  }
  svg.innerHTML = parts.join('');
}

function edgeKey(r, c, dir) {
  if (dir === 'up') return `h${r - 1},${c}`;
  if (dir === 'down') return `h${r},${c}`;
  if (dir === 'left') return `v${r},${c - 1}`;
  return `v${r},${c}`;
}

function pieceSvg(r, c, color, type, cls, pi, k, isMine) {
  const x = cx(c) + S / 2, y = cy(r) + S / 2;
  const R = S * 0.28;
  const body = type === 'square'
    ? `<rect class="body" x="${x - R}" y="${y - R}" width="${R * 2}" height="${R * 2}" rx="5" fill="${color}" stroke-width="2"/>`
    : `<circle class="body" cx="${x}" cy="${y}" r="${R}" fill="${color}" stroke-width="2"/>`;
  const ring = type === 'square'
    ? `<rect class="ring" x="${x - S * 0.37}" y="${y - S * 0.37}" width="${S * 0.74}" height="${S * 0.74}" rx="9" fill="none" stroke="transparent" stroke-width="3"/>`
    : `<circle class="ring" cx="${x}" cy="${y}" r="${S * 0.37}" fill="none" stroke="transparent" stroke-width="3"/>`;
  return `<g class="${cls}" data-p="${pi}" data-k="${k}">
    ${ring}${body}
    <circle cx="${x - S * 0.08}" cy="${y - S * 0.09}" r="${S * 0.07}" fill="rgba(255,255,255,.35)" pointer-events="none"/>
    ${isMine ? `<circle cx="${x}" cy="${y}" r="${S * 0.07}" fill="rgba(0,0,0,.35)" pointer-events="none"/>` : ''}
  </g>`;
}

$('board').addEventListener('click', (e) => {
  const g = room?.game;
  if (!g) return;
  const me = myIndex();
  if (g.current !== me || g.phase === 'ended') return;
  if (Date.now() < awaitingUntil) return;
  const act = (obj) => { awaitingUntil = Date.now() + 4000; send(obj); };
  const wallEl = e.target.closest('[data-wall]');
  const pieceEl = e.target.closest('[data-p]');
  const cellEl = e.target.closest('[data-r]');

  if (g.phase === 'placement') {
    if (cellEl) act({ t: 'place', r: +cellEl.dataset.r, c: +cellEl.dataset.c, type: placeType });
    return;
  }
  if (wallEl && sel?.opt) {
    act({ t: 'move', piece: sel.piece, path: sel.opt.path, brk: !!sel.opt.broken, dir: wallEl.dataset.wall });
    return;
  }
  if (pieceEl && +pieceEl.dataset.p === me && !pieceEl.classList.contains('ghost-piece')) {
    const k = +pieceEl.dataset.k;
    const pc = g.players[me].pieces[k];
    // Neither piece can move at all → build a wall without moving.
    if (mustStay(g, me)) sel = { piece: k, opt: { r: pc.r, c: pc.c, path: [], broken: null } };
    else sel = { piece: k, opt: null };
    render();
    return;
  }
  if (cellEl && sel && !sel.opt) {
    const opt = optionsByCell(g, me, sel.piece).get(+cellEl.dataset.r * g.n + +cellEl.dataset.c);
    if (opt) { sel.opt = opt; render(); return; }
  }
  if (sel) { sel = null; render(); }
});

function renderResult() {
  const g = room.game;
  if (!g || g.phase !== 'ended' || !g.result) return;
  $('resultList').innerHTML = g.result.ranking.map((r) => `
    <li class="${r.rank === 1 ? 'win' : ''}"><span class="rk">${r.rank}</span>
      <span class="sw" style="width:12px;height:12px;border-radius:50%;background:${g.players[r.idx].color}"></span>
      <span>${esc(r.name)}<br><span class="sub">${t('result.biggest', { n: r.biggest })}</span></span>
      <span class="pts">${t('result.pts', { n: r.score })}</span></li>`).join('');
  $('againBtn').classList.toggle('hidden', room.hostId !== you);
}

function sysText(m) {
  if (m.key === 'join' && m.params?.spectate) return t('sys.joinSpectate', m.params);
  return t('sys.' + m.key, m.params);
}

function renderChat() {
  const log = $('chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = room.chat.map((m) => (m.sys ? `<div class="sys">${esc(sysText(m))}</div>` : `<div><b>${esc(m.from)}</b> ${esc(m.text)}</div>`)).join('');
  const newest = room.chat.at(-1)?.at || 0;
  if (atBottom || newest !== lastSeenChat) log.scrollTop = log.scrollHeight;
  lastSeenChat = newest;
}


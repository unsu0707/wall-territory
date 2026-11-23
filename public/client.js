import { reachable, freeSides, pieceAt, analyze, defaultPieces } from './rules.js';
import { t, setLang, applyStatic } from './i18n.js';
import { detectMode, createNet } from './net.js';

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
let sel = null; // { piece, dest }
let lastSeenChat = 0;

// ---------- connection ----------
function onMessage(msg) {
  if (msg.t === 'joined') {
    you = msg.you;
    store.set('wt_room', msg.code);
    history.replaceState(null, '', `?room=${msg.code}`);
    show('room');
  } else if (msg.t === 'room') {
    skew = msg.now - Date.now();
    const prevTurn = room?.game && `${room.game.phase}:${room.game.current}:${room.game.turnCount}:${room.game.placeIndex}`;
    room = msg.room;
    const g = room.game;
    const nowTurn = g && `${g.phase}:${g.current}:${g.turnCount}:${g.placeIndex}`;
    if (prevTurn !== nowTurn) sel = null;
    render();
  } else if (msg.t === 'error') {
    toast(t('err.' + msg.key, msg.params));
    if (msg.key === 'noRoom' && !room) goHome();
  } else if (msg.t === 'left') {
    goHome();
  } else if (msg.t === 'kicked') {
    toast(t('err.' + msg.key)); room = null; show('home');
  }
}
function goHome() {
  room = null;
  net.leave();
  store.set('wt_room', null);
  history.replaceState(null, '', location.pathname);
  show('home');
}
function onStatus(key, info) {
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
  $('setSize').innerHTML = opts([5, 6, 7, 8, 9, 10, 11].map((s) => [s, `${s}×${s}`]));
  $('setPieces').innerHTML = opts([[0, t('opt.auto')], ...[1, 2, 3, 4, 5, 6].map((k) => [k, t('opt.pieces', { k })])]);
  $('setSteps').innerHTML = opts([1, 2, 3].map((k) => [k, t('opt.steps', { k })]));
  $('setTime').innerHTML = opts([...[30, 60, 90, 120].map((k) => [k, t('opt.secs', { k })]), [0, t('opt.none')]]);
}
function refreshLang() { applyStatic(); fillOptions(); render(); }
document.querySelectorAll('[data-lang]').forEach((b) => (b.onclick = () => { setLang(b.dataset.lang); refreshLang(); }));
refreshLang();
const bindSetting = (id, key) => ($(id).onchange = (e) => send({ t: 'settings', [key]: Number(e.target.value) }));
bindSetting('setSize', 'size'); bindSetting('setPieces', 'pieces'); bindSetting('setSteps', 'moveSteps'); bindSetting('setTime', 'turnSeconds');
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
  $('setSize').value = st.size; $('setPieces').value = st.pieces; $('setSteps').value = st.moveSteps; $('setTime').value = st.turnSeconds;
  for (const id of ['setSize', 'setPieces', 'setSteps', 'setTime']) $(id).disabled = !isHost;
  const online = room.members.filter((m) => m.connected).length;
  $('startBtn').disabled = !isHost || online < 2;
  $('startBtn').classList.toggle('hidden', !isHost);
  const seats = Math.min(online, 4);
  $('lobbyHint').textContent = !isHost
    ? t('lobby.wait')
    : online < 2 ? t('lobby.invite')
    : t('lobby.ready', { seats, per: st.pieces || defaultPieces(seats) }) + (online > 4 ? t('lobby.overflow') : '');

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
  const cur = g.players[g.current];
  const mine = g.current === myIndex() && g.phase !== 'ended';
  el.className = 'status' + (mine ? ' mine' : '');
  let text;
  const prog = { i: g.placeIndex + 1, n: g.placeTotal, name: esc(cur.name) };
  if (g.phase === 'placement') text = t(mine ? 'status.placeMine' : 'status.placeOther', prog);
  else if (g.phase === 'play') text = t(mine ? 'status.playMine' : 'status.playOther', prog);
  else text = t('status.ended');
  el.innerHTML = `${g.phase !== 'ended' ? `<span class="dot" style="background:${cur.color}"></span>` : ''}<span>${text}</span><span class="timer" id="timer"></span>`;
  tickTimer();

  if (g.phase === 'play' && mine) {
    if (!sel) bar.textContent = t('bar.pick');
    else if (!sel.dest) bar.innerHTML = t('bar.dest');
    else bar.innerHTML = `${t('bar.wall')} <button class="btn small ghost" id="cancelSel">${t('bar.repick')}</button>`;
    const c = document.getElementById('cancelSel');
    if (c) c.onclick = () => { sel = null; render(); };
  } else if (g.phase === 'ended') {
    bar.textContent = t('bar.ended');
  } else {
    bar.textContent = myIndex() === -1 ? t('bar.spectating') : '';
  }
}

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

  let reach = new Set();
  if (g && g.phase === 'play' && mine && sel && !sel.dest) {
    for (const cell of reachable(g, me, sel.piece)) reach.add(cell.r * n + cell.c);
  }

  // board frame
  parts.push(`<rect x="${PAD - 6}" y="${PAD - 6}" width="${n * S + 12}" height="${n * S + 12}" rx="10" fill="#141820" stroke="#2a313d"/>`);
  // cells
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = r * n + c;
    let cls = 'cell' + ((r + c) % 2 ? ' alt' : '');
    if (reach.has(i)) cls += ' reach';
    if (g && g.phase === 'placement' && mine && !pieceAt(g.players, r, c)) cls += ' placeable';
    parts.push(`<rect class="${cls}" data-r="${r}" data-c="${c}" x="${cx(c) + 1.5}" y="${cy(r) + 1.5}" width="${S - 3}" height="${S - 3}" rx="6"/>`);
    if (a && a.cellOwner[i] !== -1) {
      const col = g.players[a.cellOwner[i]].color;
      parts.push(`<rect pointer-events="none" x="${cx(c) + 1.5}" y="${cy(r) + 1.5}" width="${S - 3}" height="${S - 3}" rx="6" fill="${col}" opacity="${g.phase === 'ended' ? 0.32 : 0.18}"/>`);
    }
  }
  // intersection dots
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) parts.push(`<circle class="grid-dot" cx="${cx(c)}" cy="${cy(r)}" r="2.2"/>`);

  if (g) {
    // walls
    const last = g.last?.type === 'move' ? g.last : null;
    const isLast = (r, c, dir) => last && edgeKey(r, c, dir) === edgeKey(last.r, last.c, last.dir);
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n; c++) if (g.walls.h[r][c]) {
      parts.push(`<line class="wall${isLast(r, c, 'down') ? ' new' : ''}" stroke-width="7" x1="${cx(c) + 3}" y1="${cy(r + 1)}" x2="${cx(c + 1) - 3}" y2="${cy(r + 1)}"/>`);
    }
    for (let r = 0; r < n; r++) for (let c = 0; c < n - 1; c++) if (g.walls.v[r][c]) {
      parts.push(`<line class="wall${isLast(r, c, 'right') ? ' new' : ''}" stroke-width="7" x1="${cx(c + 1)}" y1="${cy(r) + 3}" x2="${cx(c + 1)}" y2="${cy(r + 1) - 3}"/>`);
    }
    // last move trail
    if (last && (last.from.r !== last.r || last.from.c !== last.c)) {
      parts.push(`<line pointer-events="none" x1="${cx(last.from.c) + S / 2}" y1="${cy(last.from.r) + S / 2}" x2="${cx(last.c) + S / 2}" y2="${cy(last.r) + S / 2}" stroke="${g.players[last.player].color}" stroke-width="3" stroke-dasharray="4 6" opacity=".6"/>`);
      parts.push(`<circle pointer-events="none" cx="${cx(last.from.c) + S / 2}" cy="${cy(last.from.r) + S / 2}" r="6" fill="none" stroke="${g.players[last.player].color}" opacity=".5"/>`);
    }
    // pieces
    g.players.forEach((p, pi) => p.pieces.forEach((pc, k) => {
      const selected = sel && pi === me && sel.piece === k;
      const movable = mine && g.phase === 'play' && pi === me;
      const moved = selected && sel.dest && (sel.dest.r !== pc.r || sel.dest.c !== pc.c);
      parts.push(pieceSvg(pc.r, pc.c, p.color, `piece${movable ? ' mine' : ''}${selected ? ' sel' : ''}${moved ? ' ghost-piece' : ''}`, pi, k, pi === me));
    }));
    // ghost at destination + wall options
    if (mine && g.phase === 'play' && sel?.dest) {
      const { r, c } = sel.dest;
      const pc = g.players[me].pieces[sel.piece];
      if (pc.r !== r || pc.c !== c) parts.push(pieceSvg(r, c, g.players[me].color, 'piece sel', me, sel.piece, true));
      for (const dir of freeSides(g, r, c)) {
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

function pieceSvg(r, c, color, cls, pi, k, isMine) {
  const x = cx(c) + S / 2, y = cy(r) + S / 2;
  return `<g class="${cls}" data-p="${pi}" data-k="${k}">
    <circle class="ring" cx="${x}" cy="${y}" r="${S * 0.36}" fill="none" stroke="transparent" stroke-width="3"/>
    <circle class="body" cx="${x}" cy="${y}" r="${S * 0.28}" fill="${color}" stroke-width="2"/>
    <circle cx="${x - S * 0.08}" cy="${y - S * 0.09}" r="${S * 0.08}" fill="rgba(255,255,255,.35)" pointer-events="none"/>
    ${isMine ? `<circle cx="${x}" cy="${y}" r="${S * 0.07}" fill="rgba(0,0,0,.35)" pointer-events="none"/>` : ''}
  </g>`;
}

$('board').addEventListener('click', (e) => {
  const g = room?.game;
  if (!g) return;
  const me = myIndex();
  if (g.current !== me || g.phase === 'ended') return;
  const wallEl = e.target.closest('[data-wall]');
  const pieceEl = e.target.closest('[data-p]');
  const cellEl = e.target.closest('[data-r]');

  if (g.phase === 'placement') {
    if (cellEl) send({ t: 'place', r: +cellEl.dataset.r, c: +cellEl.dataset.c });
    return;
  }
  if (wallEl && sel?.dest) {
    send({ t: 'move', piece: sel.piece, r: sel.dest.r, c: sel.dest.c, dir: wallEl.dataset.wall });
    return;
  }
  if (pieceEl && +pieceEl.dataset.p === me) {
    const k = +pieceEl.dataset.k;
    const pc = g.players[me].pieces[k];
    if (sel && sel.piece === k && !sel.dest) sel.dest = { r: pc.r, c: pc.c }; // same piece again → stay in place
    else sel = { piece: k, dest: null };
    render();
    return;
  }
  if (cellEl && sel && !sel.dest) {
    const r = +cellEl.dataset.r, c = +cellEl.dataset.c;
    if (reachable(g, me, sel.piece).some((x) => x.r === r && x.c === c)) { sel.dest = { r, c }; render(); return; }
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


// End-to-end smoke test: starts the server, connects 3 bots, plays a whole game with random legal moves.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { legalActions, pieceAt, moveOptions, emptyWalls, setWall, freeSidesAfter } from './public/rules.js';

// ---- rule unit checks (Wall-go II round 1) ----
{
  const g = { n: 7, walls: emptyWalls(7), players: [{ pieces: [{ r: 3, c: 3, type: 'square' }, { r: 0, c: 0, type: 'round' }] }, { pieces: [{ r: 3, c: 5, type: 'round' }] }] };
  const key = (o) => `${o.r},${o.c}`;
  const sq = moveOptions(g, 0, 0).map(key).sort();
  assert.deepEqual(sq, ['1,3', '2,3', '3,1', '3,2', '3,4', '4,3', '5,3'].sort(), 'square: 1-2 straight, blocked by piece at 3,5');
  const rd = new Set(moveOptions(g, 1, 0).map(key));
  assert.ok(rd.has('2,5') && rd.has('2,4') && rd.has('2,6') && rd.has('4,4') && !rd.has('1,5') && !rd.has('3,3'), 'round: 1 step + optional turn, no straight 2');
  assert.ok(!moveOptions(g, 0, 0).some((o) => o.path.length === 0), 'no zero move');
  setWall(g.walls, 3, 3, 'up');
  assert.ok(!moveOptions(g, 0, 0).some((o) => o.c === 3 && o.r < 3), 'wall blocks');
  const br = moveOptions(g, 0, 0, true).filter((o) => o.c === 3 && o.r < 3);
  assert.equal(br.length, 2); assert.ok(br.every((o) => o.broken && o.broken.dir === 'up'), 'break lets it pass');
  const one = br.find((o) => o.r === 2);
  assert.ok(freeSidesAfter(g, one).includes('down'), 'broken wall side becomes free');
  setWall(g.walls, 2, 3, 'up');
  assert.ok(!moveOptions(g, 0, 0, true).some((o) => o.r === 1 && o.c === 3), 'only one wall can be broken');
  console.log('rule checks: PASS');
}


const PORT = 3999;
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 600));

const bots = [];
let code;
function bot(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const b = { ws, name, token: 'tok-' + name, id: null, room: null };
    const send = (o) => ws.send(JSON.stringify({ ...o, token: b.token }));
    b.send = send;
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'joined') { b.id = m.you; code = m.code; resolve(b); }
      if (m.t === 'error') console.log(name, 'ERR', m.key);
      if (m.t === 'room') { b.room = m.room; act(b); }
    });
    ws.on('open', () => (code ? send({ t: 'join', code, name }) : send({ t: 'create', name })));
  });
}
let done;
const finished = new Promise((r) => (done = r));
function act(b) {
  const g = b.room.game;
  if (!g) return;
  if (g.phase === 'ended') return done(g);
  const me = g.players.findIndex((p) => p.id === b.id);
  if (me !== g.current) return;
  const key = `${g.phase}${g.turnCount}${g.placeIndex}`;
  if (b.last === key) return; b.last = key;
  if (g.phase === 'placement') {
    let r, c; do { r = Math.floor(Math.random() * g.n); c = Math.floor(Math.random() * g.n); } while (pieceAt(g.players, r, c));
    b.send({ t: 'place', r, c, type: Math.random() < 0.5 ? 'square' : 'round' });
  } else {
    const acts = legalActions(g, me);
    b.send({ t: 'move', ...acts[Math.floor(Math.random() * acts.length)] });
  }
}
bots.push(await bot('A'));
bots.push(await bot('B'));
if (process.env.BOTS !== '2') bots.push(await bot('C'));
bots[0].send({ t: 'settings', turnSeconds: 0 });
await new Promise((r) => setTimeout(r, 100));
bots[0].send({ t: 'start' });
const timeout = setTimeout(() => { console.log('FAIL: game did not finish'); srv.kill(); process.exit(1); }, 20000);
const g = await finished;
clearTimeout(timeout);
console.log('turns:', g.turnCount, 'ranking:', g.result.ranking.map((r) => `${r.rank}.${r.name}=${r.score}`).join(' '));
const total = g.result.ranking.reduce((s, r) => s + r.score, 0);
console.log(total <= g.n * g.n ? 'PASS' : 'FAIL score total');
bots.forEach((b) => b.ws.close()); srv.kill(); process.exit(0);

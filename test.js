// End-to-end smoke test: starts the server, connects 3 bots, plays a whole game with random legal moves.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { legalActions, pieceAt } from './public/rules.js';

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
    b.send({ t: 'place', r, c });
  } else {
    const acts = legalActions(g, me);
    b.send({ t: 'move', ...acts[Math.floor(Math.random() * acts.length)] });
  }
}
bots.push(await bot('A'));
bots.push(await bot('B'));
bots.push(await bot('C'));
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

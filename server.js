// Optional Node server (WebSocket mode). On static hosting (GitHub Pages) the game runs P2P instead,
// with the same engine inside the host's browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createEngine } from './public/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.end('ok'); return; }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  if (url.pathname === '/' || !path.extname(file)) file = path.join(PUBLIC, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const sockets = new Map(); // connId -> ws
let nextId = 1;
const engine = createEngine({
  sendTo(connId, obj) {
    const ws = sockets.get(connId);
    if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
  },
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  const id = `ws${nextId++}`;
  sockets.set(id, ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    engine.handle(id, msg);
  });
  ws.on('close', () => { engine.disconnect(id); sockets.delete(id); });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
  engine.sweep();
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`Wall Territory server listening on ${HOST}:${PORT}`);
  console.log(`  this computer : http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  same network  : http://${a.address}:${PORT}`);
  }
});

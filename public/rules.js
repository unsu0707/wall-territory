// Shared game rules — imported by both the server (authoritative) and the browser (previews).
//
// Board: N x N cells. Walls sit on edges between cells.
//   h[r][c]  : wall between (r,c) and (r+1,c)   r in [0, N-2], c in [0, N-1]
//   v[r][c]  : wall between (r,c) and (r,c+1)   r in [0, N-1], c in [0, N-2]
// Outer board edge always counts as a wall.

export const DIRS = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

export const COLORS = ['#ff5d5d', '#4da3ff', '#ffc53d', '#3ddc84', '#c77dff', '#ff8fd1'];

export function emptyWalls(n) {
  return {
    h: Array.from({ length: n - 1 }, () => Array(n).fill(false)),
    v: Array.from({ length: n }, () => Array(n - 1).fill(false)),
  };
}

// Is there a wall (or board edge) on side `dir` of cell (r,c)?
export function hasWall(walls, n, r, c, dir) {
  switch (dir) {
    case 'up': return r === 0 || walls.h[r - 1][c];
    case 'down': return r === n - 1 || walls.h[r][c];
    case 'left': return c === 0 || walls.v[r][c - 1];
    case 'right': return c === n - 1 || walls.v[r][c];
  }
  return true;
}

export function setWall(walls, r, c, dir) {
  switch (dir) {
    case 'up': walls.h[r - 1][c] = true; break;
    case 'down': walls.h[r][c] = true; break;
    case 'left': walls.v[r][c - 1] = true; break;
    case 'right': walls.v[r][c] = true; break;
  }
}

export function pieceAt(players, r, c) {
  for (let p = 0; p < players.length; p++) {
    const k = players[p].pieces.findIndex((pc) => pc.r === r && pc.c === c);
    if (k !== -1) return { player: p, piece: k };
  }
  return null;
}

// Cells a piece can end on: 0, 1 or 2 orthogonal steps, not through walls or other pieces.
export function reachable(game, playerIdx, pieceIdx, maxSteps = game.settings.moveSteps) {
  const { n, walls, players } = game;
  const start = players[playerIdx].pieces[pieceIdx];
  const key = (r, c) => r * n + c;
  const seen = new Map([[key(start.r, start.c), 0]]);
  const out = [{ r: start.r, c: start.c }];
  let frontier = [start];
  for (let step = 1; step <= maxSteps; step++) {
    const next = [];
    for (const cell of frontier) {
      for (const [dir, [dr, dc]] of Object.entries(DIRS)) {
        if (hasWall(walls, n, cell.r, cell.c, dir)) continue;
        const r = cell.r + dr, c = cell.c + dc;
        if (seen.has(key(r, c))) continue;
        if (pieceAt(players, r, c)) continue;
        seen.set(key(r, c), step);
        out.push({ r, c });
        next.push({ r, c });
      }
    }
    frontier = next;
  }
  return out;
}

export function freeSides(game, r, c) {
  return Object.keys(DIRS).filter((d) => !hasWall(game.walls, game.n, r, c, d));
}

// All legal (piece, dest, wall) actions for a player — used for "has any move" checks and auto-play.
export function legalActions(game, playerIdx) {
  const acts = [];
  const pl = game.players[playerIdx];
  pl.pieces.forEach((_, k) => {
    for (const cell of reachable(game, playerIdx, k)) {
      for (const dir of freeSides(game, cell.r, cell.c)) {
        acts.push({ piece: k, r: cell.r, c: cell.c, dir });
      }
    }
  });
  return acts;
}

// Flood-fill regions. Returns { regionOf: Int array (cell -> region id), regions: [{cells, owners:Set}] }
export function computeRegions(game) {
  const { n, walls, players } = game;
  const regionOf = new Array(n * n).fill(-1);
  const regions = [];
  for (let i = 0; i < n * n; i++) {
    if (regionOf[i] !== -1) continue;
    const id = regions.length;
    const cells = [];
    const stack = [i];
    regionOf[i] = id;
    while (stack.length) {
      const cur = stack.pop();
      cells.push(cur);
      const r = Math.floor(cur / n), c = cur % n;
      for (const [dir, [dr, dc]] of Object.entries(DIRS)) {
        if (hasWall(walls, n, r, c, dir)) continue;
        const j = (r + dr) * n + (c + dc);
        if (regionOf[j] === -1) { regionOf[j] = id; stack.push(j); }
      }
    }
    regions.push({ cells, owners: new Set() });
  }
  players.forEach((pl, p) => {
    for (const pc of pl.pieces) regions[regionOf[pc.r * n + pc.c]].owners.add(p);
  });
  return { regionOf, regions };
}

// A player is "sealed" when every one of their pieces sits in a region nobody else is in.
export function analyze(game) {
  const { regionOf, regions } = computeRegions(game);
  const scores = game.players.map(() => 0);
  const biggest = game.players.map(() => 0);
  for (const reg of regions) {
    if (reg.owners.size === 1) {
      const [p] = reg.owners;
      scores[p] += reg.cells.length;
      biggest[p] = Math.max(biggest[p], reg.cells.length);
    }
  }
  const sealed = game.players.map((pl, p) =>
    pl.pieces.length > 0 &&
    pl.pieces.every((pc) => regions[regionOf[pc.r * game.n + pc.c]].owners.size === 1)
  );
  const cellOwner = regionOf.map((id) => (regions[id].owners.size === 1 ? [...regions[id].owners][0] : -1));
  return { scores, biggest, sealed, cellOwner, allSealed: sealed.every(Boolean) };
}

export function defaultPieces(playerCount) {
  return playerCount <= 2 ? 4 : playerCount === 3 ? 3 : 2;
}

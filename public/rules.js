// Shared game rules — imported by the engine (authoritative) and the browser (previews).
// Rule set: Devil's Plan season 3 "Wall-go II", round 1 (2–3 players, one square + one round piece each).
//
// Board: N x N cells. Walls sit on edges between cells.
//   h[r][c]  : wall between (r,c) and (r+1,c)   r in [0, N-2], c in [0, N-1]
//   v[r][c]  : wall between (r,c) and (r,c+1)   r in [0, N-1], c in [0, N-2]
// The outer board edge always blocks and can never be broken.

export const DIRS = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};
const TURNS = { up: ['left', 'right'], down: ['left', 'right'], left: ['up', 'down'], right: ['up', 'down'] };

export const COLORS = ['#ff5d5d', '#4da3ff', '#ffc53d', '#3ddc84'];
export const PIECE_TYPES = ['square', 'round'];
export const MAX_PLAYERS = 3;

export function emptyWalls(n) {
  return {
    h: Array.from({ length: n - 1 }, () => Array(n).fill(false)),
    v: Array.from({ length: n }, () => Array(n - 1).fill(false)),
  };
}

export function isEdge(n, r, c, dir) {
  return (dir === 'up' && r === 0) || (dir === 'down' && r === n - 1) || (dir === 'left' && c === 0) || (dir === 'right' && c === n - 1);
}

// Is there a wall (or board edge) on side `dir` of cell (r,c)?
export function hasWall(walls, n, r, c, dir) {
  if (isEdge(n, r, c, dir)) return true;
  switch (dir) {
    case 'up': return walls.h[r - 1][c];
    case 'down': return walls.h[r][c];
    case 'left': return walls.v[r][c - 1];
    case 'right': return walls.v[r][c];
  }
  return true;
}

export function setWall(walls, r, c, dir, value = true) {
  switch (dir) {
    case 'up': walls.h[r - 1][c] = value; break;
    case 'down': walls.h[r][c] = value; break;
    case 'left': walls.v[r][c - 1] = value; break;
    case 'right': walls.v[r][c] = value; break;
  }
}

export function pieceAt(players, r, c) {
  for (let p = 0; p < players.length; p++) {
    const k = players[p].pieces.findIndex((pc) => pc.r === r && pc.c === c);
    if (k !== -1) return { player: p, piece: k };
  }
  return null;
}

// Every way a piece can move this turn.
//   square: 1 or 2 cells in ONE straight direction.
//   round : 1 cell, optionally turning left/right for 1 more cell.
// Cannot enter or pass through an occupied cell. A wall blocks the path unless `allowBreak`,
// in which case at most one wall on the path may be broken.
// Returns [{ r, c, path: [dir...], broken: null | { r, c, dir } }]
export function moveOptions(game, p, k, allowBreak = false) {
  const { n, walls, players } = game;
  const pc = players[p].pieces[k];
  const out = [];
  const step = (cell, dir, broken) => {
    if (isEdge(n, cell.r, cell.c, dir)) return null;
    let br = broken;
    if (hasWall(walls, n, cell.r, cell.c, dir)) {
      if (!allowBreak || broken) return null;
      br = { r: cell.r, c: cell.c, dir };
    }
    const [dr, dc] = DIRS[dir];
    const r = cell.r + dr, c = cell.c + dc;
    if (pieceAt(players, r, c)) return null;
    return { r, c, broken: br };
  };
  for (const d1 of Object.keys(DIRS)) {
    const a = step(pc, d1, null);
    if (!a) continue;
    out.push({ r: a.r, c: a.c, path: [d1], broken: a.broken });
    const seconds = pc.type === 'square' ? [d1] : TURNS[d1];
    for (const d2 of seconds) {
      const b = step(a, d2, a.broken);
      if (b) out.push({ r: b.r, c: b.c, path: [d1, d2], broken: b.broken });
    }
  }
  return out;
}

// Replays a path and returns the matching option, or null if the path is not legal.
export function findMove(game, p, k, path, allowBreak) {
  return moveOptions(game, p, k, allowBreak).find((o) => o.path.length === path.length && o.path.every((d, i) => d === path[i])) || null;
}

// The player may "stay and build" only when none of their pieces can move without breaking a wall.
export function mustStay(game, p) {
  return game.players[p].pieces.every((_, k) => moveOptions(game, p, k, false).length === 0);
}

export function freeSides(game, r, c) {
  return Object.keys(DIRS).filter((d) => !hasWall(game.walls, game.n, r, c, d));
}

// Free sides after a move that may have broken a wall (the broken wall is gone).
export function freeSidesAfter(game, opt) {
  const sides = freeSides(game, opt.r, opt.c);
  if (opt.broken) {
    const back = { up: 'down', down: 'up', left: 'right', right: 'left' }[opt.path[opt.path.length - 1]];
    const [dr, dc] = DIRS[back];
    const fromR = opt.r + dr, fromC = opt.c + dc;
    if (opt.broken.r === fromR && opt.broken.c === fromC && !sides.includes(back)) sides.push(back);
  }
  return sides;
}

// All legal non-breaking actions (used for time-outs and "can this player act" checks).
export function legalActions(game, p) {
  const acts = [];
  const stay = mustStay(game, p);
  game.players[p].pieces.forEach((pc, k) => {
    const opts = stay ? [{ r: pc.r, c: pc.c, path: [], broken: null }] : moveOptions(game, p, k, false);
    for (const o of opts) for (const dir of freeSides(game, o.r, o.c)) acts.push({ piece: k, path: o.path, dir });
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

// A player is "separated" when every one of their pieces sits in a region nobody else is in.
// Score = cells of the regions holding that player's pieces; tie-break = their largest region.
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

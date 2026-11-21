// sokoban-solver-01 entry: push-optimal Sokoban solver.
//
// The generator builds levels as a one-square-wide hallway plus 1-4 rooms off it; a box pushed
// through a door can never come back, so every box stays in its room and the level's push
// optimum is the sum of its rooms' optima. We exploit that: split the level into rooms (the
// dead squares of the player's row form the hallway cut), then solve each room independently
// with a breadth-first search over pushes with deadlock pruning, and concatenate the answers.
// If a level is not a clean room set we fall back to one search over the whole level.
//
// A search state is the boxes' squares plus the player's reachable region (named by its lowest
// square). States are expanded in order of pushes made, so the first solved state found is
// push-optimal. Two deadlocks are pruned, neither of which can prune a solvable state:
// a "dead" square (a box there can never reach any goal, ignoring the other boxes) and a
// frozen 2x2 block of walls and boxes with one box off its goal.
//
// Pure and deterministic: no clock, no randomness; iteration order is fixed by square order.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Budget on states one search keeps before it gives up (work-bounded, never clock-bounded). */
const DBGX = process.env.SOKO_X === '1';
const MAX_STATES = 250_000;

/** Directions: [dx, dy, step letter, push letter]. Order fixed for determinism. */
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall no matter what it shows.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares from which a lone box can reach some goal: goals flood-filled backwards over open floor. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Player's reachable squares from `from` given an `occupied` box mask, marked with `stamp` in `seen`; returns the lowest square. */
function reach(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (const q of [p - w, p + w, p - 1, p + 1]) {
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Does the box just pushed to `t` sit in a frozen 2x2 block (walls+boxes) holding a box off its goal? */
function frozenBlock(w: number, wall: Uint8Array, occupied: Uint8Array, goalMask: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goalMask[a]) ||
      (occupied[b] && !goalMask[b]) ||
      (occupied[c] && !goalMask[c]) ||
      (occupied[d] && !goalMask[d])
    )
      return true;
  }
  return false;
}

function stateKey(boxes: number[], low: number, size: number): number {
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

interface Solved {
  pushes: number;
  moves: string;
}

/**
 * Push-optimal BFS over pushes with deadlock pruning. Returns {pushes, moves} (moves in LURD,
 * upper letters marking pushes) or null when the search gives up or the level has no solution.
 */
function solvePushOptimal(level: Level, maxStates = MAX_STATES): Solved | null {
  const { w, wall, goals, boxes, player } = level;
  const size = wall.length;
  const goalMask = new Uint8Array(size);
  for (const g of goals) goalMask[g] = 1;
  const live = liveSquares(level);
  if (boxes.some((b) => !live[b])) return null;
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  interface Node {
    boxes: number[];
    pos: number; // the player's square once this state's push has played (-1: n/a)
    pushFrom: number; // the pushed box's square before the push that made this state
    pushTo: number;
    parent: number;
  }
  const nodes: Node[] = [{ boxes, pos: -1, pushFrom: -1, pushTo: -1, parent: -1 }];
  const index = new Map<number, number>();
  for (const b of boxes) occupied[b] = 1;
  index.set(stateKey(boxes, reach(w, wall, occupied, player, seen, ++stamp, stack), size), 0);
  for (const b of boxes) occupied[b] = 0;

  const isSolved = (bs: number[]) => bs.every((b) => goalMask[b]);
  let found = isSolved(boxes) ? 0 : -1;

  let expanded=0, pushed=0, prunedFrozen=0, prunedSeen=0;
  for (let head = 0; found < 0 && head < nodes.length; head++) {
    const node = nodes[head];
    const cur = node.boxes;
    // Where the player stands for this state: the start for the root, else just after its push.
    const here0 = head === 0 ? player : node.pos;
    expanded++;
    for (const b of cur) occupied[b] = 1;
    const rs = reach(w, wall, occupied, here0, seen, ++stamp, stack);
    let rc=0; for (let i=0;i<seen.length;i++) if (seen[i]===stamp) rc++;
    console.error('expand head',head,'pos',here0,'region',rc,'low',rs);
    const here = stamp;
    for (let bi = 0; bi < cur.length && found < 0; bi++) {
      const b = cur[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (DBGX) console.error('cand head',head,'box',b,'dir',d,'t',t,'seenOK',seen[b - d] === here,'wall',!!wall[t],'occ',!!occupied[t],'live',!!live[t]);
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goalMask, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = cur.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = stateKey(next, reach(w, wall, occupied, b, seen, ++stamp, stack), size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) {prunedFrozen++; continue;}
        if (index.has(key)) {prunedSeen++; if (DBGX) console.error('  dup head',head,'boxes',next,'key',key); continue;}
        if (nodes.length >= maxStates) {
          for (const x of cur) occupied[x] = 0;
          return null;
        }
        index.set(key, nodes.length); pushed++;
        if (DBGX) console.error('  new node', nodes.length, 'boxes', next, 'parent', head);
        nodes.push({ boxes: next!, pos: b, pushFrom: b, pushTo: t, parent: head });
        if (isSolved(next!)) {
          found = nodes.length - 1;
          break;
        }
      }
    }
    for (const x of cur) occupied[x] = 0;
  }
  console.error('diag nodes',nodes.length,'expanded',expanded,'pushed',pushed,'frozen',prunedFrozen,'dup',prunedSeen);
  if (found < 0) return null;

  // Reconstruct the moves: before each push of a box from f in direction d the player walks to
  // f - d; after the push it stands on f. The parent state's boxes are the board at that time.
  const path: number[] = [];
  for (let s = found; s > 0; s = nodes[s].parent) path.push(s);
  path.reverse();
  let moves = '';
  let pos = player;
  for (const s of path) {
    const { pushFrom: f, pushTo: t, parent } = nodes[s];
    const d = t - f;
    const parentBoxes = parent < 0 ? boxes : nodes[parent].boxes;
    for (const b of parentBoxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, pos, f - d);
    for (const b of parentBoxes) occupied[b] = 0;
    moves += DIRS.find(([dx, dy]) => dy * w + dx === d)![3];
    pos = f;
  }
  return { pushes: path.length, moves };
}

/** Shortest walk from `from` to `to` around walls and boxes, in lower LURD (deterministic tie order). */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = [];
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done?: boolean;
}

/**
 * The level's rooms: the dead squares of the player's row (the hallway — a box there reaches no
 * goal) cut the floor into parts; each part holding a box is a room. Null when a box starts in
 * the hallway, some goal sits outside any room, or a part's box count differs from its goals.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve room by room (other rooms' boxes stand as walls; on their goals once their room is
 * done), the player walking on from where the last room ended. Falls back to one whole-level
 * search when the level is not a clean room set.
 */
function solveByRooms(level: Level, maxStates = MAX_STATES): Solved | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, maxStates);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms)
      if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    const sub: Level = {
      w: level.w,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, maxStates);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

const DBG = process.env.SOKO_DEBUG === '1';
const solve = (levelText: string): string => {
  const level = parseLevel(levelText);
  const rooms = roomsOf(level);
  if (DBG) console.error('rooms:', rooms === null ? null : rooms.map((r) => ({ boxes: r.boxes.length, goals: r.goals.length, sq: r.squares.length })));
  const res = solveByRooms(level);
  if (DBG) console.error('res:', res && { pushes: res.pushes, len: res.moves.length });
  return res === null ? '' : res.moves.toLowerCase();
};

for (const id of []) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
export { parseLevel, roomsOf, solvePushOptimal, solveByRooms };

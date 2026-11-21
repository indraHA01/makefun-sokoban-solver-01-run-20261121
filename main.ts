// sokoban-solver — a push-optimal Sokoban solver for make.fun's
// sokoban-solver-01-run-20261121 ("Build the best Sokoban solver, 21 November 2026").
//
// The levels are a hallway with one to four rooms off it, three or four boxes in
// each room, and a box pushed through a door can never be pushed back — so every
// room is an independent problem and a level's push-optimum is the sum of its
// rooms' optima. This entry therefore solves every room on its own, instead of
// searching the whole level (whose state space is the product of its rooms'):
// each room gets a push-based A* where a step costs one push, not one move, so
// the search minimises exactly what the checker counts.
//
// The estimate is the cheapest assignment of the room's boxes to its goals under
// shortest-path distances that ignore the other boxes (a lower bound on the
// pushes still needed: one push moves one box one square), and the search prunes
// two deadlocks no solution can survive — a box on a square from which no push
// can ever reach a goal, and a frozen 2 x 2 block of walls and boxes. A state is
// its boxes plus the player's reachable region (named by its lowest square), so
// the walk between pushes costs nothing in the search and is filled in only
// when the push path is rebuilt.
//
// The search is capped by expansions, never by the clock, and every tie is
// broken by a fixed order, so two runs answer byte for byte alike. The program
// reads every instance under /input/<id>/level.txt and writes
// /output/<id>/solution.txt for each, in one run.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
// (SOKOBAN_DEBUG=1 prints each room's pushes and expansions to stderr.)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DEBUG = process.env.SOKOBAN_DEBUG === '1';

/** The four moves: [dx, dy, the step's letter, the push's letter]. */
const DIRS: Array<[number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** A level (or one room of it, as a level of its own): walls, goals, boxes, player. */
interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
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
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box alone can be pushed onto some goal: pulled back
 * from the goals over open floor (a box at y pushed along d lands on a live x
 * when the player can stand at y - d). A box off a live square is dead, whatever
 * the other boxes do, so the search never puts one there.
 */
function liveSquares(lv: Level): Uint8Array {
  const { w, wall, goals } = lv;
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

/**
 * The squares the player reaches from `from` with `occupied` (a box mask) in
 * the way, marked in `seen` with `stamp`; returns the lowest square reached,
 * which names the region. The scratch `stack` is caller-owned.
 */
function regionLow(
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
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number, w: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** For each goal, the shortest walk over open floor (ignoring boxes) to every square, or -1. */
function goalDistances(lv: Level): Int32Array[] {
  const { w, wall, goals } = lv;
  return goals.map((g) => {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p] + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
}

/**
 * The cheapest assignment of the boxes to the goals under the distances above,
 * by brute force over the (at most four) boxes' permutations: a lower bound on
 * the pushes still needed, since one push moves one box one square and the
 * other boxes are ignored. Infinity when some box reaches no goal.
 */
function assignmentHeuristic(boxes: number[], dists: Int32Array[]): number {
  const n = boxes.length;
  const perm = boxes.map((_, i) => i);
  let best = Infinity;
  const visit = (k: number, cost: number): void => {
    if (cost >= best) return;
    if (k === n) {
      best = cost;
      return;
    }
    for (let i = k; i < n; i++) {
      [perm[k], perm[i]] = [perm[i], perm[k]];
      const d = dists[perm[k]][boxes[k]];
      if (d >= 0) visit(k + 1, cost + d);
      [perm[k], perm[i]] = [perm[i], perm[k]];
    }
  };
  visit(0, 0);
  return best;
}

/** A binary heap on [f, g, seq, state]: lowest f first, deepest g, then earliest. */
interface HeapEntry {
  f: number;
  g: number;
  seq: number;
  s: number;
}

function heapLess(a: HeapEntry, b: HeapEntry): boolean {
  return a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.seq < b.seq)));
}

function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i], heap[p])) break;
    [heap[i], heap[p]] = [heap[p], heap[i]];
    i = p;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
      if (!heapLess(heap[c], heap[i])) break;
      [heap[i], heap[c]] = [heap[c], heap[i]];
      i = c;
    }
  }
  return top;
}

/** The most states one room's search expands before it gives up: work, never the clock. */
const MAX_ROOM_EXPANSIONS = 300_000;
/** The same cap for the whole-level fallback, which a generated level never needs. */
const MAX_WHOLE_EXPANSIONS = 500_000;

/** How many states the last solve expanded (debug only; never read for a decision). */
let lastExpansions = 0;

/**
 * The push-optimal solution of `level`: {pushes, moves} (moves in LURD, a lower
 * letter a step, an upper one a push), or null when the search gives up (or the
 * level has no solution). A* over pushes: a state is the boxes and the player's
 * reachable region, the cost is pushes, the estimate is the assignment heuristic
 * above. `exit` (when given) is a set of squares the player's region must reach
 * in a solved state — the room's door — so a finished room never shuts the
 * player in for the next one.
 */
function solvePushOptimal(
  level: Level,
  maxExpansions: number,
  exit: Set<number> | null,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dists = goalDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  // A state's key: the region's lowest square and the boxes' squares. As digits
  // in base `size` while that stays exact (a room: at most five boxes); a whole
  // level's key is the same squares joined as text.
  const nBoxes = level.boxes.length;
  const numeric = Math.pow(size, nBoxes + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numeric) return `${low}|${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // The states in the order found: their boxes, the player's square (where the
  // last push left it), the cost in pushes, the parent and the push that made
  // them. A better path to a known state rewrites it in place; the heap entry
  // the old cost left behind goes stale and is skipped when popped.
  const statesBoxes: number[][] = [level.boxes.slice()];
  const statesPlayer: number[] = [level.player];
  const statesG: number[] = [0];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const index = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = regionLow(w, wall, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  index.set(keyOf(level.boxes, startLow), 0);

  const heap: HeapEntry[] = [];
  let seq = 0;
  heapPush(heap, { f: assignmentHeuristic(level.boxes, dists), g: 0, seq: seq++, s: 0 });
  let expanded = 0;
  let found = -1;

  while (heap.length > 0) {
    const { g, s } = heapPop(heap);
    if (g !== statesG[s]) continue; // stale: a better path rewrote this state
    const boxes = statesBoxes[s];
    if (solved(boxes)) {
      // A solved state is only accepted when the player can still reach the
      // exit; otherwise the search carries on for a solved state that can.
      if (exit !== null) {
        for (const b of boxes) occupied[b] = 1;
        regionLow(w, wall, occupied, statesPlayer[s], seen, ++stamp, stack);
        const here = stamp;
        let reaches = false;
        for (const e of exit) if (seen[e] === here) { reaches = true; break; }
        for (const b of boxes) occupied[b] = 0;
        if (!reaches) continue;
      }
      found = s;
      break;
    }
    if (expanded >= maxExpansions) return null;
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    regionLow(w, wall, occupied, statesPlayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di];
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(wall, occupied, goal, t, w);
        let key: number | string = '';
        let next: number[] | null = null;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          // After the push the player stands where the box was.
          low = regionLow(w, wall, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const g2 = g + 1;
        const at = index.get(key);
        if (at !== undefined && statesG[at] <= g2) continue;
        const h2 = assignmentHeuristic(next, dists);
        if (h2 === Infinity) continue;
        if (at !== undefined) {
          statesG[at] = g2;
          parent[at] = s;
          pushFrom[at] = b;
          pushDir[at] = di;
        } else {
          index.set(key, statesBoxes.length);
          statesBoxes.push(next);
          statesPlayer.push(b);
          statesG.push(g2);
          parent.push(s);
          pushFrom.push(b);
          pushDir.push(di);
        }
        heapPush(heap, { f: g2 + h2, g: g2, seq: seq++, s: at !== undefined ? at : statesBoxes.length - 1 });
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  lastExpansions = expanded;
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const di = pushDir[s];
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[di][3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (u, d, l, r first on ties). */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
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
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** One room: its floor squares, its boxes and goals, and whether it is solved yet. */
interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room. Null when some part holds more or fewer boxes than goals, or
 * a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): { rooms: Room[]; cut: Uint8Array } | null {
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
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return { rooms: rooms.filter((r) => r.boxes.length > 0), cut };
}

/** A room's door squares: its floor squares touching the cut-out hallway. */
function exitSquares(room: Room, cut: Uint8Array, w: number): Set<number> {
  const exit = new Set<number>();
  for (const s of room.squares) {
    for (const [dx, dy] of DIRS) {
      if (cut[s + dy * w + dx]) {
        exit.add(s);
        break;
      }
    }
  }
  return exit;
}

/** The whole level solved as one problem: the fallback when it is no set of rooms, or a room's search gives up. */
function solveWholeLevel(level: Level): string {
  const solved = solvePushOptimal(level, MAX_WHOLE_EXPANSIONS, null);
  return solved === null ? '' : solved.moves;
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's.
 */
function solveLevel(level: Level): string {
  const split = roomsOf(level);
  if (split === null) return solveWholeLevel(level);
  const { rooms, cut } = split;
  let player = level.player;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const last = ri === rooms.length - 1;
    const exit = last ? null : exitSquares(room, cut, level.w);
    const solved = solvePushOptimal(sub, MAX_ROOM_EXPANSIONS, exit);
    if (solved === null) return solveWholeLevel(level);
    if (DEBUG) console.error(`room ${ri + 1}/${rooms.length}: ${solved.pushes} pushes, ${lastExpansions} expansions`);
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}

# sokoban-solver — push-optimal per-room Sokoban solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/indraHA01/makefun-sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/indraHA01/makefun-sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)

A [make.fun](https://make.fun) entry for **Build the best Sokoban solver, 21 November 2026** — one program, `main.ts` (Node 22, no dependencies), that answers all 5 instances of a set in one run, in as few pushes as the checker counts.

## The angle: solve rooms, not levels

Every generated level is a hallway with one to four rooms off it, three or four boxes per room, and a box pushed through a door can never be pushed back — so each room is an independent problem and a level's push-optimum is the sum of its rooms' optima. Searching the whole level meets the product of its rooms' state spaces; solving room by room meets only their sum. That is the whole edge over the house baseline (plain A* over moves on the whole level, no deadlock knowledge):

- **Per-room decomposition.** The dead squares of the player's row (the hallway: a box there reaches no goal) are cut out of the floor; each remaining part holding a box is a room. Rooms are solved in turn with the other rooms' boxes standing as walls, the player walking on from where the last room left it.
- **Push-based A\*, not move-based.** A state is the boxes plus the player's reachable region (named by its lowest square), a step costs one push, and the walk between pushes is filled in only when the push path is rebuilt — so the search minimises exactly what the checker counts.
- **A tight estimate.** The cheapest assignment of the room's boxes to its goals under shortest-path distances that ignore the other boxes — a lower bound on the pushes still needed, since one push moves one box one square.
- **Deadlock pruning.** A box on a square from which no push can ever reach a goal (pulled back from the goals) is never placed there, and a frozen 2 x 2 block of walls and boxes ends that branch.
- **Deterministic by construction.** The search is capped by expansions, never by the clock, and every tie is broken by a fixed order — two runs write byte-identical answers. A solved room must still leave the player able to reach its door, so the next room is always enterable.

## Results

Practice set (kit scorer, `program/scorer/score.ts`): **1,000,000 / 1,000,000** — every instance solved in exactly its push-optimum P\*:

| instance | boxes | pushes | P\* | points |
|----------|-------|--------|-----|--------|
| i001 | 3 | 13 | 13 | 1,000 |
| i002 | 4 | 16 | 16 | 1,000 |
| i003 | 8 | 29 | 29 | 1,000 |
| i004 | 12 | 47 | 47 | 1,000 |
| i005 | 16 | 60 | 60 | 1,000 |

The house baseline (plain-astar 1.0.0) scores 200,000 on the same set — it solves only i001. On 10 further sets freshly drawn with the kit's own generator from new seeds (50 instances), this entry again hit P\* on every instance, worst whole-set runtime 0.5 s against the 60 s wall budget.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`SOKOBAN_DEBUG=1` prints each room's pushes and expansions to stderr. The program reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`), creating the directories itself. If a level is no set of rooms, or a room's search gives up, it falls back to a whole-level push A\* with the same cap, and writes an empty (valid, zero-point) answer rather than failing.

## Files

- `main.ts` — the whole solver, one file, Node built-ins only
- `LICENSE` — MIT

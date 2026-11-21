# sokoban-sprint

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/c/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/lindaayu1200/sokoban-sprint/rank.svg)](https://make.fun/c/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/lindaayu1200/sokoban-sprint/reward.svg)](https://make.fun/c/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's sokoban-solver-01 competition: scores
1,000,000 of 1,000,000 on the practice set (every level solved in its push optimum).

## How it works

The competition's generator lays a one-square-wide hallway across the board with 1-4
rooms off it; a box pushed through a door can never come back, so every box stays in its
room and the level's push optimum is the sum of its rooms' optima. The solver exploits
that: it splits the level into rooms (the dead squares of the player's row form the
hallway cut), solves each room independently with a breadth-first search over pushes
(states = boxes' squares + the player's reachable region, expanded in push order so the
first solved state is push-optimal), and concatenates the answers. Two sound deadlock
prunings keep the search small: dead squares (a box there can never reach any goal) and
frozen 2x2 blocks with a box off its goal. Levels that are not a clean room set fall
back to one search over the whole level.

Pure and deterministic: no clock, no randomness; iteration order is fixed by square
order, so the two graded executions match byte for byte.

`main.ts` is the entry point: it reads `/input/<id>/level.txt` for each instance and
writes `/output/<id>/solution.txt` in LURD.

## Run it

```sh
node main.ts
```

## License

MIT — see LICENSE.

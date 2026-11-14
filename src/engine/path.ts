import type { Cell } from '../contracts.ts';

/** Ground length of a cell path, counting diagonal steps as √2 cells. */
export function pathLengthM(path: Cell[], cellSizeM: number): number {
  let cells = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!;
    const q = path[i]!;
    cells += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return cells * cellSizeM;
}

import type { Cell, Constraints, GridMeta, RingResult, RouteRequest, RouteResult, Stop } from '../contracts.ts';
import type { WorkerIn, WorkerOut } from './worker.ts';

/** The part of `Worker` the client uses, so tests can pass a fake. */
export interface WorkerLike {
  postMessage(msg: WorkerIn): void;
  onmessage: ((e: MessageEvent<WorkerOut>) => void) | null;
  terminate?(): void;
}

type Pending = { expect: 'route' | 'ring'; resolve: (v: never) => void; reject: (e: Error) => void };

/**
 * Promise wrapper over the worker message contract.
 *
 * The contract has no request ids, so replies are matched in order: the worker
 * handles one message at a time and answers every `route`, `ring` and `replan`
 * exactly once. `init` only answers on failure; that error rejects the next
 * pending request.
 */
export class EngineClient {
  private queue: Pending[] = [];

  constructor(private worker: WorkerLike) {
    worker.onmessage = (e) => this.onReply(e.data);
  }

  init(meta: GridMeta, cost: Float32Array): void {
    // Structured clone (no transfer) so the caller's grid stays usable.
    this.worker.postMessage({ type: 'init', meta, cost });
  }

  route(req: RouteRequest): Promise<RouteResult> {
    return this.send({ type: 'route', req }, 'route');
  }

  ring(oxygenLeftMin: number): Promise<RingResult> {
    return this.send({ type: 'ring', oxygenLeftMin }, 'ring');
  }

  replan(from: Cell, stops: Stop[], constraints: Constraints, oxygenLeftMin: number): Promise<RouteResult> {
    return this.send({ type: 'replan', from, stops, constraints, oxygenLeftMin }, 'route');
  }

  terminate(): void {
    this.worker.terminate?.();
    for (const p of this.queue.splice(0)) p.reject(new Error('engine terminated'));
  }

  private send<T>(msg: WorkerIn, expect: Pending['expect']): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ expect, resolve: resolve as (v: never) => void, reject });
      this.worker.postMessage(msg);
    });
  }

  private onReply(msg: WorkerOut): void {
    const p = this.queue.shift();
    if (!p) {
      if (msg.type === 'error') console.error(`engine: ${msg.message}`);
      return;
    }
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else if (msg.type !== p.expect) p.reject(new Error(`engine replied '${msg.type}', expected '${p.expect}'`));
    else p.resolve(msg.result as never);
  }
}

/** The real routing worker (mock router inside until M07). */
export function createWorkerEngine(): EngineClient {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return new EngineClient(worker as unknown as WorkerLike);
}

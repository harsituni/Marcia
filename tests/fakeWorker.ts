import type { WorkerLike } from '../src/engine/client.ts';
import { handleMessage } from '../src/engine/worker.ts';
import type { WorkerIn, WorkerOut } from '../src/engine/worker.ts';

/** Runs the real worker handler on a microtask, like a worker thread would. */
export class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<WorkerOut>) => void) | null = null;
  sent: WorkerIn[] = [];
  private state: Parameters<typeof handleMessage>[0] = null;
  postMessage(msg: WorkerIn) {
    this.sent.push(msg);
    queueMicrotask(() => {
      const res = handleMessage(this.state, msg);
      this.state = res.state;
      if (res.out) this.onmessage?.({ data: res.out } as MessageEvent<WorkerOut>);
    });
  }
}

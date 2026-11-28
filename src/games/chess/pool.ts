import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { ThinkJob } from './think.js';

interface Pending {
  id: number;
  job: ThinkJob;
  resolve(uci: string): void;
  reject(err: Error): void;
}

interface Slot {
  worker: Worker;
  busy: Pending | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** a think may overrun its own limit by this much before its worker is replaced */
const OVERRUN_MS = 5_000;

// under tsx/vitest the source is TypeScript: a small .mjs loads tsx in the worker first; the built server runs botWorker.js
const WORKER_URL = new URL(import.meta.url.endsWith('.ts') ? './botWorker.dev.mjs' : './botWorker.js', import.meta.url);

/**
 * Chess bots think in worker threads so the event loop never blocks. Jobs queue for the next free worker;
 * a worker that overruns is replaced. If workers can't start, moves are worked out in-process (shallow and rare).
 */
export class ChessBotPool {
  private slots: Slot[] = [];
  private queue: Pending[] = [];
  private seq = 0;
  private broken = false;
  private closed = false;

  constructor(private readonly size = Math.max(1, Math.min(4, (Number(process.env.CHESS_BOT_WORKERS) || availableParallelism() - 1)))) {}

  /** the bot's move in UCI */
  think(job: ThinkJob): Promise<string> {
    if (this.closed) return Promise.reject(new Error('chess bots stopped'));
    if (this.broken) return import('./think.js').then((t) => t.thinkMove(job));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.seq, job, resolve, reject });
      this.pump();
    });
  }

  /** stops every worker (server close, tests) */
  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue) p.reject(new Error('chess bots stopped'));
    this.queue = [];
    const slots = this.slots;
    this.slots = [];
    for (const s of slots) {
      if (s.timer) clearTimeout(s.timer);
      s.busy?.reject(new Error('chess bots stopped'));
    }
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => !s.busy);
      if (!slot && this.slots.length < this.size) slot = this.spawn() ?? undefined;
      if (!slot) return;
      const p = this.queue.shift()!;
      slot.busy = p;
      slot.worker.ref();
      slot.timer = setTimeout(() => this.replace(slot!, new Error('chess bot took too long')), (p.job.maxMs ?? 2_000) + OVERRUN_MS);
      slot.worker.postMessage({ id: p.id, job: p.job });
    }
  }

  private spawn(): Slot | null {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL);
    } catch (err) {
      console.error('[chess] bot workers unavailable, thinking in-process:', (err as Error).message);
      this.broken = true;
      const waiting = this.queue;
      this.queue = [];
      for (const p of waiting) this.think(p.job).then(p.resolve, p.reject);
      return null;
    }
    const slot: Slot = { worker, busy: null, timer: null };
    worker.on('message', (msg: { id: number; uci?: string; error?: string }) => {
      const p = slot.busy;
      if (!p || p.id !== msg.id) return;
      if (slot.timer) clearTimeout(slot.timer);
      slot.busy = null;
      slot.timer = null;
      worker.unref();
      if (msg.uci) p.resolve(msg.uci);
      else p.reject(new Error(msg.error ?? 'no move'));
      this.pump();
    });
    worker.on('error', (err) => this.replace(slot, err));
    worker.on('exit', () => {
      if (this.slots.includes(slot)) this.replace(slot, new Error('chess bot worker stopped'));
    });
    worker.unref();
    this.slots.push(slot);
    return slot;
  }

  private replace(slot: Slot, err: Error): void {
    if (slot.timer) clearTimeout(slot.timer);
    this.slots = this.slots.filter((s) => s !== slot);
    slot.busy?.reject(err);
    slot.busy = null;
    void slot.worker.terminate();
    if (!this.closed) this.pump();
  }
}

/** the server's one pool, started on first use */
let shared: ChessBotPool | null = null;
export const chessBots = (): ChessBotPool => (shared ??= new ChessBotPool());
export async function stopChessBots(): Promise<void> {
  const p = shared;
  shared = null;
  await p?.close();
}

import { parentPort } from 'node:worker_threads';
import { thinkMove, type ThinkJob } from './think.js';

// one chess bot think at a time, off the server's event loop
parentPort?.on('message', (msg: { id: number; job: ThinkJob }) => {
  try {
    parentPort!.postMessage({ id: msg.id, uci: thinkMove(msg.job) });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: (err as Error).message });
  }
});

// dev and tests run TypeScript sources: load tsx in this worker, then the real worker (the built server uses botWorker.js)
import { register } from 'tsx/esm/api';

register();
await import('./botWorker.ts');

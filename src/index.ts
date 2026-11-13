import {
  ADMIN_API_KEY,
  CLIENT_ORIGINS,
  DB_NAMES,
  DEFAULT_COINS,
  MONGODB_URI,
  PORT,
  SESSION_TTL_DAYS,
  VAPID_PRIVATE_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_SUBJECT,
} from './config.js';
import { createBluffServer } from './server.js';
import { createStore, type Store } from './services/store.js';

let store: Store | null = null;
if (MONGODB_URI) {
  try {
    store = await createStore(MONGODB_URI, DB_NAMES, {
      defaultCoins: DEFAULT_COINS,
      sessionTtlDays: SESSION_TTL_DAYS,
      push: { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT },
    });
    console.log(`MongoDB connected: database "${DB_NAMES.db}"`);
    console.log(store.push.ready ? 'Invite notifications: ready' : 'Invite notifications: off (VAPID keys not set)');
  } catch (err) {
    // keep the game playable for guests even if the database is down
    console.error('MongoDB connection failed, running guest-only:', (err as Error).message);
  }
} else {
  console.log('MONGODB_URI not set: guest-only mode (no accounts)');
}

const { httpServer, close } = createBluffServer({ store, adminApiKey: ADMIN_API_KEY });

httpServer.listen(PORT, () => {
  console.log(`Bluff server listening on port ${PORT}`);
  console.log(
    CLIENT_ORIGINS.length > 0
      ? `Allowed origins: ${CLIENT_ORIGINS.join(', ')}`
      : 'CLIENT_ORIGIN not set: only localhost and home-network origins can connect',
  );
  if (store && !ADMIN_API_KEY) console.log('ADMIN_API_KEY not set: only existing admins can make new admins');
});

const shutdown = async () => {
  close();
  await store?.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

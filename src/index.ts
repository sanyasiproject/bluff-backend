import { CLIENT_ORIGINS, PORT } from './config.js';
import { createBluffServer } from './server.js';

const { httpServer, close } = createBluffServer();

httpServer.listen(PORT, () => {
  console.log(`Bluff server listening on port ${PORT}`);
  console.log(
    CLIENT_ORIGINS.length > 0
      ? `Allowed origins: ${CLIENT_ORIGINS.join(', ')}`
      : 'CLIENT_ORIGIN not set: only localhost and home-network origins can connect',
  );
});

const shutdown = () => {
  close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

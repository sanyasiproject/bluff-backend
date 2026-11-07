import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { isAllowedOrigin } from './config.js';
import { RoomManager } from './rooms.js';
import { registerHandlers } from './socket.js';

export function createBluffServer() {
  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Bluff game server is running');
  });

  const io = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) },
    // CORS does not cover WebSocket upgrades, so check the origin here too
    allowRequest: (req, cb) => cb(null, isAllowedOrigin(req.headers.origin)),
    maxHttpBufferSize: 16 * 1024,
  });

  const rooms = new RoomManager();
  const stopSweep = registerHandlers(io, rooms);

  return {
    httpServer,
    io,
    rooms,
    close: () => {
      stopSweep();
      io.close();
    },
  };
}

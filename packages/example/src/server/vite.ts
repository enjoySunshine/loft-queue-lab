process.env.JWT_SECRET = "test";
process.env.SESSION_SECRET = "SESSION_SECRET";

import { createEndpoint, createRouter, defineRoom, defineServer, matchMaker, monitor, playground } from 'colyseus';
import { DatabaseDriver } from '@colyseus/database';
import { MyRoom } from '../MyRoom.ts';
import { MapRoom, MapQueueRoom } from '../MapRoom.ts';
import { database } from '../db/database.ts';

export const server = defineServer({
  // `database` boots under the Vite plugin too, and auto-mounts /auth/*
  database,
  driver: new DatabaseDriver({ database }),

  rooms: {
    my_room: defineRoom(MyRoom),
    map_room: defineRoom(MapRoom),
    map_queue: defineRoom(MapQueueRoom, { maxPlayers: 2 }),
  },

  express: (app) => {
    app.get('/express-hello', (req, res) => {
      res.json({ message: 'Hello from Express!' });
    });

    app.use('/playground', playground());
    app.use('/monitor', monitor());
  },

  routes: createRouter({
    hello: createEndpoint("/hello", { method: "GET" }, async (ctx) => {
      return { message: "Hello world!" };
    }),

    time: createEndpoint("/time", { method: "GET" }, async (ctx) => {
      return { time: Date.now() };
    }),

    // Same snapshot the room state draws from — who is in the room and the
    // coordinates their circles are centered on.
    mapRoomPlayers: createEndpoint("/map-rooms/:roomId/players", { method: "GET" }, async (ctx) => {
      const room = matchMaker.getLocalRoomById(ctx.params.roomId);
      if (!room || !(room instanceof MapRoom)) {
        return { roomId: ctx.params.roomId, players: [] };
      }
      return room.exportPlayers();
    }),
  }),
});

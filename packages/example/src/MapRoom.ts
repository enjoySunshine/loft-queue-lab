import { QueueRoom, Room, matchMaker, type Client, type QueueClientData, type QueueMatchGroup, type QueueOptions } from "@colyseus/core";
import { schema, t, type SchemaType } from "@colyseus/schema";

export const MAP_WIDTH = 800;
export const MAP_HEIGHT = 600;

/**
 * A seated player on the map. Coordinates are assigned once, at onJoin time,
 * and never move afterwards — the circles on every client are centered on
 * exactly the coordinates the room recorded here.
 */
export const MapPlayer = schema({
  x: t.number(),
  y: t.number(),
});
export type MapPlayer = SchemaType<typeof MapPlayer>;

export const MapRoomState = schema({
  mapWidth: t.number(),
  mapHeight: t.number(),
  players: t.map(MapPlayer),
});
export type MapRoomState = SchemaType<typeof MapRoomState>;

export interface MapRoomOptions {
  /**
   * How many seats a single map room holds. The queue always forms a pair of
   * two clients and reserves both seats; this value decides whether the second
   * seat can actually be taken (2 = both, 1 = the second is refused with 524).
   */
  roomCapacity?: number;
}

/**
 * The map room players are seated into. `maxClients` comes from the
 * `roomCapacity` option forwarded by the queue (default 2).
 */
export class MapRoom extends Room<{ state: MapRoomState }> {
  state = new MapRoomState();

  onCreate(options: MapRoomOptions = {}) {
    this.maxClients = options.roomCapacity ?? 2;
    // Seat notifications are delivered over the queue connection; clients then
    // open a fresh socket to consume them. Give that second hop a generous
    // window so a slow client never trips a false "seat reservation expired".
    this.seatReservationTimeout = 60;

    this.state.mapWidth = MAP_WIDTH;
    this.state.mapHeight = MAP_HEIGHT;
  }

  onJoin(client: Client) {
    // Coordinates are recorded by the room itself at seating time. Every
    // client renders circles from these exact values.
    const player = new MapPlayer();
    player.x = Math.random() * this.state.mapWidth;
    player.y = Math.random() * this.state.mapHeight;
    this.state.players.set(client.sessionId, player);
  }

  async onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }

  /**
   * Snapshot of who is currently in the room and where they are seated.
   * Exported over HTTP (see app.config.ts) — the returned batch is the same
   * batch the state map (and therefore every client's canvas) is drawing.
   */
  public exportPlayers() {
    const players: Array<{ sessionId: string; x: number; y: number }> = [];
    this.state.players.forEach((player, sessionId) => {
      players.push({ sessionId, x: player.x, y: player.y });
    });
    return {
      roomId: this.roomId,
      mapWidth: this.state.mapWidth,
      mapHeight: this.state.mapHeight,
      players,
    };
  }
}

/**
 * Creation options for the map queue. `matchRoomName` is fixed internally
 * (always "map_room"), so callers only configure the matching size.
 */
export interface MapQueueOptions extends Omit<QueueOptions, "matchRoomName" | "onGroupReady"> {}

/**
 * Queue room: clients join here first and are matched in pairs. Once two
 * clients are waiting, a MapRoom is created, seats are reserved for both, and
 * each client receives a "seat" message carrying its reservation.
 *
 * The created room's capacity is read from the `roomCapacity` join option of
 * the clients in the ready group, so the same queue supports 2-seat and
 * 1-seat map rooms without changing the matching logic.
 */
export class MapQueueRoom extends QueueRoom {
  onCreate(options: MapQueueOptions = {}) {
    super.onCreate({
      // pairs only: do not start a match with an incomplete group
      allowIncompleteGroups: false,
      ...options,
      matchRoomName: "map_room",
      maxPlayers: options.maxPlayers ?? 2,
    });

    // Build the map room with the capacity this group queued with. The first
    // client's option is representative — the queue only groups compatible
    // clients, and the example always sends the same value.
    this.onGroupReady = async function (this: MapQueueRoom, group: QueueMatchGroup) {
      const capacity = group.clients[0]?.userData?.options?.roomCapacity ?? 2;
      return await matchMaker.createRoom("map_room", { roomCapacity: capacity });
    };
  }

  onJoin(client: Client, options: { rank?: number; roomCapacity?: number }) {
    const queueData: QueueClientData = {
      rank: options.rank ?? 0,
      options,
    };
    this.addToQueue(client, queueData);
  }
}

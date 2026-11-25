/**
 * Integration tests for the example page's 进房 flow.
 *
 * The button joins a matchmaking queue first; once two players are waiting,
 * both are seated into the same map room and their canvases render the same
 * two circles at the room's recorded coordinates. These tests reproduce the
 * two scenarios reported from the example page:
 *
 *   1. roomCapacity=2 — both players take seats, both see two circles, the
 *      exported player snapshot matches the circles, and the "clients"
 *      waiting count tracks the unseated queue size (1 then 2, not 1 then 1).
 *   2. roomCapacity=1 — the second seat is rejected with 524
 *      ("seat reservation expired"); the rejected player has no circle and is
 *      not in the room, while the first player's circle stays at the recorded
 *      coordinates.
 *
 *   pnpm exec tsx --test --test-force-exit --test-timeout=60000 test/map-room-queue.test.ts
 */
import assert from 'node:assert';
import { describe, it, before, after, afterEach } from 'node:test';

const { defineServer, defineRoom, LocalDriver, LocalPresence, matchMaker, createEndpoint, createRouter } = await import('@colyseus/core');
const { listen } = await import('@colyseus/tools');
const { Client, MatchMakeError } = await import('@colyseus/sdk');
const { MapRoom, MapQueueRoom, MAP_WIDTH, MAP_HEIGHT } = await import('../src/MapRoom.ts');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Joining resolves on the JOIN_ROOM handshake; the full state lands one
 * round-trip later. Wait for the first state patch (mirrors the helper the
 * @colyseus/testing package adds to SDK rooms).
 */
async function waitForInitialState(room: any): Promise<void> {
  if (room.serializerId === 'none') { return; }
  return new Promise<void>((resolve) => {
    room.onStateChange.once(() => resolve());
    room.onLeave.once(() => resolve()); // rejected after the handshake: don't hang
  });
}

/** Collect every "clients" waiting-count message a queue connection receives. */
function trackWaitingCounts(queueRoom: any): number[] {
  const counts: number[] = [];
  queueRoom.onMessage('clients', (count: number) => counts.push(count));
  return counts;
}

/**
 * Drive one player through the full flow: join the queue, wait for the seat
 * reservation, then consume it on the map room. The returned promise rejects
 * (with the SDK MatchMakeError) if the seat cannot be consumed.
 */
async function enterThroughQueue(client: InstanceType<typeof Client>, rank: number, roomCapacity: number) {
  const queue: any = await client.joinOrCreate('map_queue', { rank, roomCapacity });

  const seat = await new Promise<any>((resolve, reject) => {
    let settled = false;
    queue.onMessage('seat', (reservation: any) => {
      if (!settled) { settled = true; resolve(reservation); }
    });
    queue.onLeave((code: number) => {
      if (!settled) { settled = true; reject(new Error(`queue closed early (${code})`)); }
    });
    queue.onError((code: number, message: string) => {
      if (!settled) { settled = true; reject(new Error(`queue error ${code}: ${message}`)); }
    });
  });

  let mapRoom: any;
  try {
    mapRoom = await client.consumeSeatReservation(seat);
  } finally {
    // The queue connection is only needed to carry the seat notification.
    queue.send('confirm', {});
    queue.leave();
  }
  await waitForInitialState(mapRoom);
  return { queue, mapRoom };
}

let base: string;
let wsBase: string;
let server: any;
let driver: InstanceType<typeof LocalDriver>;

before(async () => {
  const port = 2900 + Math.floor(Math.random() * 200);
  driver = new LocalDriver();
  server = defineServer({
    presence: new LocalPresence(),
    driver,
    greet: false,
    gracefullyShutdown: false,
    rooms: {
      map_room: defineRoom(MapRoom),
      map_queue: defineRoom(MapQueueRoom, { maxPlayers: 2 }),
    },
    routes: createRouter({
      // Same snapshot the room state draws from — who is in the room and the
      // coordinates their circles are centered on.
      mapRoomPlayers: createEndpoint('/map-rooms/:roomId/players', { method: 'GET' }, async (ctx: any) => {
        const room = matchMaker.getLocalRoomById(ctx.params.roomId);
        if (!room || !(room instanceof MapRoom)) {
          return { roomId: ctx.params.roomId, players: [] };
        }
        return room.exportPlayers();
      }),
    }),
  });
  await listen(server, port);
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

// Each test must start with an empty queue: queue rooms persist across tests
// and a leftover waiting client would corrupt the waiting-count assertions.
afterEach(async () => {
  // Forcibly dispose every room (map + queue), then drop their driver rows so
  // the next test sees neither lingering clients nor stale reservations.
  await Promise.all(matchMaker.disconnectAll());
  await wait(50);
  await driver.clear();
});

after(async () => {
  await matchMaker.disconnectAll();
  await server.gracefullyShutdown(false);
});

describe('进房 queue → map room', () => {
  it('a freshly joined queue client has no map room and no circle before being seated', async () => {
    const client = new Client(wsBase);
    const queue: any = await client.joinOrCreate('map_queue', { rank: 10, roomCapacity: 2 });

    // Only the queue connection exists at this point — no map room, no circles.
    assert.equal(queue.name, 'map_queue');
    assert.equal(queue.state, undefined);

    queue.leave();
  });

  it('two players (rank 10 and 12) are seated into the same map room and both see two circles at the recorded coordinates', async () => {
    const clientA = new Client(wsBase);
    const queueA: any = await clientA.joinOrCreate('map_queue', { rank: 10, roomCapacity: 2 });
    const countsA = trackWaitingCounts(queueA);

    // First player waits alone for longer than one queue cycle (1000ms).
    await wait(1200);
    assert.deepEqual(countsA, [1], 'lone waiting player is told the queue holds 1 unseated client');

    const clientB = new Client(wsBase);
    const queueB: any = await clientB.joinOrCreate('map_queue', { rank: 12, roomCapacity: 2 });
    const countsB = trackWaitingCounts(queueB);

    // Attach seat listeners before any further wait: the ready group may be
    // processed on the very next queue tick, which can happen inside the wait
    // below. A listener attached afterwards would miss the message and hang.
    const seatPromiseA = new Promise<any>((resolve) => queueA.onMessage('seat', resolve));
    const seatPromiseB = new Promise<any>((resolve) => queueB.onMessage('seat', resolve));

    // One queue tick later, B has been told 2 unseated clients (not 1). A was
    // alone (1); the tick that pairs them stops A's waiting-count updates, so
    // A's recorded counts stay [1].
    await wait(1100);
    assert.equal(countsB[countsB.length - 1], 2, 'second player is told 2 unseated clients, not 1');
    assert.deepEqual(countsA, [1]);

    const [seatA, seatB] = await Promise.all([seatPromiseA, seatPromiseB]);

    // Both reservations point at the same map room.
    assert.equal(seatA.roomId, seatB.roomId, 'both players seated into the same room');
    const roomId = seatA.roomId;

    const mapRoomA = await clientA.consumeSeatReservation(seatA);
    const mapRoomB = await clientB.consumeSeatReservation(seatB);
    await Promise.all([waitForInitialState(mapRoomA), waitForInitialState(mapRoomB)]);

    queueA.send('confirm', {}); queueA.leave();
    queueB.send('confirm', {}); queueB.leave();

    // Both clients render the same two-player batch.
    const stateA = mapRoomA.state as any;
    const stateB = mapRoomB.state as any;
    assert.equal(stateA.mapWidth, MAP_WIDTH);
    assert.equal(stateA.mapHeight, MAP_HEIGHT);
    assert.equal(stateA.players.size, 2, 'first client sees two circles');
    assert.equal(stateB.players.size, 2, 'second client sees two circles');

    // The circle centers are the room's recorded coordinates, identical on
    // both sides (within schema float encoding precision).
    const closeEnough = (x: number, y: number) => Math.abs(x - y) < 1e-3;
    const coordsA = new Map<string, { x: number; y: number }>();
    stateA.players.forEach((p: any, id: string) => coordsA.set(id, { x: p.x, y: p.y }));
    stateB.players.forEach((p: any, id: string) => {
      const other = coordsA.get(id);
      assert.ok(other, `player ${id} present on both clients`);
      assert.ok(closeEnough(other!.x, p.x), `x of ${id} matches across clients`);
      assert.ok(closeEnough(other!.y, p.y), `y of ${id} matches across clients`);
    });

    // Each client's own session is among the seated players.
    assert.ok(coordsA.has(mapRoomA.sessionId));
    assert.ok(coordsA.has(mapRoomB.sessionId));

    // Export endpoint: same batch, same coordinates as the drawn circles.
    const exported = await (await fetch(`${base}/map-rooms/${roomId}/players`)).json();
    assert.equal(exported.roomId, roomId);
    assert.equal(exported.mapWidth, MAP_WIDTH);
    assert.equal(exported.mapHeight, MAP_HEIGHT);
    assert.equal(exported.players.length, 2);
    for (const entry of exported.players) {
      const drawn = coordsA.get(entry.sessionId);
      assert.ok(drawn, `exported player ${entry.sessionId} is one of the drawn circles`);
      assert.ok(Math.abs(entry.x - drawn!.x) < 1e-3);
      assert.ok(Math.abs(entry.y - drawn!.y) < 1e-3);
    }

    await mapRoomA.leave();
    await mapRoomB.leave();
  });

  it('when the map room holds one, the second player is rejected (524), draws no circle, and the first circle remains', async () => {
    const clientA = new Client(wsBase);
    const clientB = new Client(wsBase);

    const [resultA, resultB] = await Promise.allSettled([
      enterThroughQueue(clientA, 10, 1),
      enterThroughQueue(clientB, 12, 1),
    ]);

    // One seat taken, one rejected.
    assert.equal(resultA.status, 'fulfilled', 'first player takes the single seat');
    if (resultA.status !== 'fulfilled') throw resultA.reason;
    assert.equal(resultB.status, 'rejected', 'second player is refused the second seat');

    const rejection = (resultB as PromiseRejectedResult).reason as InstanceType<typeof MatchMakeError>;
    assert.equal(rejection.code, 524, 'rejection carries the matchmake-expired code 524');

    // The seated player's room contains exactly one player at recorded coords.
    const { mapRoom: mapRoomA } = resultA.value;
    const stateA = mapRoomA.state as any;
    assert.equal(stateA.players.size, 1, 'the single-seat room holds one player');
    const seated = stateA.players.get(mapRoomA.sessionId);
    assert.ok(seated, 'the seated player is the one whose circle is drawn');
    const recordedX = seated.x;
    const recordedY = seated.y;

    // The rejected client never consumed a seat: it is absent from the room
    // roster and the export, and the remaining circle keeps its coordinates.
    const roomId = mapRoomA.roomId;
    const exported = await (await fetch(`${base}/map-rooms/${roomId}/players`)).json();
    assert.equal(exported.players.length, 1, 'rejected player absent from the room roster');
    assert.equal(exported.players[0].sessionId, mapRoomA.sessionId);
    assert.ok(Math.abs(exported.players[0].x - recordedX) < 1e-3, 'remaining circle stays at the recorded x');
    assert.ok(Math.abs(exported.players[0].y - recordedY) < 1e-3, 'remaining circle stays at the recorded y');

    await mapRoomA.leave();
  });

  it('waiting count follows the number of unseated clients (1, then 2)', async () => {
    const clientA = new Client(wsBase);
    const queueA: any = await clientA.joinOrCreate('map_queue', { rank: 10, roomCapacity: 2 });
    const countsA = trackWaitingCounts(queueA);

    await wait(1200);
    assert.deepEqual(countsA, [1]);

    const clientB = new Client(wsBase);
    const queueB: any = await clientB.joinOrCreate('map_queue', { rank: 12, roomCapacity: 2 });
    const countsB = trackWaitingCounts(queueB);

    // Attach seat listeners before the tick wait to avoid missing the message.
    const seatPromiseA = new Promise<any>((resolve) => queueA.onMessage('seat', resolve));
    const seatPromiseB = new Promise<any>((resolve) => queueB.onMessage('seat', resolve));

    // Give the queue tick a moment to run, then both should be seated.
    await wait(1100);
    const [seatA, seatB] = await Promise.all([seatPromiseA, seatPromiseB]);

    assert.equal(seatA.roomId, seatB.roomId);
    assert.equal(countsB[countsB.length - 1], 2, 'joining a non-empty queue reports 2 waiting');

    const mapRoomA = await clientA.consumeSeatReservation(seatA);
    const mapRoomB = await clientB.consumeSeatReservation(seatB);
    queueA.leave(); queueB.leave();
    await Promise.all([waitForInitialState(mapRoomA), waitForInitialState(mapRoomB)]);
    await mapRoomA.leave();
    await mapRoomB.leave();
  });
});

import '@colyseus/sdk/debug';
import { Client, Callbacks, MatchMakeError, Room, type SeatReservation } from '@colyseus/sdk';

import type { server } from './server/vite.ts';
import type { MapRoom, MapQueueRoom } from './MapRoom.ts';

const logElement = document.querySelector<HTMLPreElement>('#log');
const button = document.querySelector<HTMLButtonElement>('#connect');
const statusEl = document.querySelector<HTMLSpanElement>('#status');
const canvas = document.querySelector<HTMLCanvasElement>('#game');
const ctx = canvas?.getContext('2d');

/**
 * Only players that have actually taken a seat are ever stored here. A seat
 * notification alone adds nothing — the entry is created by the map room's
 * state once the seat is consumed, so a rejected client (524) can never leave
 * a circle behind.
 */
const players = new Map<string, { x: number; y: number }>();

let queueRoom: Room<MapQueueRoom> | null = null;
let mapRoom: Room<MapRoom> | null = null;

const httpClient = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

document.getElementById('btn-hello')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/hello');
  log(`/hello: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-time')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/time');
  log(`/time: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-express')?.addEventListener('click', async () => {
  const res = await fetch(`${location.origin}/express-hello`);
  log(`/express-hello: ${JSON.stringify(await res.json())}`);
});

function log(message: string) {
  if (logElement) {
    logElement.textContent = message;
  }
}

function setStatus(state: 'idle' | 'connecting' | 'connected' | 'disconnected', text: string) {
  if (!statusEl) return;
  statusEl.className = state;
  statusEl.innerHTML = `<span class="dot"></span>${text}`;
}

function draw() {
  if (!ctx || !canvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // The canvas mirrors the seated batch: one circle per player in the map
  // room state, centered on the coordinates the room recorded.
  players.forEach((player, sessionId) => {
    const isMe = mapRoom !== null && sessionId === mapRoom.sessionId;

    // Player circle — own circle blue, the other player's grey.
    ctx.beginPath();
    ctx.arc(player.x, player.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = isMe ? '#2563eb' : '#6b7280';
    ctx.fill();

    // Session ID label
    ctx.fillStyle = '#9ca3af';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(sessionId.slice(0, 6), player.x, player.y + 24);
  });

  requestAnimationFrame(draw);
}

let renderLoopStarted = false;
function startRenderLoopOnce() {
  if (renderLoopStarted) { return; }
  renderLoopStarted = true;
  requestAnimationFrame(draw);
}

/**
 * Bind a connected map room to the canvas. Players are sourced exclusively
 * from the room state, so circles and the room's recorded coordinates can
 * never diverge. Returns once the listeners are installed.
 */
function bindMapRoom(room: Room<MapRoom>) {
  mapRoom = room;
  players.clear();

  const callbacks = Callbacks.get(room);

  callbacks.onAdd("players", (player, sessionId) => {
    players.set(sessionId, { x: player.x, y: player.y });
    callbacks.listen(player, "x", (value) => {
      const p = players.get(sessionId);
      if (p) p.x = value;
    });
    callbacks.listen(player, "y", (value) => {
      const p = players.get(sessionId);
      if (p) p.y = value;
    });
    log(`Seated: ${sessionId}`);
  });

  callbacks.onRemove("players", (_, sessionId) => {
    players.delete(sessionId);
    log(`Player left: ${sessionId}`);
  });

  room.onLeave(() => {
    players.clear();
    mapRoom = null;
  });

  startRenderLoopOnce();
}

async function leaveAll() {
  const leaving = mapRoom ?? queueRoom;
  queueRoom = null;
  mapRoom = null;
  players.clear();
  leaving?.leave();
  setStatus('idle', 'Idle');
  button!.textContent = '进房';
  button!.disabled = false;
}

button?.addEventListener('click', async () => {
  if (queueRoom || mapRoom) {
    await leaveAll();
    return;
  }

  button.textContent = '正在连';
  button.disabled = true;
  setStatus('connecting', '正在连');

  try {
    const client = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

    // Demo knobs via query string (?capacity=1, ?rank=12) — defaults are the
    // two-seat, rank-10 flow. The capacity is forwarded to the queue so it
    // creates the map room with the matching number of seats.
    const params = new URLSearchParams(location.search);
    const roomCapacity = Number(params.get('capacity') ?? 2);
    const rank = Number(params.get('rank') ?? 10);

    //
    // 1. Join the queue. Nothing is drawn at this point: the client has no
    //    seat and no coordinates.
    //
    queueRoom = await client.joinOrCreate('map_queue', { rank, roomCapacity });
    setStatus('connecting', '排队中… 等待人数 1');

    //
    // 2. Wait for a seat reservation. It is delivered in the same join flow
    //    as the queue "clients"/"seat" messages — no circle is drawn for it,
    //    drawing only starts once the seat is consumed and state arrives.
    //
    const seat = await new Promise<SeatReservation>((resolve, reject) => {
      let settled = false;
      queueRoom!.onMessage('clients', (count: number) => {
        setStatus('connecting', `排队中… 等待人数 ${count}`);
        log(`等待人数: ${count}`);
      });
      queueRoom!.onMessage('seat', (reservation: SeatReservation) => {
        if (!settled) { settled = true; resolve(reservation); }
      });
      // Only a close before the seat arrives is a failure; the confirm/leave
      // after a successful seat is expected and must not reject here.
      queueRoom!.onLeave((code) => {
        if (!settled) { settled = true; reject(new Error(`queue closed (${code})`)); }
      });
      queueRoom!.onError((code, message) => {
        if (!settled) { settled = true; reject(new Error(`queue error ${code}: ${message}`)); }
      });
    });

    //
    // 3. Consume the seat on the map room. On rejection (e.g. 524 seat
    //    reservation expired) this throws and no circle is ever drawn.
    //
    let room: Room<MapRoom>;
    try {
      room = await client.consumeSeatReservation<MapRoom>(seat);
    } catch (e) {
      const err = e as MatchMakeError;
      setStatus('disconnected', `被拒绝 (${err.code ?? '?'}) ${err.message ?? ''}`);
      log(`座位被拒绝: ${err.code ?? ''} ${err.message ?? ''}`);
      button.textContent = '进房';
      button.disabled = false;
      // The seat was refused — drop the queue connection too. No circle is
      // ever drawn because the map room state never arrives for this client.
      queueRoom?.leave();
      queueRoom = null;
      return;
    }

    // Seat consumed — the queue connection has served its purpose.
    const queue = queueRoom;
    queueRoom = null;
    queue.send('confirm', {});
    queue.leave();

    //
    // 4. Bind the room state to the canvas. Right after this returns the
    //    join may already be complete while coordinates are still one patch
    //    away — players stay empty until onAdd fires.
    //
    bindMapRoom(room);
    room.reconnection.minUptime = 0;

    setStatus('connected', `房间 ${room.roomId} | Session ${room.sessionId}`);
    button.textContent = '离开';
    button.disabled = false;

    room.onError((code, message) => {
      log(`Error ${code}: ${message}`);
    });

    room.onLeave((code) => {
      setStatus('disconnected', `Disconnected (code: ${code})`);
      log(`Left room (code: ${code})`);
      button.textContent = '进房';
      button.disabled = false;
      players.clear();
      mapRoom = null;
      queueRoom = null;
    });

  } catch (e) {
    setStatus('disconnected', 'Connection failed');
    log(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
    button.textContent = '进房';
    button.disabled = false;
    queueRoom = null;
    mapRoom = null;
    players.clear();
  }
});

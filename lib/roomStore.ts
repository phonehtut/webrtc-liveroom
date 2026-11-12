export interface Participant {
  peerId: string;
  participantId: string;
  name: string;
  x: number;
  y: number;
  muted: boolean;
  joinedAt: number;
  lastSeen: number;
}

export interface RoomState {
  participants: Map<string, Participant>;
  sseControllers: Set<ReadableStreamDefaultController<Uint8Array>>;
}

declare global {
  var __roomState: RoomState | undefined;
}

function createRoomState(): RoomState {
  return {
    participants: new Map(),
    sseControllers: new Set(),
  };
}

export function getRoomState(): RoomState {
  if (!global.__roomState) {
    global.__roomState = createRoomState();
  }
  return global.__roomState;
}

export function purgeStaleParticipants(state: RoomState) {
  const now = Date.now();
  let changed = false;
  for (const [peerId, p] of state.participants.entries()) {
    if (now - p.lastSeen > 20000) {
      state.participants.delete(peerId);
      changed = true;
    }
  }
  return changed;
}

export function broadcastRoomState(state: RoomState) {
  purgeStaleParticipants(state);

  const data = JSON.stringify({
    type: "room_state",
    participants: Array.from(state.participants.values()),
  });
  const encoded = new TextEncoder().encode(`data: ${data}\n\n`);

  const dead: ReadableStreamDefaultController<Uint8Array>[] = [];
  for (const ctrl of state.sseControllers) {
    try {
      ctrl.enqueue(encoded);
    } catch {
      dead.push(ctrl);
    }
  }
  for (const ctrl of dead) {
    state.sseControllers.delete(ctrl);
  }
}

import { getRoomState, broadcastRoomState } from "@/lib/roomStore";

export async function PUT(request: Request) {
  const body = (await request.json()) as {
    peerId: string;
    x?: number;
    y?: number;
    muted?: boolean;
  };

  const { peerId, x, y, muted } = body;

  const state = getRoomState();
  const participant = state.participants.get(peerId);

  if (!participant) {
    return Response.json({ error: "Participant not found" }, { status: 404 });
  }

  participant.lastSeen = Date.now();
  if (x !== undefined) participant.x = Math.max(0, Math.min(100, x));
  if (y !== undefined) participant.y = Math.max(0, Math.min(100, y));
  if (muted !== undefined) participant.muted = muted;

  broadcastRoomState(state);
  return Response.json({ ok: true });
}

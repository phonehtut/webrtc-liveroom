import { getRoomState, broadcastRoomState } from "@/lib/roomStore";

export async function DELETE(request: Request) {
  const body = (await request.json()) as { peerId: string };
  const state = getRoomState();
  state.participants.delete(body.peerId);
  broadcastRoomState(state);
  return Response.json({ ok: true });
}

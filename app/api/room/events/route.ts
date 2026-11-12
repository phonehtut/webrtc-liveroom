import { getRoomState } from "@/lib/roomStore";

export async function GET() {
  const state = getRoomState();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const initial = JSON.stringify({
        type: "room_state",
        participants: Array.from(state.participants.values()),
      });
      controller.enqueue(new TextEncoder().encode(`data: ${initial}\n\n`));

      state.sseControllers.add(controller);
    },
    cancel(controller) {
      state.sseControllers.delete(controller);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

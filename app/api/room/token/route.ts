import { getRoomState, broadcastRoomState } from "@/lib/roomStore";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "0ae56235a9ce0774bb919baf0302a469";
const APP_ID = process.env.REALTIMEKIT_APP_ID || "f006f61b-3fbc-463b-bc4a-062642783934";
const MEETING_ID = process.env.NEXT_PUBLIC_MEETING_ID || "bbbd50b4-7cb7-4eb5-b663-db361de918d2";
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

export async function POST(request: Request) {
  if (!API_TOKEN) {
    return Response.json(
      { error: "CLOUDFLARE_API_TOKEN is not configured in .env.local" },
      { status: 500 }
    );
  }

  const body = (await request.json()) as {
    peerId: string;
    name: string;
    x?: number;
    y?: number;
  };

  const { peerId, name, x, y } = body;

  if (!peerId || !name) {
    return Response.json({ error: "peerId and name are required" }, { status: 400 });
  }

  try {
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/realtime/kit/${APP_ID}/meetings/${MEETING_ID}/participants`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          preset_name: "group_call_host",
          custom_participant_id: peerId,
        }),
      }
    );

    const json = (await cfRes.json()) as {
      success: boolean;
      data?: { token: string; id: string };
      errors?: Array<{ message: string }>;
    };

    if (!json.success || !json.data?.token) {
      const errMsg = json.errors?.[0]?.message || "Failed to generate RealtimeKit token";
      return Response.json({ error: errMsg }, { status: 502 });
    }

    const { token: authToken, id: participantId } = json.data;

    const state = getRoomState();
    const now = Date.now();

    state.participants.set(peerId, {
      peerId,
      participantId,
      name: name.trim(),
      x: x ?? 50,
      y: y ?? 50,
      muted: false,
      joinedAt: now,
      lastSeen: now,
    });

    broadcastRoomState(state);

    return Response.json({
      authToken,
      participantId,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

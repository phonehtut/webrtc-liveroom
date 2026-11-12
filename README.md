# Proximity Voice — Mini Game

A multiplayer proximity voice chat mini-game built with **Next.js 16** and **Cloudflare RealtimeKit**.

Players move avatars on a 2D map. Voice chat volume scales dynamically with proximity:
- **Closer = Louder (100% volume within 5% distance)**
- **Farther = Quieter (linear falloff between 5% and 40%)**
- **Out of range = Silent (> 40% distance)**

## Stack

- **Next.js 16** (App Router, Turbopack)
- **@cloudflare/realtimekit** (Managed Edge SFU & WebRTC network — no manual TURN server setup required)
- **Web Audio API** (GainNode distance-based volume modulation)
- **HTML5 Video/Audio Audio routing** (Auto loudspeaker / speakerphone output for mobile Android & iOS)
- **Server-Sent Events (SSE)** (Real-time avatar map position synchronization)

## Configuration

In `.env.local`:

```env
CLOUDFLARE_ACCOUNT_ID=0ae56235a9ce0774bb919baf0302a469
REALTIMEKIT_APP_ID=f006f61b-3fbc-463b-bc4a-062642783934
NEXT_PUBLIC_MEETING_ID=bbbd50b4-7cb7-4eb5-b663-db361de918d2
CLOUDFLARE_API_TOKEN=your_token_here
```

## How It Works

1. Client requests an auth token from `/api/room/token`.
2. Backend calls Cloudflare RealtimeKit REST API to register the participant and receives a JWT `authToken`.
3. Client initializes `@cloudflare/realtimekit`:
   ```ts
   const meeting = await RealtimeKitClient.init({ authToken });
   await meeting.join();
   ```
4. Remote audio tracks are connected to Web Audio `GainNode` + in-DOM media elements for loud mobile speakerphone output.
5. As avatars are dragged, distance is computed and volume dynamically updates.

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import RealtimeKitClient, { RTKParticipant } from "@cloudflare/realtimekit";

interface ParticipantState {
  peerId: string;
  participantId: string;
  name: string;
  x: number;
  y: number;
  muted: boolean;
}

interface RemoteAudioNode {
  participantId: string;
  peerId: string;
  gainNode: GainNode;
  audioElement: HTMLAudioElement;
}

const MAX_HEAR_DISTANCE = 40;
const MIN_HEAR_DISTANCE = 5;
const AVATAR_RADIUS = 22;
const POSITION_THROTTLE_MS = 80;

function generateId() {
  return crypto.randomUUID();
}

function distance(ax: number, ay: number, bx: number, by: number) {
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

function proximityVolume(myX: number, myY: number, theirX: number, theirY: number): number {
  const d = distance(myX, myY, theirX, theirY);
  if (d >= MAX_HEAR_DISTANCE) return 0;
  if (d <= MIN_HEAR_DISTANCE) return 1;
  return 1 - (d - MIN_HEAR_DISTANCE) / (MAX_HEAR_DISTANCE - MIN_HEAR_DISTANCE);
}

const AVATAR_PALETTE = [
  { bg: "#2563eb", text: "#ffffff" },
  { bg: "#0d9488", text: "#ffffff" },
  { bg: "#d97706", text: "#ffffff" },
  { bg: "#7c3aed", text: "#ffffff" },
  { bg: "#dc2626", text: "#ffffff" },
  { bg: "#0284c7", text: "#ffffff" },
  { bg: "#4f46e5", text: "#ffffff" },
  { bg: "#059669", text: "#ffffff" },
];

function getAvatarStyle(peerId: string) {
  let hash = 0;
  for (const c of peerId) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

export default function ProximityRoom() {
  const [nameInput, setNameInput] = useState("");
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMobileList, setShowMobileList] = useState(false);
  const [audioNeedsUnlock, setAudioNeedsUnlock] = useState(false);

  const myPeerId = useRef<string>("");
  const myParticipantId = useRef<string>("");
  const myPos = useRef({ x: 50, y: 50 });
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);

  const meetingRef = useRef<Awaited<ReturnType<typeof RealtimeKitClient.init>> | null>(null);

  const [participants, setParticipants] = useState<ParticipantState[]>([]);
  const participantsRef = useRef<ParticipantState[]>([]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const remoteAudioNodes = useRef<Map<string, RemoteAudioNode>>(new Map());

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragActive = useRef(false);
  const lastSentPos = useRef({ x: -999, y: -999 });
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!myPeerId.current) {
      myPeerId.current = generateId();
    }
    myPos.current = { x: 20 + Math.random() * 60, y: 20 + Math.random() * 60 };
  }, []);

  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new AudioCtx();
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }, []);

  const unlockAllAudio = useCallback(() => {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") {
      ctx.resume().then(() => setAudioNeedsUnlock(false)).catch(() => {});
    } else {
      setAudioNeedsUnlock(false);
    }
    for (const node of remoteAudioNodes.current.values()) {
      if (node.audioElement) {
        node.audioElement.play().catch(() => {});
      }
    }
  }, [getAudioContext]);

  useEffect(() => {
    window.addEventListener("click", unlockAllAudio);
    window.addEventListener("touchstart", unlockAllAudio);
    return () => {
      window.removeEventListener("click", unlockAllAudio);
      window.removeEventListener("touchstart", unlockAllAudio);
    };
  }, [unlockAllAudio]);

  const sendPosition = useCallback((x: number, y: number, muteState?: boolean) => {
    if (throttleTimer.current) return;
    throttleTimer.current = setTimeout(() => {
      throttleTimer.current = null;
      const dx = Math.abs(x - lastSentPos.current.x);
      const dy = Math.abs(y - lastSentPos.current.y);
      if (dx < 0.5 && dy < 0.5 && muteState === undefined) return;
      lastSentPos.current = { x, y };
      fetch("/api/room/position", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: myPeerId.current, x, y, muted: mutedRef.current }),
        keepalive: true,
      }).catch(() => {});
    }, POSITION_THROTTLE_MS);
  }, []);

  const updateVolumes = useCallback(() => {
    const me = participantsRef.current.find((p) => p.peerId === myPeerId.current);
    if (!me) return;
    const ctx = getAudioContext();

    for (const [, node] of remoteAudioNodes.current) {
      const them = participantsRef.current.find(
        (p) => p.peerId === node.peerId || p.participantId === node.participantId
      );

      const vol = them ? (them.muted ? 0 : proximityVolume(me.x, me.y, them.x, them.y)) : 0.8;

      node.gainNode.gain.setTargetAtTime(vol, ctx.currentTime, 0.05);

      try {
        node.audioElement.volume = Math.max(0, Math.min(1, vol));
        if (node.audioElement.paused && vol > 0.01) {
          node.audioElement.play().catch(() => setAudioNeedsUnlock(true));
        }
      } catch {
      }
    }
  }, [getAudioContext]);

  const attachParticipantAudio = useCallback((participant: RTKParticipant) => {
    const participantId = participant.id;
    const peerId = participant.customParticipantId || participant.userId || participantId;

    if (remoteAudioNodes.current.has(participantId)) {
      const existing = remoteAudioNodes.current.get(participantId);
      if (existing && participant.audioTrack && (!existing.audioElement.srcObject || existing.audioElement.paused)) {
        existing.audioElement.srcObject = new MediaStream([participant.audioTrack]);
        existing.audioElement.play().catch(() => setAudioNeedsUnlock(true));
      }
      return;
    }

    if (!participant.audioTrack) {
      return;
    }

    const ctx = getAudioContext();
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(ctx.destination);

    const audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    (audioElement as unknown as { playsInline: boolean }).playsInline = true;
    audioElement.setAttribute("playsinline", "true");
    audioElement.setAttribute("webkit-playsinline", "true");
    audioElement.muted = false;
    audioElement.style.position = "fixed";
    audioElement.style.width = "1px";
    audioElement.style.height = "1px";
    audioElement.style.opacity = "0.001";
    audioElement.style.pointerEvents = "none";
    document.body.appendChild(audioElement);

    const stream = new MediaStream([participant.audioTrack]);

    try {
      const source = ctx.createMediaStreamSource(stream);
      source.connect(gainNode);
    } catch {
    }

    try {
      audioElement.srcObject = stream;
      audioElement.play().catch(() => {
        setAudioNeedsUnlock(true);
      });
    } catch {
    }

    participant.audioTrack.addEventListener("unmute", () => {
      audioElement.play().catch(() => setAudioNeedsUnlock(true));
    });

    remoteAudioNodes.current.set(participantId, {
      participantId,
      peerId,
      gainNode,
      audioElement,
    });

    updateVolumes();
  }, [getAudioContext, updateVolumes]);

  const detachParticipantAudio = useCallback((participantId: string) => {
    const node = remoteAudioNodes.current.get(participantId);
    if (node) {
      node.gainNode.disconnect();
      node.audioElement.srcObject = null;
      node.audioElement.remove();
      remoteAudioNodes.current.delete(participantId);
    }
  }, []);

  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) eventSourceRef.current.close();
    const es = new EventSource("/api/room/events");
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data) as { type: string; participants: ParticipantState[] };
      if (msg.type !== "room_state") return;

      const newParticipants = msg.participants;
      participantsRef.current = newParticipants;
      setParticipants([...newParticipants]);

      for (const [partId, node] of remoteAudioNodes.current) {
        if (!newParticipants.some((p) => p.peerId === node.peerId || p.participantId === partId)) {
          detachParticipantAudio(partId);
        }
      }

      updateVolumes();
    };
  }, [detachParticipantAudio, updateVolumes]);

  const syncMeetingParticipants = useCallback(() => {
    if (!meetingRef.current) return;
    const meeting = meetingRef.current;
    for (const p of meeting.participants.joined.toArray()) {
      if (p.id !== meeting.self.id) {
        if (p.audioTrack) {
          attachParticipantAudio(p);
        }
        p.off("audioUpdate", () => {});
        p.on("audioUpdate", ({ audioEnabled, audioTrack }) => {
          if (audioEnabled && audioTrack) {
            attachParticipantAudio(p);
          }
        });
      }
    }
  }, [attachParticipantAudio]);

  const joinRoom = useCallback(async () => {
    if (!nameInput.trim()) return;
    setJoining(true);
    setError(null);

    try {
      const ctx = getAudioContext();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const tokenRes = await fetch("/api/room/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          peerId: myPeerId.current,
          name: nameInput.trim(),
          x: myPos.current.x,
          y: myPos.current.y,
        }),
      });

      if (!tokenRes.ok) {
        const errJson = (await tokenRes.json()) as { error: string };
        throw new Error(errJson.error || "Failed to generate meeting token");
      }

      const { authToken, participantId } = (await tokenRes.json()) as {
        authToken: string;
        participantId: string;
      };
      myParticipantId.current = participantId;

      const meeting = await RealtimeKitClient.init({
        authToken,
        defaults: {
          audio: true,
          video: false,
        },
      });
      meetingRef.current = meeting;

      meeting.participants.joined.on("participantJoined", (p: RTKParticipant) => {
        if (p.audioTrack) {
          attachParticipantAudio(p);
        }
        p.on("audioUpdate", ({ audioEnabled, audioTrack }) => {
          if (audioEnabled && audioTrack) {
            attachParticipantAudio(p);
          }
        });
      });

      meeting.participants.joined.on("participantLeft", (p: RTKParticipant) => {
        detachParticipantAudio(p.id);
      });

      meeting.participants.joined.on("participantsUpdate", () => {
        syncMeetingParticipants();
      });

      await meeting.join();
      await meeting.self.enableAudio();

      syncMeetingParticipants();
      connectSSE();

      setJoined(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to room");
    } finally {
      setJoining(false);
    }
  }, [nameInput, connectSSE, getAudioContext, attachParticipantAudio, detachParticipantAudio, syncMeetingParticipants]);

  useEffect(() => {
    if (!joined) return;

    const interval = setInterval(() => {
      fetch("/api/room/position", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: myPeerId.current }),
        keepalive: true,
      }).catch(() => {});

      syncMeetingParticipants();
      updateVolumes();
    }, 2000);

    return () => clearInterval(interval);
  }, [joined, syncMeetingParticipants, updateVolumes]);

  const leaveRoom = useCallback(async () => {
    eventSourceRef.current?.close();

    if (meetingRef.current) {
      try {
        await meetingRef.current.leave();
      } catch {
      }
      meetingRef.current = null;
    }

    for (const [, node] of remoteAudioNodes.current) {
      node.gainNode.disconnect();
      node.audioElement.srcObject = null;
      node.audioElement.remove();
    }
    remoteAudioNodes.current.clear();

    audioCtxRef.current?.close();

    await fetch("/api/room/leave", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: myPeerId.current }),
      keepalive: true,
    }).catch(() => {});

    setJoined(false);
    setParticipants([]);
    setShowMobileList(false);
  }, []);

  const toggleMute = useCallback(async () => {
    const newMuted = !mutedRef.current;
    mutedRef.current = newMuted;
    setMuted(newMuted);

    if (meetingRef.current) {
      try {
        if (newMuted) {
          await meetingRef.current.self.disableAudio();
        } else {
          await meetingRef.current.self.enableAudio();
        }
      } catch {
      }
    }

    fetch("/api/room/position", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: myPeerId.current, muted: newMuted }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!joined) return;
    dragActive.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    unlockAllAudio();

    if (canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
      myPos.current = { x, y };
      const me = participantsRef.current.find((p) => p.peerId === myPeerId.current);
      if (me) {
        me.x = x;
        me.y = y;
      }
      updateVolumes();
      sendPosition(x, y);
    }
  }, [joined, sendPosition, updateVolumes, unlockAllAudio]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragActive.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    myPos.current = { x, y };

    const me = participantsRef.current.find((p) => p.peerId === myPeerId.current);
    if (me) {
      me.x = x;
      me.y = y;
    }

    updateVolumes();
    sendPosition(x, y);
  }, [sendPosition, updateVolumes]);

  const onPointerUp = useCallback(() => {
    dragActive.current = false;
  }, []);

  useEffect(() => {
    return () => {
      if (joined) leaveRoom();
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      navigator.sendBeacon(
        "/api/room/leave",
        JSON.stringify({ peerId: myPeerId.current })
      );
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const me = participants.find((p) => p.peerId === myPeerId.current);
  const others = participants.filter((p) => p.peerId !== myPeerId.current);

  const peerVolumes = new Map<string, number>();
  if (me) {
    for (const p of others) {
      peerVolumes.set(p.peerId, p.muted ? 0 : proximityVolume(me.x, me.y, p.x, p.y));
    }
  }

  if (!joined) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[100dvh] bg-slate-50 text-slate-900 p-4 sm:p-6">
        <div className="w-full max-w-sm bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-sm space-y-6">
          <div className="space-y-1.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
              Proximity Space
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 leading-normal">
              Spatial audio voice chat. Move your avatar closer to hear others clearly.
            </p>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-1">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Room Identifier
            </div>
            <div className="font-mono text-xs text-slate-700 break-all select-all">
              {process.env.NEXT_PUBLIC_MEETING_ID ?? "bbbd50b4-7cb7-4eb5-b663-db361de918d2"}
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl p-3">
              {error}
            </div>
          )}

          <div className="space-y-3">
            <label className="block text-xs font-semibold text-slate-700">
              Display Name
            </label>
            <input
              type="text"
              placeholder="e.g. Alex"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              maxLength={20}
              className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600 transition"
            />
            <button
              onClick={joinRoom}
              disabled={joining || !nameInput.trim()}
              className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl py-2.5 transition shadow-sm flex items-center justify-center gap-2"
            >
              {joining ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Connecting...
                </>
              ) : (
                "Enter Room"
              )}
            </button>
          </div>

          <div className="text-center text-[11px] text-slate-400">
            Microphone access is requested upon joining.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-slate-100 text-slate-900 select-none overflow-hidden touch-none font-sans">
      <header className="flex items-center justify-between px-3 sm:px-4 py-2.5 bg-white border-b border-slate-200 shrink-0 z-30 shadow-xs">
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <div>
            <div className="font-semibold text-xs sm:text-sm tracking-tight text-slate-900">
              Proximity Space
            </div>
            <div className="text-[11px] text-slate-500">
              {participants.length} connected
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          <button
            onClick={() => setShowMobileList(!showMobileList)}
            className="md:hidden flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 transition"
          >
            <UsersIcon className="w-3.5 h-3.5 text-slate-600" />
            <span>{participants.length}</span>
          </button>

          <button
            onClick={toggleMute}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition border ${
              muted
                ? "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"
                : "bg-white text-slate-800 border-slate-300 hover:bg-slate-50"
            }`}
          >
            {muted ? (
              <>
                <MicOffIcon className="w-3.5 h-3.5 text-red-600" />
                <span>Unmute</span>
              </>
            ) : (
              <>
                <MicIcon className="w-3.5 h-3.5 text-slate-700" />
                <span>Mute</span>
              </>
            )}
          </button>

          <button
            onClick={leaveRoom}
            className="flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 hover:text-red-600 transition"
          >
            <LogOutIcon className="w-3.5 h-3.5" />
            <span>Leave</span>
          </button>
        </div>
      </header>

      {audioNeedsUnlock && (
        <div
          onClick={unlockAllAudio}
          className="bg-blue-600 text-white text-xs font-semibold px-4 py-2 text-center cursor-pointer flex items-center justify-center gap-2 z-40 transition"
        >
          <VolumeIcon className="w-3.5 h-3.5 text-white" />
          <span>Audio output paused. Click anywhere to activate sound.</span>
        </div>
      )}

      <div className="flex flex-1 relative overflow-hidden">
        <div
          ref={canvasRef}
          className="relative flex-1 w-full h-full cursor-crosshair overflow-hidden touch-none bg-slate-50"
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <GridPattern />

          {me && <HearingRings x={me.x} y={me.y} />}

          {participants.map((p) => {
            const isMe = p.peerId === myPeerId.current;
            const vol = peerVolumes.get(p.peerId) ?? 0;
            return (
              <PlayerAvatar
                key={p.peerId}
                participant={p}
                isMe={isMe}
                volume={isMe ? 0 : vol}
              />
            );
          })}

          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-none text-center px-3 py-1 rounded-full bg-white/90 border border-slate-200 shadow-xs text-[11px] font-medium text-slate-500">
            Drag your avatar to adjust distance
          </div>
        </div>

        <aside className="hidden md:flex w-60 shrink-0 bg-white border-l border-slate-200 flex-col overflow-hidden z-20">
          <div className="px-3.5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100 flex items-center justify-between">
            <span>Participants</span>
            <span className="bg-slate-100 text-slate-600 font-mono px-2 py-0.5 rounded-full text-[10px]">
              {participants.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {participants.map((p) => {
              const isMe = p.peerId === myPeerId.current;
              const vol = isMe ? 1 : (peerVolumes.get(p.peerId) ?? 0);
              return (
                <ParticipantRow
                  key={p.peerId}
                  participant={p}
                  isMe={isMe}
                  isMuted={p.muted || (isMe && muted)}
                  volume={vol}
                />
              );
            })}
          </div>
        </aside>

        {showMobileList && (
          <div className="md:hidden absolute inset-0 z-40 bg-slate-900/30 backdrop-blur-xs flex flex-col justify-end">
            <div className="bg-white border-t border-slate-200 rounded-t-2xl max-h-[60vh] flex flex-col p-4 shadow-lg">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <span className="font-bold text-sm text-slate-800">
                  Participants ({participants.length})
                </span>
                <button
                  onClick={() => setShowMobileList(false)}
                  className="w-7 h-7 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center font-bold text-xs hover:bg-slate-200"
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto py-2 space-y-1.5">
                {participants.map((p) => {
                  const isMe = p.peerId === myPeerId.current;
                  const vol = isMe ? 1 : (peerVolumes.get(p.peerId) ?? 0);
                  return (
                    <ParticipantRow
                      key={p.peerId}
                      participant={p}
                      isMe={isMe}
                      isMuted={p.muted || (isMe && muted)}
                      volume={vol}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ParticipantRow({
  participant,
  isMe,
  isMuted,
  volume,
}: {
  participant: ParticipantState;
  isMe: boolean;
  isMuted: boolean;
  volume: number;
}) {
  const style = getAvatarStyle(participant.peerId);
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200/60">
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 shadow-xs"
        style={{ background: style.bg, color: style.text }}
      >
        {participant.name[0]?.toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold truncate text-slate-800">
          {participant.name} {isMe && <span className="text-blue-600 font-normal">(you)</span>}
        </div>
        <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
          {isMuted ? (
            <span className="text-red-600">Muted</span>
          ) : isMe ? (
            <span className="text-emerald-600">Broadcasting</span>
          ) : (
            <>
              <span>{Math.round(volume * 100)}%</span>
              <div className="flex-1 max-w-[60px] h-1.5 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded-full"
                  style={{ width: `${Math.round(volume * 100)}%` }}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GridPattern() {
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none opacity-40"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id="dot-grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <circle cx="14" cy="14" r="1" fill="#cbd5e1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dot-grid)" />
    </svg>
  );
}

function HearingRings({ x, y }: { x: number; y: number }) {
  return (
    <>
      <div
        className="absolute rounded-full border border-dashed border-slate-300 pointer-events-none"
        style={{
          left: `${x}%`,
          top: `${y}%`,
          width: `${MAX_HEAR_DISTANCE * 2}%`,
          height: `${MAX_HEAR_DISTANCE * 2}%`,
          transform: "translate(-50%, -50%)",
        }}
      />
      <div
        className="absolute rounded-full border border-blue-400/40 pointer-events-none bg-blue-50/20"
        style={{
          left: `${x}%`,
          top: `${y}%`,
          width: `${MIN_HEAR_DISTANCE * 2}%`,
          height: `${MIN_HEAR_DISTANCE * 2}%`,
          transform: "translate(-50%, -50%)",
        }}
      />
    </>
  );
}

function PlayerAvatar({
  participant,
  isMe,
  volume,
}: {
  participant: ParticipantState;
  isMe: boolean;
  volume: number;
}) {
  const style = getAvatarStyle(participant.peerId);
  const initial = participant.name[0]?.toUpperCase() ?? "?";
  const isSpeaking = volume > 0.05 && !participant.muted;

  return (
    <div
      className="absolute flex flex-col items-center gap-1 pointer-events-none transition-transform duration-75"
      style={{
        left: `${participant.x}%`,
        top: `${participant.y}%`,
        transform: "translate(-50%, -50%)",
        zIndex: isMe ? 25 : 15,
      }}
    >
      {isSpeaking && (
        <div
          className="absolute rounded-full animate-ping opacity-30"
          style={{
            width: AVATAR_RADIUS * 2 + 10,
            height: AVATAR_RADIUS * 2 + 10,
            background: style.bg,
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
          }}
        />
      )}

      <div
        className="rounded-full flex items-center justify-center font-bold text-white shadow-sm transition-all"
        style={{
          width: AVATAR_RADIUS * 2,
          height: AVATAR_RADIUS * 2,
          background: style.bg,
          color: style.text,
          border: isMe ? "3px solid #0f172a" : "2px solid #ffffff",
          fontSize: AVATAR_RADIUS * 0.7,
        }}
      >
        {participant.muted ? <MicOffIcon className="w-3.5 h-3.5 text-white" /> : initial}
      </div>

      <div
        className="rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap shadow-xs border"
        style={{
          background: isMe ? "#0f172a" : "#ffffff",
          color: isMe ? "#ffffff" : "#334155",
          borderColor: isMe ? "#0f172a" : "#e2e8f0",
        }}
      >
        {participant.name}
        {isMe && " (you)"}
      </div>

      {!isMe && (
        <div className="w-10 h-1.5 bg-slate-200 rounded-full overflow-hidden border border-slate-300">
          <div
            className="h-full rounded-full transition-all duration-100"
            style={{
              width: `${Math.round(volume * 100)}%`,
              background: style.bg,
            }}
          />
        </div>
      )}
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3z" />
    </svg>
  );
}

function MicOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function LogOutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  );
}

function VolumeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
    </svg>
  );
}

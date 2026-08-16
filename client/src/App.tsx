import { useEffect, useRef, useState } from "react";
import { createRoom, type ConnectionStatus } from "./connection";
import { CursorInterpolator } from "./interpolation";
import { renderFrame, colorForClientId, type ReactionBurst } from "./render";
import type { ServerMessage } from "./protocol";

const ROOM_ID = "watch-party-42";

// Use the deployed server URL in production builds, localhost in dev.
const WS_URL = import.meta.env.PROD
  ? "wss://multiplayer-sync-assignment.onrender.com"
  : "ws://localhost:8080";

// Adaptive send rate: choose interval based on measured RTT, so we
// don't flood a high-latency connection with updates it can't keep
// up with, but stay responsive on a fast one.
function intervalForRTT(rtt: number | null): number {
  if (rtt === null) return 1000 / 25;       // no data yet, assume good
  if (rtt < 100) return 1000 / 25;          // low latency: 25Hz
  if (rtt < 300) return 1000 / 15;          // medium: 15Hz
  return 1000 / 8;                          // high latency: 8Hz
}

function randomClientId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const roomRef = useRef<ReturnType<typeof createRoom> | null>(null);
  const interpolatorRef = useRef(new CursorInterpolator());
  const bursts = useRef<ReactionBurst[]>([]);
  const seqRef = useRef(0);
  const clientIdRef = useRef(randomClientId());
  const latestPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastSentPosRef = useRef<{ x: number; y: number } | null>(null);

  const [participants, setParticipants] = useState<string[]>([]);
  const [latencies, setLatencies] = useState<Record<string, { rtt: number; jitter: number }>>({});
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");

  // Connection setup: connect, join room, and handle incoming messages.
  useEffect(() => {
    const room = createRoom({
      url: WS_URL,
      clientId: clientIdRef.current,
      roomId: ROOM_ID,
    });
    roomRef.current = room;

    room.onStatusChange(setConnectionStatus);

    room.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case "welcome":
          setParticipants([msg.clientId, ...msg.participants.map((p) => p.clientId)]);
          for (const p of msg.participants) {
            interpolatorRef.current.updateTarget(p.clientId, p.x, p.y);
          }
          break;
        case "presence":
          setParticipants((prev) =>
            msg.status === "join"
              ? [...new Set([...prev, msg.clientId])]
              : prev.filter((id) => id !== msg.clientId)
          );
          if (msg.status === "leave") {
            interpolatorRef.current.remove(msg.clientId);
            setLatencies((prev) => {
              const next = { ...prev };
              delete next[msg.clientId];
              return next;
            });
          }
          break;
        case "cursor":
          interpolatorRef.current.updateTarget(msg.clientId, msg.x, msg.y, msg.seq);
          break;
        case "reaction":
          bursts.current.push({
            x: msg.x,
            y: msg.y,
            emoji: msg.reaction,
            startedAt: performance.now(),
            conflictRank: msg.conflictRank,
          });
          break;
        case "latency":
          setLatencies((prev) => ({
            ...prev,
            [msg.clientId]: { rtt: msg.rtt, jitter: msg.jitter },
          }));
          break;
      }
    });

    return () => room.close();
  }, []);

  // Adaptive-rate send loop: decoupled from mousemove events.
  // Reads whatever the latest stored position is and sends it, but the
  // interval itself is re-evaluated periodically based on measured RTT
  // (see intervalForRTT above) — a slow/high-latency connection gets
  // throttled harder than a fast one, instead of always sending at a
  // fixed 25Hz regardless of network conditions.
  useEffect(() => {
    let currentInterval: ReturnType<typeof setInterval> | null = null;
    let currentMs = -1;

    function tick() {
      const pos = latestPosRef.current;
      if (!pos) return;

      const last = lastSentPosRef.current;
      if (last && last.x === pos.x && last.y === pos.y) return;

      lastSentPosRef.current = pos;
      roomRef.current?.send({
        type: "cursor",
        clientId: clientIdRef.current,
        seq: seqRef.current++,
        x: pos.x,
        y: pos.y,
      });
    }

    function restart() {
      const rtt = roomRef.current?.getRTT() ?? null;
      const targetMs = intervalForRTT(rtt);
      if (targetMs === currentMs) return; // no meaningful change, don't churn the timer
      if (currentInterval) clearInterval(currentInterval);
      currentMs = targetMs;
      currentInterval = setInterval(tick, targetMs);
    }

    restart();
    const watcher = setInterval(restart, 1000); // re-check RTT once a second

    return () => {
      if (currentInterval) clearInterval(currentInterval);
      clearInterval(watcher);
    };
  }, []);

  // Render loop: reads interpolated positions every animation frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf: number;
    function loop() {
      const positions = interpolatorRef.current.getInterpolatedPositions();
      const toRender = positions.map((p) => ({
        clientId: p.clientId,
        x: p.x,
        y: p.y,
        color: colorForClientId(p.clientId),
      }));
      renderFrame(ctx!, canvas!.width, canvas!.height, toRender, bursts.current);
      raf = requestAnimationFrame(loop);
    }
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Just store the latest position — cheap, no network call here.
    latestPosRef.current = { x, y };
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    roomRef.current?.send({
      type: "reaction",
      clientId: clientIdRef.current,
      seq: seqRef.current++,
      x,
      y,
      reaction: "🔥",
    });
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto", padding: 24, boxSizing: "border-box" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Multiplayer Sync Demo</h1>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16, fontSize: 14 }}>
        {connectionStatus === "connecting" && (
          <>
            <span style={{ color: "#eab308" }}>●</span>
            <span>Connecting...</span>
          </>
        )}
        {connectionStatus === "connected" && (
          <>
            <span style={{ color: "#22c55e" }}>●</span>
            <span>{participants.length} user{participants.length !== 1 ? "s" : ""} online</span>
          </>
        )}
        {connectionStatus === "disconnected" && (
          <>
            <span style={{ color: "#ef4444" }}>●</span>
            <span>Disconnected, reconnecting...</span>
          </>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
        <canvas
          ref={canvasRef}
          width={700}
          height={450}
          style={{ border: "1px solid #333", cursor: "crosshair", borderRadius: 4, maxWidth: "100%" }}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
        />

        <div style={{ minWidth: 160 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "#666" }}>Users</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {participants.map((id) => {
              const lat = latencies[id];
              return (
                <li key={id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ color: colorForClientId(id) }}>●</span>
                  <span>{id === clientIdRef.current ? `${id} (you)` : id}</span>
                  {lat && (
                    <span style={{ color: "#999", fontSize: 11, marginLeft: "auto" }}>
                      {lat.rtt}ms ±{lat.jitter}ms
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <p style={{ marginTop: 16, fontSize: 13, color: "#888" }}>
        Move mouse to broadcast cursor, click to send a reaction.
      </p>
    </div>
  );
}
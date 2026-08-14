import { useEffect, useRef, useState } from "react";
import { createRoom } from "./connection";
import { CursorInterpolator } from "./interpolation";
import { renderFrame, colorForClientId, type ReactionBurst } from "./render";
import type { ServerMessage } from "./protocol";

const ROOM_ID = "watch-party-42";

// Use the deployed server URL in production builds, localhost in dev.
const WS_URL = import.meta.env.PROD
  ? "wss://multiplayer-sync-assignment.onrender.com"
  : "ws://localhost:8080";

const CURSOR_SEND_HZ = 25; // throttle outgoing cursor updates
const SEND_INTERVAL_MS = 1000 / CURSOR_SEND_HZ;

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

  // Connection setup: connect, join room, and handle incoming messages.
  useEffect(() => {
    const room = createRoom({
      url: WS_URL,
      clientId: clientIdRef.current,
      roomId: ROOM_ID,
    });
    roomRef.current = room;

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
          if (msg.status === "leave") interpolatorRef.current.remove(msg.clientId);
          break;
        case "cursor":
          interpolatorRef.current.updateTarget(msg.clientId, msg.x, msg.y, msg.seq);
          break;
        case "reaction":
          bursts.current.push({ x: msg.x, y: msg.y, emoji: msg.reaction, startedAt: performance.now() });
          break;
      }
    });

    return () => room.close();
  }, []);

  // Fixed-rate send loop: decoupled from mousemove events.
  // Reads whatever the latest stored position is and sends it at a
  // controlled interval (25Hz), skipping the send if unchanged since
  // the last tick. This guarantees a predictable, bounded send rate
  // regardless of how fast mousemove actually fires (60-120Hz raw).
  useEffect(() => {
    const interval = setInterval(() => {
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
    }, SEND_INTERVAL_MS);

    return () => clearInterval(interval);
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
        <span style={{ color: "#22c55e" }}>●</span>
        <span>{participants.length} user{participants.length !== 1 ? "s" : ""} online</span>
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
            {participants.map((id) => (
              <li key={id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span style={{ color: colorForClientId(id) }}>●</span>
                <span>{id === clientIdRef.current ? `${id} (you)` : id}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p style={{ marginTop: 16, fontSize: 13, color: "#888" }}>
        Move mouse to broadcast cursor, click to send a reaction.
      </p>
    </div>
  );
}
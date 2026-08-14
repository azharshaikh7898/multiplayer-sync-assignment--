export interface CursorToRender {
  clientId: string;
  x: number;
  y: number;
  color: string;
}

export interface ReactionBurst {
  x: number;
  y: number;
  emoji: string;
  startedAt: number;
}

const BURST_DURATION_MS = 800;

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cursors: CursorToRender[],
  bursts: ReactionBurst[]
): void {
  ctx.clearRect(0, 0, width, height);

  for (const c of cursors) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();

    ctx.font = "12px sans-serif";
    ctx.fillText(c.clientId, c.x + 12, c.y - 12);
  }

  const now = performance.now();
  for (const b of bursts) {
    const age = now - b.startedAt;
    if (age > BURST_DURATION_MS) continue;
    const progress = age / BURST_DURATION_MS;
    ctx.globalAlpha = 1 - progress;
    ctx.font = `${24 + progress * 20}px sans-serif`;
    ctx.fillText(b.emoji, b.x, b.y - progress * 40);
    ctx.globalAlpha = 1;
  }
}

export function colorForClientId(clientId: string): string {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = clientId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${hash % 360}, 70%, 50%)`;
}
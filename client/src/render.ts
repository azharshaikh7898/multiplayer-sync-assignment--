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
  conflictRank?: number; // NEW
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

    // If this burst conflicted with another, offset it slightly so both
    // are visible instead of perfectly overlapping, and grow it a touch —
    // every client receives the same conflictRank from the server, so
    // this offset is identical everywhere, keeping state consistent.
    const rank = b.conflictRank ?? 0;
    const offsetX = rank * 14;
    const sizeBoost = rank > 0 ? 6 : 0;

    ctx.globalAlpha = 1 - progress;
    ctx.font = `${24 + sizeBoost + progress * 20}px sans-serif`;
    ctx.fillText(b.emoji, b.x + offsetX, b.y - progress * 40);
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
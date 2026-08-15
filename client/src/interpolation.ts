export interface RemoteCursorState {
  clientId: string;
  prevX: number;
  prevY: number;
  prevT: number;
  targetX: number;
  targetY: number;
  targetT: number;
  lastSeq: number;
  vx: number; // px/ms, computed from prev -> target
  vy: number;
}

const INTERP_DELAY_MS = 100;

// Cap how long we'll keep extrapolating past the last known point before
// freezing. Without this, a cursor that stops sending updates (e.g. the
// sender's tab froze, or a long network gap) would drift indefinitely in
// a straight line, which looks worse than just stopping.
const MAX_EXTRAPOLATION_MS = 250;

export class CursorInterpolator {
  private cursors = new Map<string, RemoteCursorState>();

  updateTarget(clientId: string, x: number, y: number, seq?: number): void {
    const now = performance.now();
    const existing = this.cursors.get(clientId);

    if (!existing) {
      this.cursors.set(clientId, {
        clientId,
        prevX: x,
        prevY: y,
        prevT: now,
        targetX: x,
        targetY: y,
        targetT: now,
        lastSeq: seq ?? -1,
        vx: 0,
        vy: 0,
      });
      return;
    }

    if (seq !== undefined && seq <= existing.lastSeq) {
      return;
    }

    const dt = now - existing.targetT;
    // Velocity from the previous target to this new point. Guard against
    // dt === 0 (two updates in the same tick) to avoid dividing by zero.
    const vx = dt > 0 ? (x - existing.targetX) / dt : 0;
    const vy = dt > 0 ? (y - existing.targetY) / dt : 0;

    this.cursors.set(clientId, {
      clientId,
      prevX: existing.targetX,
      prevY: existing.targetY,
      prevT: existing.targetT,
      targetX: x,
      targetY: y,
      targetT: now,
      lastSeq: seq ?? existing.lastSeq,
      vx,
      vy,
    });
  }

  remove(clientId: string): void {
    this.cursors.delete(clientId);
  }

  getInterpolatedPositions(): { clientId: string; x: number; y: number }[] {
    const renderTime = performance.now() - INTERP_DELAY_MS;
    const results: { clientId: string; x: number; y: number }[] = [];

    for (const c of this.cursors.values()) {
      if (renderTime <= c.targetT) {
        // Normal case: we're rendering between two known real points.
        const span = c.targetT - c.prevT;
        const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (renderTime - c.prevT) / span));
        results.push({
          clientId: c.clientId,
          x: c.prevX + (c.targetX - c.prevX) * t,
          y: c.prevY + (c.targetY - c.prevY) * t,
        });
      } else {
        // No fresh update has arrived in time — extrapolate forward from
        // the last known point using its velocity, capped so we never
        // drift too far from the last confirmed position.
        const elapsed = Math.min(renderTime - c.targetT, MAX_EXTRAPOLATION_MS);
        results.push({
          clientId: c.clientId,
          x: c.targetX + c.vx * elapsed,
          y: c.targetY + c.vy * elapsed,
        });
      }
    }
    return results;
  }
}
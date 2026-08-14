export interface RemoteCursorState {
  clientId: string;
  prevX: number;
  prevY: number;
  prevT: number;
  targetX: number;
  targetY: number;
  targetT: number;
  lastSeq: number; // NEW: tracks the highest seq accepted for this client
}

const INTERP_DELAY_MS = 100;

export class CursorInterpolator {
  private cursors = new Map<string, RemoteCursorState>();

  // seq is optional to keep the "first sighting via welcome snapshot" path
  // (which has no seq) working unchanged.
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
      });
      return;
    }

    // Ordering guard: discard updates that arrive out of order.
    // We only ever compare against the highest seq seen so far for
    // this specific client, so a late/reordered older update can
    // never overwrite a newer one already rendered.
    if (seq !== undefined && seq <= existing.lastSeq) {
      return;
    }

    this.cursors.set(clientId, {
      clientId,
      prevX: existing.targetX,
      prevY: existing.targetY,
      prevT: existing.targetT,
      targetX: x,
      targetY: y,
      targetT: now,
      lastSeq: seq ?? existing.lastSeq,
    });
  }

  remove(clientId: string): void {
    this.cursors.delete(clientId);
  }

  getInterpolatedPositions(): { clientId: string; x: number; y: number }[] {
    const now = performance.now() - INTERP_DELAY_MS;
    const results: { clientId: string; x: number; y: number }[] = [];

    for (const c of this.cursors.values()) {
      const span = c.targetT - c.prevT;
      const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - c.prevT) / span));
      results.push({
        clientId: c.clientId,
        x: c.prevX + (c.targetX - c.prevX) * t,
        y: c.prevY + (c.targetY - c.prevY) * t,
      });
    }
    return results;
  }
}
import type { FastifyReply } from "fastify";
import type { SpectatorEvent } from "./types.js";

// ---------------------------------------------------------------------------
// SpectatorFeed — SSE connection manager
// ---------------------------------------------------------------------------

export class SpectatorFeed {
  private connections: Map<string, Set<FastifyReply>> = new Map();

  /** Register a spectator SSE connection for an arena. */
  addConnection(arenaId: string, reply: FastifyReply): void {
    let set = this.connections.get(arenaId);
    if (!set) {
      set = new Set();
      this.connections.set(arenaId, set);
    }
    set.add(reply);
  }

  /** Remove a spectator connection (called on client disconnect). */
  removeConnection(arenaId: string, reply: FastifyReply): void {
    const set = this.connections.get(arenaId);
    if (!set) return;
    set.delete(reply);
    if (set.size === 0) {
      this.connections.delete(arenaId);
    }
  }

  /**
   * Broadcast a SpectatorEvent to every spectator watching an arena.
   *
   * SSE format per spec:
   *   event: <name>\n
   *   data: <json>\n
   *   \n
   */
  broadcast(arenaId: string, event: SpectatorEvent): void {
    const set = this.connections.get(arenaId);
    if (!set || set.size === 0) return;

    const payload =
      `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

    for (const reply of set) {
      try {
        reply.raw.write(payload);
      } catch {
        // Connection already closed — remove silently
        set.delete(reply);
      }
    }

    // Clean up empty sets
    if (set.size === 0) {
      this.connections.delete(arenaId);
    }
  }

  /** How many spectators are watching an arena. */
  getSpectatorCount(arenaId: string): number {
    return this.connections.get(arenaId)?.size ?? 0;
  }
}

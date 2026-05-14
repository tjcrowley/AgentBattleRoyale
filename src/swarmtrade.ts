// AI Survivor -- SwarmTrade integration module
// Thin HTTP client for SwarmTrade reputation API.
// Graceful degradation: all methods return null/void if SwarmTrade is unreachable.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SWARMTRADE_URL =
  process.env.SWARMTRADE_URL || "https://swarmtrade.store";

const REQUEST_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwarmTradeReputation {
  trust_score: number;
  total_trades: number;
}

export interface SwarmTradeProfile {
  trust_score: number;
  total_trades: number;
  avg_rating: number | null;
}

// ---------------------------------------------------------------------------
// SwarmTradeIntegration
// ---------------------------------------------------------------------------

export class SwarmTradeIntegration {
  private readonly baseUrl: string;
  private readonly agentId: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? SWARMTRADE_URL;
    this.agentId = "ai-survivor-platform";
  }

  /** The SwarmTrade base URL this instance is configured to use. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  // -----------------------------------------------------------------------
  // getAgentReputation
  // -----------------------------------------------------------------------

  /**
   * Fetch an agent's SwarmTrade reputation.
   * Returns null if SwarmTrade is unreachable (graceful degradation).
   */
  async getAgentReputation(
    agentId: string,
  ): Promise<SwarmTradeReputation | null> {
    try {
      const res = await this.fetch(
        `/registry/reputation/${encodeURIComponent(agentId)}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      return {
        trust_score: Number(data.trust_score ?? 0),
        total_trades: Number(data.total_trades ?? 0),
      };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // getAgentProfile
  // -----------------------------------------------------------------------

  /**
   * Same as getAgentReputation but returns more fields.
   * Used for the spectator UI.
   */
  async getAgentProfile(agentId: string): Promise<SwarmTradeProfile | null> {
    try {
      const res = await this.fetch(
        `/registry/reputation/${encodeURIComponent(agentId)}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      return {
        trust_score: Number(data.trust_score ?? 0),
        total_trades: Number(data.total_trades ?? 0),
        avg_rating:
          data.avg_rating != null ? Number(data.avg_rating) : null,
      };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // reportArenaResult
  // -----------------------------------------------------------------------

  /**
   * After an arena completes, report the result to SwarmTrade.
   * Records a 5-star rating for the winner from the platform agent.
   * Fire-and-forget -- logs errors but never throws.
   */
  async reportArenaResult(
    winnerId: string,
    _eliminatedIds: string[],
  ): Promise<void> {
    try {
      const tradeId = `arena-result-${winnerId}-${Date.now()}`;
      await this.fetch("/registry/reputation/rate", {
        method: "POST",
        body: JSON.stringify({
          trade_id: tradeId,
          rater_id: this.agentId,
          ratee_id: winnerId,
          rating: 5,
          comment: "AI Survivor arena winner",
        }),
      });
    } catch (err) {
      console.warn(
        `[SwarmTrade] Failed to report arena result for ${winnerId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private fetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    return globalThis.fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-agent-id": this.agentId,
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}

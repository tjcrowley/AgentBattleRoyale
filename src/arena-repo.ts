import type { Pool, QueryResultRow } from "pg";
import type {
  Arena,
  ArenaConfig,
  ArenaMessage,
  ArenaPayout,
  ArenaPlayer,
  ArenaStatus,
  ArenaVote,
  CastVoteParams,
  CreateArenaParams,
  JoinArenaParams,
  PayoutStatus,
  PayoutType,
  PlayerStatus,
  SendMessageParams,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

/** Map a pg row (snake_case) to our TS interface (also snake_case here). */
function mapArena(row: QueryResultRow): Arena {
  return {
    id: row.id,
    status: row.status,
    entry_fee_wei: String(row.entry_fee_wei),
    chain_id: row.chain_id,
    token_address: row.token_address ?? null,
    prize_pool_wei: String(row.prize_pool_wei),
    rake_bps: Number(row.rake_bps),
    max_players: Number(row.max_players),
    current_round: Number(row.current_round),
    current_phase: row.current_phase,
    phase_ends_at: row.phase_ends_at ? new Date(row.phase_ends_at).toISOString() : null,
    winner_id: row.winner_id ?? null,
    config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
    scheduled_at: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

function mapPlayer(row: QueryResultRow): ArenaPlayer {
  return {
    arena_id: row.arena_id,
    agent_id: row.agent_id,
    display_name: row.display_name,
    deposit_tx_hash: row.deposit_tx_hash ?? null,
    status: row.status,
    eliminated_round: row.eliminated_round != null ? Number(row.eliminated_round) : null,
    vote_count: Number(row.vote_count),
    joined_at: new Date(row.joined_at).toISOString(),
  };
}

function mapMessage(row: QueryResultRow): ArenaMessage {
  return {
    id: Number(row.id),
    arena_id: row.arena_id,
    round: Number(row.round),
    sender_id: row.sender_id,
    recipient_id: row.recipient_id ?? null,
    content: row.content,
    revealed: Boolean(row.revealed),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function mapVote(row: QueryResultRow): ArenaVote {
  return {
    arena_id: row.arena_id,
    round: Number(row.round),
    voter_id: row.voter_id,
    target_id: row.target_id,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function mapPayout(row: QueryResultRow): ArenaPayout {
  return {
    id: Number(row.id),
    arena_id: row.arena_id,
    agent_id: row.agent_id,
    amount_wei: String(row.amount_wei),
    type: row.type,
    tx_hash: row.tx_hash ?? null,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    confirmed_at: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// ArenaRepo
// ---------------------------------------------------------------------------

export class ArenaRepo {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Arena CRUD
  // -------------------------------------------------------------------------

  async createArena(params: CreateArenaParams): Promise<Arena> {
    const config: ArenaConfig = {
      ...DEFAULT_CONFIG,
      ...(params.config ?? {}),
    };
    const { rows } = await this.pool.query(
      `INSERT INTO arenas (entry_fee_wei, chain_id, max_players, rake_bps, scheduled_at, config)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        params.entry_fee_wei,
        params.chain_id ?? "8453",
        params.max_players ?? 8,
        params.rake_bps ?? 1000,
        params.scheduled_at ?? null,
        JSON.stringify(config),
      ],
    );
    return mapArena(rows[0]);
  }

  async getArena(id: string): Promise<Arena | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM arenas WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? mapArena(rows[0]) : null;
  }

  async listArenas(filter?: { status?: ArenaStatus | ArenaStatus[] }): Promise<Arena[]> {
    if (!filter?.status) {
      const { rows } = await this.pool.query(
        `SELECT * FROM arenas ORDER BY created_at DESC`,
      );
      return rows.map(mapArena);
    }

    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    const placeholders = statuses.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.pool.query(
      `SELECT * FROM arenas WHERE status IN (${placeholders}) ORDER BY created_at DESC`,
      statuses,
    );
    return rows.map(mapArena);
  }

  async updateArena(
    id: string,
    updates: Partial<
      Pick<
        Arena,
        | "status"
        | "current_round"
        | "current_phase"
        | "phase_ends_at"
        | "winner_id"
        | "prize_pool_wei"
        | "started_at"
        | "completed_at"
      >
    >,
  ): Promise<Arena> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        setClauses.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      const arena = await this.getArena(id);
      if (!arena) throw new Error(`Arena ${id} not found`);
      return arena;
    }

    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE arenas SET ${setClauses.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values,
    );
    if (rows.length === 0) throw new Error(`Arena ${id} not found`);
    return mapArena(rows[0]);
  }

  async getRunningArenasNeedingAdvance(): Promise<Arena[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM arenas WHERE status = 'running' AND phase_ends_at <= now()`,
    );
    return rows.map(mapArena);
  }

  // -------------------------------------------------------------------------
  // Player Operations
  // -------------------------------------------------------------------------

  async addPlayer(arenaId: string, params: JoinArenaParams): Promise<ArenaPlayer> {
    // Insert player and bump prize pool in a single transaction-safe block.
    // The caller can wrap in a transaction if needed; here we use two queries
    // because Pool.query auto-commits each statement.
    const { rows } = await this.pool.query(
      `INSERT INTO arena_players (arena_id, agent_id, display_name, deposit_tx_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [arenaId, params.agent_id, params.display_name, params.deposit_tx_hash ?? null],
    );

    // Add entry fee to prize pool
    await this.pool.query(
      `UPDATE arenas SET prize_pool_wei = prize_pool_wei + (
         SELECT entry_fee_wei FROM arenas WHERE id = $1
       ) WHERE id = $1`,
      [arenaId],
    );

    return mapPlayer(rows[0]);
  }

  async getPlayers(arenaId: string): Promise<ArenaPlayer[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM arena_players WHERE arena_id = $1 ORDER BY joined_at ASC`,
      [arenaId],
    );
    return rows.map(mapPlayer);
  }

  async getActivePlayers(arenaId: string): Promise<ArenaPlayer[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM arena_players WHERE arena_id = $1 AND status IN ('registered', 'active')
       ORDER BY joined_at ASC`,
      [arenaId],
    );
    return rows.map(mapPlayer);
  }

  async getPlayerCount(arenaId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM arena_players WHERE arena_id = $1`,
      [arenaId],
    );
    return Number(rows[0].count);
  }

  async updatePlayerStatus(
    arenaId: string,
    agentId: string,
    status: PlayerStatus,
    eliminatedRound?: number,
  ): Promise<void> {
    if (eliminatedRound != null) {
      await this.pool.query(
        `UPDATE arena_players SET status = $1, eliminated_round = $2
         WHERE arena_id = $3 AND agent_id = $4`,
        [status, eliminatedRound, arenaId, agentId],
      );
    } else {
      await this.pool.query(
        `UPDATE arena_players SET status = $1 WHERE arena_id = $2 AND agent_id = $3`,
        [status, arenaId, agentId],
      );
    }
  }

  async activateAllPlayers(arenaId: string): Promise<void> {
    await this.pool.query(
      `UPDATE arena_players SET status = 'active' WHERE arena_id = $1 AND status = 'registered'`,
      [arenaId],
    );
  }

  // -------------------------------------------------------------------------
  // Message Operations
  // -------------------------------------------------------------------------

  async addMessage(
    arenaId: string,
    round: number,
    params: SendMessageParams,
  ): Promise<ArenaMessage> {
    const { rows } = await this.pool.query(
      `INSERT INTO arena_messages (arena_id, round, sender_id, recipient_id, content)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [arenaId, round, params.agent_id, params.recipient_id ?? null, params.content],
    );
    return mapMessage(rows[0]);
  }

  async getMessages(
    arenaId: string,
    opts?: {
      round?: number;
      senderId?: string;
      recipientId?: string;
      publicOnly?: boolean;
    },
  ): Promise<ArenaMessage[]> {
    const conditions: string[] = ["arena_id = $1"];
    const values: unknown[] = [arenaId];
    let paramIndex = 2;

    if (opts?.round != null) {
      conditions.push(`round = $${paramIndex++}`);
      values.push(opts.round);
    }
    if (opts?.senderId) {
      conditions.push(`sender_id = $${paramIndex++}`);
      values.push(opts.senderId);
    }
    if (opts?.recipientId) {
      conditions.push(`recipient_id = $${paramIndex++}`);
      values.push(opts.recipientId);
    }
    if (opts?.publicOnly) {
      conditions.push(`recipient_id IS NULL`);
    }

    const { rows } = await this.pool.query(
      `SELECT * FROM arena_messages WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`,
      values,
    );
    return rows.map(mapMessage);
  }

  async getAgentMessages(arenaId: string, agentId: string): Promise<ArenaMessage[]> {
    // Public messages + DMs where the agent is sender or recipient
    const { rows } = await this.pool.query(
      `SELECT * FROM arena_messages
       WHERE arena_id = $1
         AND (recipient_id IS NULL OR sender_id = $2 OR recipient_id = $2)
       ORDER BY created_at ASC`,
      [arenaId, agentId],
    );
    return rows.map(mapMessage);
  }

  async getMessageCountForPhase(
    arenaId: string,
    round: number,
    agentId: string,
  ): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM arena_messages
       WHERE arena_id = $1 AND round = $2 AND sender_id = $3`,
      [arenaId, round, agentId],
    );
    return Number(rows[0].count);
  }

  async revealDMs(arenaId: string, agentId: string): Promise<ArenaMessage[]> {
    const { rows } = await this.pool.query(
      `UPDATE arena_messages SET revealed = true
       WHERE arena_id = $1 AND sender_id = $2 AND recipient_id IS NOT NULL
       RETURNING *`,
      [arenaId, agentId],
    );
    return rows.map(mapMessage);
  }

  async getTotalMessageCount(arenaId: string, agentId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM arena_messages
       WHERE arena_id = $1 AND sender_id = $2`,
      [arenaId, agentId],
    );
    return Number(rows[0].count);
  }

  // -------------------------------------------------------------------------
  // Vote Operations
  // -------------------------------------------------------------------------

  async castVote(
    arenaId: string,
    round: number,
    params: CastVoteParams,
  ): Promise<ArenaVote> {
    const { rows } = await this.pool.query(
      `INSERT INTO arena_votes (arena_id, round, voter_id, target_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [arenaId, round, params.agent_id, params.target_id],
    );
    return mapVote(rows[0]);
  }

  async getVotes(arenaId: string, round: number): Promise<ArenaVote[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM arena_votes WHERE arena_id = $1 AND round = $2
       ORDER BY created_at ASC`,
      [arenaId, round],
    );
    return rows.map(mapVote);
  }

  async hasVoted(arenaId: string, round: number, agentId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM arena_votes WHERE arena_id = $1 AND round = $2 AND voter_id = $3`,
      [arenaId, round, agentId],
    );
    return rows.length > 0;
  }

  async getVoteHistory(arenaId: string): Promise<Record<number, ArenaVote[]>> {
    const { rows } = await this.pool.query(
      `SELECT * FROM arena_votes WHERE arena_id = $1 ORDER BY round ASC, created_at ASC`,
      [arenaId],
    );
    const history: Record<number, ArenaVote[]> = {};
    for (const row of rows) {
      const vote = mapVote(row);
      if (!history[vote.round]) history[vote.round] = [];
      history[vote.round].push(vote);
    }
    return history;
  }

  // -------------------------------------------------------------------------
  // Payout Operations
  // -------------------------------------------------------------------------

  async getPayouts(arenaId: string): Promise<ArenaPayout[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM arena_payouts WHERE arena_id = $1 ORDER BY created_at ASC`,
      [arenaId],
    );
    return rows.map(mapPayout);
  }

  async createPayout(
    arenaId: string,
    agentId: string,
    amountWei: string,
    type: PayoutType,
  ): Promise<ArenaPayout> {
    const { rows } = await this.pool.query(
      `INSERT INTO arena_payouts (arena_id, agent_id, amount_wei, type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [arenaId, agentId, amountWei, type],
    );
    return mapPayout(rows[0]);
  }

  async updatePayoutStatus(
    id: number,
    status: PayoutStatus,
    txHash?: string,
  ): Promise<void> {
    if (txHash) {
      await this.pool.query(
        `UPDATE arena_payouts SET status = $1, tx_hash = $2,
         confirmed_at = CASE WHEN $1 = 'confirmed' THEN now() ELSE confirmed_at END
         WHERE id = $3`,
        [status, txHash, id],
      );
    } else {
      await this.pool.query(
        `UPDATE arena_payouts SET status = $1,
         confirmed_at = CASE WHEN $1 = 'confirmed' THEN now() ELSE confirmed_at END
         WHERE id = $2`,
        [status, id],
      );
    }
  }
}

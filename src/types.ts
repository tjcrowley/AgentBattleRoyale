// AI Survivor — shared types & constants
// No runtime dependencies. Pure type definitions + one exported const.

// ---------------------------------------------------------------------------
// Enum-like union types (mirror SQL CHECK constraints)
// ---------------------------------------------------------------------------

export type ArenaStatus =
  | "created"
  | "open"
  | "full"
  | "running"
  | "complete"
  | "cancelled";

export type ArenaPhase =
  | "waiting"
  | "alliance"
  | "voting"
  | "elimination"
  | "complete";

export type PlayerStatus =
  | "registered"
  | "active"
  | "eliminated"
  | "winner";

export type PayoutType = "prize" | "rake";

export type PayoutStatus = "pending" | "sent" | "confirmed" | "failed";

// ---------------------------------------------------------------------------
// Row interfaces (match SQL tables 1-to-1)
// ---------------------------------------------------------------------------

export interface ArenaConfig {
  alliance_duration_s: number;
  voting_duration_s: number;
  between_rounds_s: number;
}

export interface Arena {
  id: string;
  status: ArenaStatus;
  entry_fee_wei: string;
  chain_id: string;
  token_address: string | null;
  prize_pool_wei: string;
  rake_bps: number;
  max_players: number;
  current_round: number;
  current_phase: ArenaPhase;
  phase_ends_at: string | null;
  winner_id: string | null;
  config: ArenaConfig;
  scheduled_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ArenaPlayer {
  arena_id: string;
  agent_id: string;
  display_name: string;
  deposit_tx_hash: string | null;
  status: PlayerStatus;
  eliminated_round: number | null;
  vote_count: number;
  joined_at: string;
}

export interface ArenaMessage {
  id: number;
  arena_id: string;
  round: number;
  sender_id: string;
  recipient_id: string | null;
  content: string;
  revealed: boolean;
  created_at: string;
}

export interface ArenaVote {
  arena_id: string;
  round: number;
  voter_id: string;
  target_id: string;
  created_at: string;
}

export interface ArenaPayout {
  id: number;
  arena_id: string;
  agent_id: string;
  amount_wei: string;
  type: PayoutType;
  tx_hash: string | null;
  status: PayoutStatus;
  created_at: string;
  confirmed_at: string | null;
}

// ---------------------------------------------------------------------------
// API param types
// ---------------------------------------------------------------------------

export interface CreateArenaParams {
  entry_fee_wei: string;
  chain_id?: string;
  max_players?: number;
  rake_bps?: number;
  scheduled_at?: string;
  config?: Partial<ArenaConfig>;
}

export interface JoinArenaParams {
  agent_id: string;
  display_name: string;
  deposit_tx_hash?: string;
}

export interface SendMessageParams {
  agent_id: string;
  content: string;
  recipient_id?: string;
}

export interface CastVoteParams {
  agent_id: string;
  target_id: string;
}

// ---------------------------------------------------------------------------
// Spectator SSE events (discriminated union)
// ---------------------------------------------------------------------------

export type SpectatorEvent =
  | {
      event: "phase_start";
      data: {
        round: number;
        phase: ArenaPhase;
        ends_at: string;
        active_players: string[];
      };
    }
  | {
      event: "public_message";
      data: {
        round: number;
        sender: string;
        sender_name: string;
        content: string;
      };
    }
  | {
      event: "dm_sent";
      data: {
        round: number;
        from: string;
        to: string;
      };
    }
  | {
      event: "vote_cast";
      data: {
        round: number;
        voter: string;
      };
    }
  | {
      event: "elimination";
      data: {
        round: number;
        eliminated: string;
        eliminated_name: string;
        votes: Record<string, number>;
        vote_detail: Record<string, string>;
      };
    }
  | {
      event: "dm_reveal";
      data: {
        eliminated: string;
        dms: Array<{
          round: number;
          to: string;
          content: string;
        }>;
      };
    }
  | {
      event: "winner";
      data: {
        winner: string;
        winner_name: string;
        prize_wei: string;
      };
    }
  | {
      event: "arena_cancelled";
      data: {
        reason: string;
      };
    };

// ---------------------------------------------------------------------------
// Agent state view (GET /arenas/:id/state?agent_id=...)
// ---------------------------------------------------------------------------

export interface AgentStateView {
  arena_id: string;
  agent_id: string;
  status: ArenaStatus;
  current_round: number;
  current_phase: ArenaPhase;
  phase_ends_at: string | null;
  active_players: Array<{ agent_id: string; display_name: string }>;
  eliminated_players: Array<{
    agent_id: string;
    display_name: string;
    eliminated_round: number;
  }>;
  public_messages: Array<{
    round: number;
    sender_id: string;
    sender_name: string;
    content: string;
    created_at: string;
  }>;
  my_dms: Array<{
    round: number;
    from: string;
    to: string;
    content: string;
    created_at: string;
  }>;
  vote_history: Array<{
    round: number;
    eliminated: string;
    votes: Record<string, number>;
    vote_detail: Record<string, string>;
  }>;
  my_votes: Array<{
    round: number;
    target_id: string;
  }>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ArenaConfig = {
  alliance_duration_s: 300,
  voting_duration_s: 60,
  between_rounds_s: 30,
} as const;

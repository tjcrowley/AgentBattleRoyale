import type { ArenaRepo } from "./arena-repo.js";
import type { ArenaEscrow } from "./escrow.js";
import type { SwarmTradeIntegration } from "./swarmtrade.js";
import type {
  Arena,
  ArenaPhase,
  ArenaPlayer,
  ArenaVote,
  SpectatorEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BroadcastFn = (arenaId: string, event: SpectatorEvent) => void;

// ---------------------------------------------------------------------------
// Deterministic hash (djb2)
// ---------------------------------------------------------------------------

/**
 * djb2 string hash — deterministic, fast, not cryptographic.
 * Returns a non-negative 32-bit integer.
 */
export function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + char
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Force non-negative by masking to unsigned 32-bit
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// GameEngine
// ---------------------------------------------------------------------------

export class GameEngine {
  private readonly escrow?: ArenaEscrow;
  private readonly swarmtrade?: SwarmTradeIntegration;

  constructor(
    private readonly repo: ArenaRepo,
    private readonly broadcast: BroadcastFn,
    escrow?: ArenaEscrow,
    swarmtrade?: SwarmTradeIntegration,
  ) {
    this.escrow = escrow;
    this.swarmtrade = swarmtrade;
  }

  // -----------------------------------------------------------------------
  // startArena — transitions a 'full' arena into round 1 alliance phase
  // -----------------------------------------------------------------------

  async startArena(arenaId: string): Promise<void> {
    const arena = await this.repo.getArena(arenaId);
    if (!arena) throw new Error(`Arena ${arenaId} not found`);
    if (arena.status !== "full") {
      throw new Error(`Arena ${arenaId} is '${arena.status}', expected 'full'`);
    }

    // Activate all registered players
    await this.repo.activateAllPlayers(arenaId);

    const now = new Date();
    const phaseEndsAt = new Date(
      now.getTime() + arena.config.alliance_duration_s * 1000,
    );

    await this.repo.updateArena(arenaId, {
      status: "running",
      current_round: 1,
      current_phase: "alliance",
      phase_ends_at: phaseEndsAt.toISOString(),
      started_at: now.toISOString(),
    });

    const activePlayers = await this.repo.getActivePlayers(arenaId);

    this.broadcast(arenaId, {
      event: "phase_start",
      data: {
        round: 1,
        phase: "alliance",
        ends_at: phaseEndsAt.toISOString(),
        active_players: activePlayers.map((p) => p.agent_id),
      },
    });
  }

  // -----------------------------------------------------------------------
  // advancePhase — the core state machine
  // -----------------------------------------------------------------------

  async advancePhase(arena: Arena): Promise<void> {
    switch (arena.current_phase) {
      case "alliance":
        await this.transitionToVoting(arena);
        break;
      case "voting":
        await this.transitionToElimination(arena);
        break;
      case "elimination":
        await this.transitionAfterElimination(arena);
        break;
      default:
        // 'waiting' and 'complete' are not advanceable
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Phase transitions
  // -----------------------------------------------------------------------

  private async transitionToVoting(arena: Arena): Promise<void> {
    const now = new Date();
    const phaseEndsAt = new Date(
      now.getTime() + arena.config.voting_duration_s * 1000,
    );

    await this.repo.updateArena(arena.id, {
      current_phase: "voting",
      phase_ends_at: phaseEndsAt.toISOString(),
    });

    const activePlayers = await this.repo.getActivePlayers(arena.id);

    this.broadcast(arena.id, {
      event: "phase_start",
      data: {
        round: arena.current_round,
        phase: "voting",
        ends_at: phaseEndsAt.toISOString(),
        active_players: activePlayers.map((p) => p.agent_id),
      },
    });
  }

  private async transitionToElimination(arena: Arena): Promise<void> {
    // Auto-assign votes for non-voters before tallying
    await this.assignRandomVotes(arena);

    await this.repo.updateArena(arena.id, {
      current_phase: "elimination",
      phase_ends_at: null,
    });

    await this.processElimination(arena);
  }

  private async transitionAfterElimination(arena: Arena): Promise<void> {
    const activePlayers = await this.repo.getActivePlayers(arena.id);

    if (activePlayers.length <= 1) {
      await this.declareWinner(arena);
      return;
    }

    // Continue to next round
    const nextRound = arena.current_round + 1;
    const now = new Date();
    const phaseEndsAt = new Date(
      now.getTime() +
        (arena.config.between_rounds_s + arena.config.alliance_duration_s) *
          1000,
    );

    await this.repo.updateArena(arena.id, {
      current_round: nextRound,
      current_phase: "alliance",
      phase_ends_at: phaseEndsAt.toISOString(),
    });

    this.broadcast(arena.id, {
      event: "phase_start",
      data: {
        round: nextRound,
        phase: "alliance",
        ends_at: phaseEndsAt.toISOString(),
        active_players: activePlayers.map((p) => p.agent_id),
      },
    });
  }

  // -----------------------------------------------------------------------
  // processElimination — tally votes, eliminate, reveal DMs
  // -----------------------------------------------------------------------

  async processElimination(arena: Arena): Promise<void> {
    const votes = await this.repo.getVotes(arena.id, arena.current_round);

    // Tally: count votes per target
    const tally: Record<string, number> = {};
    const voteDetail: Record<string, string> = {}; // voter -> target
    for (const vote of votes) {
      tally[vote.target_id] = (tally[vote.target_id] ?? 0) + 1;
      voteDetail[vote.voter_id] = vote.target_id;
    }

    // Find max votes
    const maxVotes = Math.max(...Object.values(tally), 0);
    if (maxVotes === 0) {
      // No votes at all — edge case. Pick random active player to eliminate.
      const activePlayers = await this.repo.getActivePlayers(arena.id);
      if (activePlayers.length === 0) return;
      const idx = djb2(`${arena.id}:${arena.current_round}:novote`) % activePlayers.length;
      const unlucky = activePlayers[idx];
      await this.eliminatePlayer(arena, unlucky, tally, voteDetail);
      return;
    }

    // Find who has the most votes
    const tiedAgents = Object.entries(tally)
      .filter(([, count]) => count === maxVotes)
      .map(([agentId]) => agentId);

    let eliminatedId: string;
    if (tiedAgents.length === 1) {
      eliminatedId = tiedAgents[0];
    } else {
      eliminatedId = await this.breakTie(arena, tiedAgents);
    }

    // Retrieve the player to eliminate
    const activePlayers = await this.repo.getActivePlayers(arena.id);
    const eliminatedPlayer = activePlayers.find(
      (p) => p.agent_id === eliminatedId,
    );
    if (!eliminatedPlayer) {
      throw new Error(
        `Cannot eliminate ${eliminatedId}: not found among active players`,
      );
    }

    await this.eliminatePlayer(arena, eliminatedPlayer, tally, voteDetail);
  }

  private async eliminatePlayer(
    arena: Arena,
    player: ArenaPlayer,
    tally: Record<string, number>,
    voteDetail: Record<string, string>,
  ): Promise<void> {
    // Mark eliminated
    await this.repo.updatePlayerStatus(
      arena.id,
      player.agent_id,
      "eliminated",
      arena.current_round,
    );

    // Broadcast elimination
    this.broadcast(arena.id, {
      event: "elimination",
      data: {
        round: arena.current_round,
        eliminated: player.agent_id,
        eliminated_name: player.display_name,
        votes: tally,
        vote_detail: voteDetail,
      },
    });

    // Reveal DMs of the eliminated player
    const revealedDMs = await this.repo.revealDMs(arena.id, player.agent_id);
    this.broadcast(arena.id, {
      event: "dm_reveal",
      data: {
        eliminated: player.agent_id,
        dms: revealedDMs.map((dm) => ({
          round: dm.round,
          to: dm.recipient_id!,
          content: dm.content,
        })),
      },
    });
  }

  // -----------------------------------------------------------------------
  // breakTie — tiebreaker logic
  // -----------------------------------------------------------------------

  async breakTie(arena: Arena, tiedAgents: string[]): Promise<string> {
    // 1. Fewer total messages = less engaged = eliminated
    const messageCounts = await Promise.all(
      tiedAgents.map(async (agentId) => ({
        agentId,
        count: await this.repo.getTotalMessageCount(arena.id, agentId),
      })),
    );

    const minMessages = Math.min(...messageCounts.map((m) => m.count));
    const leastActive = messageCounts
      .filter((m) => m.count === minMessages)
      .map((m) => m.agentId);

    if (leastActive.length === 1) {
      return leastActive[0];
    }

    // 2. Deterministic pseudorandom from sorted list
    const sorted = [...leastActive].sort();
    const hash = djb2(`${arena.id}:${arena.current_round}`);
    return sorted[hash % sorted.length];
  }

  // -----------------------------------------------------------------------
  // declareWinner — end the game
  // -----------------------------------------------------------------------

  async declareWinner(arena: Arena): Promise<void> {
    const activePlayers = await this.repo.getActivePlayers(arena.id);
    if (activePlayers.length === 0) {
      throw new Error(`Arena ${arena.id}: no active players to declare winner`);
    }

    const winner = activePlayers[0];
    const now = new Date();

    // Mark winner
    await this.repo.updatePlayerStatus(arena.id, winner.agent_id, "winner");

    // Update arena
    await this.repo.updateArena(arena.id, {
      status: "complete",
      winner_id: winner.agent_id,
      completed_at: now.toISOString(),
      current_phase: "complete",
    });

    // Calculate payout using BigInt for wei precision
    const prizePool = BigInt(arena.prize_pool_wei);
    const prizeWei = (prizePool * BigInt(10000 - arena.rake_bps)) / BigInt(10000);
    const rakeWei = prizePool - prizeWei;

    // Create payout records
    const prizePayout = await this.repo.createPayout(
      arena.id,
      winner.agent_id,
      prizeWei.toString(),
      "prize",
    );

    if (rakeWei > 0n) {
      // Platform rake — use a sentinel agent_id
      await this.repo.createPayout(
        arena.id,
        "platform",
        rakeWei.toString(),
        "rake",
      );
    }

    // Auto-send winner payout if escrow is enabled
    if (this.escrow?.isEnabled()) {
      try {
        const { txHash } = await this.escrow.sendPayout({
          to: winner.agent_id,
          amountWei: prizeWei.toString(),
          chainId: arena.chain_id,
        });
        await this.repo.updatePayoutStatus(prizePayout.id, "sent", txHash);
      } catch (err) {
        console.error(
          `[GameEngine] Auto-payout failed for arena ${arena.id}:`,
          err,
        );
        await this.repo.updatePayoutStatus(prizePayout.id, "failed");
      }
    }

    this.broadcast(arena.id, {
      event: "winner",
      data: {
        winner: winner.agent_id,
        winner_name: winner.display_name,
        prize_wei: prizeWei.toString(),
      },
    });

    // Report result to SwarmTrade (fire-and-forget -- don't block game flow)
    if (this.swarmtrade) {
      const allPlayers = await this.repo.getPlayers(arena.id);
      const eliminatedIds = allPlayers
        .filter((p) => p.status === "eliminated")
        .map((p) => p.agent_id);
      this.swarmtrade
        .reportArenaResult(winner.agent_id, eliminatedIds)
        .catch((err) => {
          console.warn(
            `[GameEngine] SwarmTrade reportArenaResult failed:`,
            err,
          );
        });
    }
  }

  // -----------------------------------------------------------------------
  // assignRandomVotes — fill in for non-voters
  // -----------------------------------------------------------------------

  async assignRandomVotes(arena: Arena): Promise<void> {
    const activePlayers = await this.repo.getActivePlayers(arena.id);
    const votes = await this.repo.getVotes(arena.id, arena.current_round);
    const voterIds = new Set(votes.map((v) => v.voter_id));

    for (const player of activePlayers) {
      if (voterIds.has(player.agent_id)) continue;

      // Build list of possible targets (active players, excluding self)
      const targets = activePlayers.filter(
        (p) => p.agent_id !== player.agent_id,
      );
      if (targets.length === 0) continue;

      // Deterministic index from hash
      const hash = djb2(
        `${arena.id}:${arena.current_round}:${player.agent_id}`,
      );
      const targetIdx = hash % targets.length;
      const target = targets[targetIdx];

      await this.repo.castVote(arena.id, arena.current_round, {
        agent_id: player.agent_id,
        target_id: target.agent_id,
      });
    }
  }

  // -----------------------------------------------------------------------
  // tick — main game loop, called every ~5 seconds
  // -----------------------------------------------------------------------

  async tick(): Promise<void> {
    // 1. Advance running arenas whose phase has expired
    const arenasToAdvance = await this.repo.getRunningArenasNeedingAdvance();
    for (const arena of arenasToAdvance) {
      try {
        await this.advancePhase(arena);
      } catch (err) {
        console.error(
          `[GameEngine] Failed to advance arena ${arena.id}:`,
          err,
        );
      }
    }

    // 2. Auto-start full arenas
    const fullArenas = await this.repo.listArenas({ status: "full" });
    for (const arena of fullArenas) {
      try {
        await this.startArena(arena.id);
      } catch (err) {
        console.error(
          `[GameEngine] Failed to start arena ${arena.id}:`,
          err,
        );
      }
    }

    // 3. Cancel stale open arenas (open > 30 min without filling)
    const openArenas = await this.repo.listArenas({ status: "open" });
    const thirtyMinutesMs = 30 * 60 * 1000;
    const now = Date.now();

    for (const arena of openArenas) {
      try {
        const createdAt = new Date(arena.created_at).getTime();
        if (now - createdAt <= thirtyMinutesMs) continue;

        // Cancel and broadcast
        await this.repo.updateArena(arena.id, { status: "cancelled" });
        this.broadcast(arena.id, {
          event: "arena_cancelled",
          data: {
            reason: "Arena timed out waiting for players",
          },
        });

        // TODO: Refund deposited entry fees to all registered players
      } catch (err) {
        console.error(
          `[GameEngine] Failed to cancel stale arena ${arena.id}:`,
          err,
        );
      }
    }
  }
}

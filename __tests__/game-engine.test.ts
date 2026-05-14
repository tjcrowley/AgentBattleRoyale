import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockPool } from "./mock-pool.js";
import { ArenaRepo } from "../src/arena-repo.js";
import { GameEngine, djb2 } from "../src/game-engine.js";
import type { BroadcastFn } from "../src/game-engine.js";
import type { Arena, SpectatorEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let pool: ReturnType<typeof createMockPool>;
let repo: ArenaRepo;
let broadcast: ReturnType<typeof vi.fn<BroadcastFn>>;
let engine: GameEngine;
let events: Array<{ arenaId: string; event: SpectatorEvent }>;

beforeEach(() => {
  pool = createMockPool();
  repo = new ArenaRepo(pool as any);
  events = [];
  broadcast = vi.fn((arenaId: string, event: SpectatorEvent) => {
    events.push({ arenaId, event });
  });
  engine = new GameEngine(repo, broadcast);
});

/** Create an arena in the given status with N players. Returns arena id. */
async function seedArena(
  status: "created" | "open" | "full" | "running" = "full",
  playerCount = 8,
  opts: { entryFee?: string; rakeBps?: number; createdAt?: string } = {},
): Promise<string> {
  const arena = await repo.createArena({
    entry_fee_wei: opts.entryFee ?? "10000000000000000",
    rake_bps: opts.rakeBps ?? 1000,
    config: {
      alliance_duration_s: 300,
      voting_duration_s: 60,
      between_rounds_s: 30,
    },
  });

  if (status !== "created") {
    await repo.updateArena(arena.id, { status: "open" });
  }

  for (let i = 0; i < playerCount; i++) {
    await repo.addPlayer(arena.id, {
      agent_id: `agent-${i}`,
      display_name: `Agent ${i}`,
    });
  }

  if (status === "full" || status === "running") {
    await repo.updateArena(arena.id, { status: "full" });
  }

  if (status === "running") {
    await engine.startArena(arena.id);
    events.length = 0; // clear startup events for cleaner test assertions
  }

  if (opts.createdAt) {
    // Manually patch the row in the mock table
    const table = pool.tables.get("arenas")!;
    const row = table.find((r) => r.id === arena.id);
    if (row) row.created_at = opts.createdAt;
  }

  return arena.id;
}

/** Transition an arena to voting phase. */
async function transitionToVoting(arenaId: string): Promise<Arena> {
  const arena = (await repo.getArena(arenaId))!;
  await engine.advancePhase(arena);
  return (await repo.getArena(arenaId))!;
}

/** Have specific agents cast votes for a given round. */
async function castVotes(
  arenaId: string,
  round: number,
  votes: Array<{ voter: string; target: string }>,
): Promise<void> {
  for (const v of votes) {
    await repo.castVote(arenaId, round, {
      agent_id: v.voter,
      target_id: v.target,
    });
  }
}

// ===========================================================================
// Arena Lifecycle
// ===========================================================================

describe("Arena Lifecycle", () => {
  it("startArena activates all players, sets round 1 alliance phase", async () => {
    const arenaId = await seedArena("full");
    await engine.startArena(arenaId);

    const arena = (await repo.getArena(arenaId))!;
    expect(arena.status).toBe("running");
    expect(arena.current_round).toBe(1);
    expect(arena.current_phase).toBe("alliance");
    expect(arena.phase_ends_at).toBeTruthy();
    expect(arena.started_at).toBeTruthy();

    const players = await repo.getActivePlayers(arenaId);
    expect(players.length).toBe(8);
    for (const p of players) {
      expect(p.status).toBe("active");
    }
  });

  it("startArena fails if arena not 'full'", async () => {
    const arenaId = await seedArena("open", 3);
    await expect(engine.startArena(arenaId)).rejects.toThrow("expected 'full'");
  });

  it("startArena broadcasts phase_start event", async () => {
    const arenaId = await seedArena("full");
    await engine.startArena(arenaId);

    const phaseStart = events.find((e) => e.event.event === "phase_start");
    expect(phaseStart).toBeDefined();
    expect(phaseStart!.event.event).toBe("phase_start");

    const data = phaseStart!.event.data as {
      round: number;
      phase: string;
      active_players: string[];
    };
    expect(data.round).toBe(1);
    expect(data.phase).toBe("alliance");
    expect(data.active_players).toHaveLength(8);
  });
});

// ===========================================================================
// Phase Transitions
// ===========================================================================

describe("Phase Transitions", () => {
  it("alliance -> voting transition sets correct phase and timer", async () => {
    const arenaId = await seedArena("running");
    const arena = (await repo.getArena(arenaId))!;

    await engine.advancePhase(arena);

    const updated = (await repo.getArena(arenaId))!;
    expect(updated.current_phase).toBe("voting");
    expect(updated.phase_ends_at).toBeTruthy();

    // Voting phase_start event should be broadcast
    const phaseEvent = events.find(
      (e) =>
        e.event.event === "phase_start" &&
        (e.event.data as { phase: string }).phase === "voting",
    );
    expect(phaseEvent).toBeDefined();
  });

  it("voting -> elimination transition processes elimination correctly", async () => {
    const arenaId = await seedArena("running");

    // Move to voting
    const allianceArena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(allianceArena);

    // Cast some votes: everyone votes for agent-0
    const activePlayers = await repo.getActivePlayers(arenaId);
    for (const p of activePlayers) {
      if (p.agent_id !== "agent-0") {
        await repo.castVote(arenaId, 1, {
          agent_id: p.agent_id,
          target_id: "agent-0",
        });
      }
    }
    // agent-0 votes for agent-1
    await repo.castVote(arenaId, 1, {
      agent_id: "agent-0",
      target_id: "agent-1",
    });

    // Advance from voting -> elimination
    const votingArena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(votingArena);

    const updatedArena = (await repo.getArena(arenaId))!;
    expect(updatedArena.current_phase).toBe("elimination");

    // agent-0 should be eliminated
    const players = await repo.getPlayers(arenaId);
    const agent0 = players.find((p) => p.agent_id === "agent-0");
    expect(agent0!.status).toBe("eliminated");
    expect(agent0!.eliminated_round).toBe(1);
  });

  it("elimination -> alliance (next round) when >1 player remains", async () => {
    const arenaId = await seedArena("running");

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Cast votes: all vote agent-0
    const players = await repo.getActivePlayers(arenaId);
    for (const p of players) {
      if (p.agent_id !== "agent-0") {
        await repo.castVote(arenaId, 1, {
          agent_id: p.agent_id,
          target_id: "agent-0",
        });
      }
    }
    await repo.castVote(arenaId, 1, {
      agent_id: "agent-0",
      target_id: "agent-1",
    });

    // voting -> elimination
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // elimination -> next round alliance
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    arena = (await repo.getArena(arenaId))!;
    expect(arena.current_round).toBe(2);
    expect(arena.current_phase).toBe("alliance");
    expect(arena.phase_ends_at).toBeTruthy();
    expect(arena.status).toBe("running");
  });

  it("elimination -> complete when only 1 player remains (winner declared)", async () => {
    // Create arena with 2 players so one elimination ends the game
    const arenaId = await seedArena("created", 0);
    await repo.updateArena(arenaId, { status: "open" });
    await repo.addPlayer(arenaId, {
      agent_id: "alice",
      display_name: "Alice",
    });
    await repo.addPlayer(arenaId, {
      agent_id: "bob",
      display_name: "Bob",
    });
    await repo.updateArena(arenaId, { status: "full", max_players: 2 } as any);
    await engine.startArena(arenaId);
    events.length = 0;

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Both vote for each other
    await repo.castVote(arenaId, 1, {
      agent_id: "alice",
      target_id: "bob",
    });
    await repo.castVote(arenaId, 1, {
      agent_id: "bob",
      target_id: "alice",
    });

    // voting -> elimination (tie will be resolved)
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // elimination -> should declare winner since only 1 left
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    arena = (await repo.getArena(arenaId))!;
    expect(arena.status).toBe("complete");
    expect(arena.current_phase).toBe("complete");
    expect(arena.winner_id).toBeTruthy();
    expect(arena.completed_at).toBeTruthy();

    // winner event should be broadcast
    const winnerEvent = events.find((e) => e.event.event === "winner");
    expect(winnerEvent).toBeDefined();
  });
});

// ===========================================================================
// Elimination Logic
// ===========================================================================

describe("Elimination Logic", () => {
  it("agent with most votes gets eliminated", async () => {
    const arenaId = await seedArena("running");

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // 5 agents vote for agent-2, others vote for various targets
    await castVotes(arenaId, 1, [
      { voter: "agent-0", target: "agent-2" },
      { voter: "agent-1", target: "agent-2" },
      { voter: "agent-3", target: "agent-2" },
      { voter: "agent-4", target: "agent-2" },
      { voter: "agent-5", target: "agent-2" },
      { voter: "agent-6", target: "agent-1" },
      { voter: "agent-7", target: "agent-1" },
      { voter: "agent-2", target: "agent-0" },
    ]);

    // voting -> elimination
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    const players = await repo.getPlayers(arenaId);
    const agent2 = players.find((p) => p.agent_id === "agent-2");
    expect(agent2!.status).toBe("eliminated");
    expect(agent2!.eliminated_round).toBe(1);
  });

  it("eliminated agent's DMs are revealed", async () => {
    const arenaId = await seedArena("running");

    // agent-0 sends a DM during alliance
    await repo.addMessage(arenaId, 1, {
      agent_id: "agent-0",
      content: "secret alliance?",
      recipient_id: "agent-1",
    });

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Everyone votes for agent-0
    const activePlayers = await repo.getActivePlayers(arenaId);
    for (const p of activePlayers) {
      if (p.agent_id !== "agent-0") {
        await repo.castVote(arenaId, 1, {
          agent_id: p.agent_id,
          target_id: "agent-0",
        });
      }
    }
    await repo.castVote(arenaId, 1, {
      agent_id: "agent-0",
      target_id: "agent-1",
    });

    // voting -> elimination
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Check DMs are revealed
    const messages = await repo.getMessages(arenaId, { senderId: "agent-0" });
    const dms = messages.filter((m) => m.recipient_id !== null);
    for (const dm of dms) {
      expect(dm.revealed).toBe(true);
    }
  });

  it("elimination event is broadcast with vote tally", async () => {
    const arenaId = await seedArena("running");

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Everyone votes for agent-3
    const activePlayers = await repo.getActivePlayers(arenaId);
    for (const p of activePlayers) {
      if (p.agent_id !== "agent-3") {
        await repo.castVote(arenaId, 1, {
          agent_id: p.agent_id,
          target_id: "agent-3",
        });
      }
    }
    await repo.castVote(arenaId, 1, {
      agent_id: "agent-3",
      target_id: "agent-0",
    });
    events.length = 0;

    // voting -> elimination
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    const elimEvent = events.find((e) => e.event.event === "elimination");
    expect(elimEvent).toBeDefined();

    const data = elimEvent!.event.data as {
      round: number;
      eliminated: string;
      votes: Record<string, number>;
      vote_detail: Record<string, string>;
    };
    expect(data.eliminated).toBe("agent-3");
    expect(data.round).toBe(1);
    expect(data.votes["agent-3"]).toBe(7);
    expect(Object.keys(data.vote_detail)).toHaveLength(8);
  });

  it("dm_reveal event is broadcast with all DMs", async () => {
    const arenaId = await seedArena("running");

    // agent-5 sends DMs
    await repo.addMessage(arenaId, 1, {
      agent_id: "agent-5",
      content: "lets team up",
      recipient_id: "agent-0",
    });
    await repo.addMessage(arenaId, 1, {
      agent_id: "agent-5",
      content: "vote agent-3",
      recipient_id: "agent-1",
    });

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Everyone votes for agent-5
    const activePlayers = await repo.getActivePlayers(arenaId);
    for (const p of activePlayers) {
      if (p.agent_id !== "agent-5") {
        await repo.castVote(arenaId, 1, {
          agent_id: p.agent_id,
          target_id: "agent-5",
        });
      }
    }
    await repo.castVote(arenaId, 1, {
      agent_id: "agent-5",
      target_id: "agent-0",
    });
    events.length = 0;

    // voting -> elimination
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    const dmRevealEvent = events.find((e) => e.event.event === "dm_reveal");
    expect(dmRevealEvent).toBeDefined();

    const data = dmRevealEvent!.event.data as {
      eliminated: string;
      dms: Array<{ round: number; to: string; content: string }>;
    };
    expect(data.eliminated).toBe("agent-5");
    expect(data.dms).toHaveLength(2);
    expect(data.dms.map((d) => d.to).sort()).toEqual(["agent-0", "agent-1"]);
  });
});

// ===========================================================================
// Tiebreakers
// ===========================================================================

describe("Tiebreakers", () => {
  it("tie goes to agent with fewer messages", async () => {
    const arenaId = await seedArena("running");

    // agent-0 sends 3 messages, agent-1 sends 1 message
    await repo.addMessage(arenaId, 1, {
      agent_id: "agent-0",
      content: "msg1",
    });
    await repo.addMessage(arenaId, 1, {
      agent_id: "agent-0",
      content: "msg2",
    });
    await repo.addMessage(arenaId, 1, {
      agent_id: "agent-0",
      content: "msg3",
    });
    await repo.addMessage(arenaId, 1, {
      agent_id: "agent-1",
      content: "msg1",
    });

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // 4 vote agent-0, 4 vote agent-1 (exact tie)
    await castVotes(arenaId, 1, [
      { voter: "agent-1", target: "agent-0" },
      { voter: "agent-2", target: "agent-0" },
      { voter: "agent-3", target: "agent-0" },
      { voter: "agent-4", target: "agent-0" },
      { voter: "agent-0", target: "agent-1" },
      { voter: "agent-5", target: "agent-1" },
      { voter: "agent-6", target: "agent-1" },
      { voter: "agent-7", target: "agent-1" },
    ]);

    // voting -> elimination
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // agent-1 has fewer messages (1 vs 3), so agent-1 gets eliminated
    const players = await repo.getPlayers(arenaId);
    const agent1 = players.find((p) => p.agent_id === "agent-1");
    expect(agent1!.status).toBe("eliminated");
  });

  it("if messages also tied, deterministic hash tiebreaker selects consistently", async () => {
    const arenaId = await seedArena("running");

    // Both agent-0 and agent-1 send exactly 1 message (tied messages)
    await repo.addMessage(arenaId, 1, {
      agent_id: "agent-0",
      content: "hello",
    });
    await repo.addMessage(arenaId, 1, {
      agent_id: "agent-1",
      content: "hello",
    });

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Tie in votes: 4 each
    await castVotes(arenaId, 1, [
      { voter: "agent-1", target: "agent-0" },
      { voter: "agent-2", target: "agent-0" },
      { voter: "agent-3", target: "agent-0" },
      { voter: "agent-4", target: "agent-0" },
      { voter: "agent-0", target: "agent-1" },
      { voter: "agent-5", target: "agent-1" },
      { voter: "agent-6", target: "agent-1" },
      { voter: "agent-7", target: "agent-1" },
    ]);

    // voting -> elimination
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Determine who was eliminated
    const players = await repo.getPlayers(arenaId);
    const eliminated = players.find((p) => p.status === "eliminated");
    expect(eliminated).toBeDefined();

    // The hash tiebreaker is deterministic — compute expected result
    const sorted = ["agent-0", "agent-1"].sort();
    const hash = djb2(`${arenaId}:1`);
    const expectedEliminated = sorted[hash % sorted.length];
    expect(eliminated!.agent_id).toBe(expectedEliminated);
  });
});

// ===========================================================================
// Auto-Voting
// ===========================================================================

describe("Auto-Voting", () => {
  it("agents who don't vote get random votes assigned", async () => {
    const arenaId = await seedArena("running");

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Only agent-0 votes manually
    await repo.castVote(arenaId, 1, {
      agent_id: "agent-0",
      target_id: "agent-1",
    });

    // voting -> elimination (triggers assignRandomVotes)
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // All 8 agents should have votes
    const votes = await repo.getVotes(arenaId, 1);
    expect(votes.length).toBe(8);

    const voterIds = votes.map((v) => v.voter_id);
    for (let i = 0; i < 8; i++) {
      expect(voterIds).toContain(`agent-${i}`);
    }
  });

  it("random votes are deterministic (same inputs = same output)", async () => {
    const arenaId = await seedArena("running");

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // No manual votes — auto-assign
    arena = (await repo.getArena(arenaId))!;
    await engine.assignRandomVotes(arena);

    const votes = await repo.getVotes(arenaId, 1);
    const voteMap = votes.map((v) => `${v.voter_id}->${v.target_id}`).sort();

    // Verify determinism: compute expected targets using the same djb2 logic
    const activePlayers = await repo.getActivePlayers(arenaId);
    const expectedMap: string[] = [];
    for (const player of activePlayers) {
      const targets = activePlayers.filter(
        (p) => p.agent_id !== player.agent_id,
      );
      const hash = djb2(`${arenaId}:${arena.current_round}:${player.agent_id}`);
      const targetIdx = hash % targets.length;
      expectedMap.push(`${player.agent_id}->${targets[targetIdx].agent_id}`);
    }
    expectedMap.sort();

    expect(voteMap).toEqual(expectedMap);
  });

  it("auto-vote never targets self", async () => {
    const arenaId = await seedArena("running");

    // alliance -> voting
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // No manual votes — all are auto-assigned
    arena = (await repo.getArena(arenaId))!;
    await engine.assignRandomVotes(arena);

    const votes = await repo.getVotes(arenaId, 1);
    for (const vote of votes) {
      expect(vote.voter_id).not.toBe(vote.target_id);
    }
  });
});

// ===========================================================================
// Winner Declaration
// ===========================================================================

describe("Winner Declaration", () => {
  it("winner gets 'winner' status", async () => {
    const arenaId = await seedArena("created", 0);
    await repo.updateArena(arenaId, { status: "open" });
    await repo.addPlayer(arenaId, {
      agent_id: "alice",
      display_name: "Alice",
    });
    await repo.addPlayer(arenaId, {
      agent_id: "bob",
      display_name: "Bob",
    });
    await repo.updateArena(arenaId, { status: "full" });
    await engine.startArena(arenaId);

    // alliance -> voting -> elimination
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    await repo.castVote(arenaId, 1, {
      agent_id: "alice",
      target_id: "bob",
    });
    await repo.castVote(arenaId, 1, {
      agent_id: "bob",
      target_id: "alice",
    });

    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // elimination -> declare winner
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    const players = await repo.getPlayers(arenaId);
    const winner = players.find((p) => p.status === "winner");
    expect(winner).toBeDefined();
  });

  it("prize and rake payouts created with correct amounts", async () => {
    const entryFee = "10000000000000000"; // 0.01 ETH
    const arenaId = await seedArena("created", 0, {
      entryFee,
      rakeBps: 1000,
    });
    await repo.updateArena(arenaId, { status: "open" });
    await repo.addPlayer(arenaId, {
      agent_id: "alice",
      display_name: "Alice",
    });
    await repo.addPlayer(arenaId, {
      agent_id: "bob",
      display_name: "Bob",
    });
    await repo.updateArena(arenaId, { status: "full" });
    await engine.startArena(arenaId);

    // Run through to winner
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena); // alliance -> voting

    await repo.castVote(arenaId, 1, {
      agent_id: "alice",
      target_id: "bob",
    });
    await repo.castVote(arenaId, 1, {
      agent_id: "bob",
      target_id: "alice",
    });

    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena); // voting -> elimination

    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena); // elimination -> declare winner

    // Check payouts
    const payoutsTable = pool.tables.get("arena_payouts")!;
    const prizePayout = payoutsTable.find((p) => p.type === "prize");
    const rakePayout = payoutsTable.find((p) => p.type === "rake");

    expect(prizePayout).toBeDefined();
    expect(rakePayout).toBeDefined();

    // prize_pool = 2 * 0.01 ETH = 0.02 ETH = 20000000000000000
    // prize = 90% = 18000000000000000
    // rake = 10% = 2000000000000000
    const prizePool = BigInt("20000000000000000");
    const expectedPrize =
      (prizePool * BigInt(10000 - 1000)) / BigInt(10000);
    const expectedRake = prizePool - expectedPrize;

    expect(BigInt(String(prizePayout!.amount_wei))).toBe(expectedPrize);
    expect(BigInt(String(rakePayout!.amount_wei))).toBe(expectedRake);
  });

  it("arena set to 'complete'", async () => {
    const arenaId = await seedArena("created", 0);
    await repo.updateArena(arenaId, { status: "open" });
    await repo.addPlayer(arenaId, {
      agent_id: "alice",
      display_name: "Alice",
    });
    await repo.addPlayer(arenaId, {
      agent_id: "bob",
      display_name: "Bob",
    });
    await repo.updateArena(arenaId, { status: "full" });
    await engine.startArena(arenaId);

    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);
    await repo.castVote(arenaId, 1, {
      agent_id: "alice",
      target_id: "bob",
    });
    await repo.castVote(arenaId, 1, {
      agent_id: "bob",
      target_id: "alice",
    });
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    arena = (await repo.getArena(arenaId))!;
    expect(arena.status).toBe("complete");
    expect(arena.current_phase).toBe("complete");
  });

  it("winner event broadcast", async () => {
    const arenaId = await seedArena("created", 0);
    await repo.updateArena(arenaId, { status: "open" });
    await repo.addPlayer(arenaId, {
      agent_id: "alice",
      display_name: "Alice",
    });
    await repo.addPlayer(arenaId, {
      agent_id: "bob",
      display_name: "Bob",
    });
    await repo.updateArena(arenaId, { status: "full" });
    await engine.startArena(arenaId);

    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);
    await repo.castVote(arenaId, 1, {
      agent_id: "alice",
      target_id: "bob",
    });
    await repo.castVote(arenaId, 1, {
      agent_id: "bob",
      target_id: "alice",
    });
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);
    events.length = 0;

    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    const winnerEvent = events.find((e) => e.event.event === "winner");
    expect(winnerEvent).toBeDefined();
    const data = winnerEvent!.event.data as {
      winner: string;
      winner_name: string;
      prize_wei: string;
    };
    expect(data.winner).toBeTruthy();
    expect(data.winner_name).toBeTruthy();
    expect(BigInt(data.prize_wei)).toBeGreaterThan(0n);
  });
});

// ===========================================================================
// Full Game Simulation
// ===========================================================================

describe("Full Game Simulation", () => {
  it("runs a complete 8-player game through all 7 rounds", async () => {
    const entryFee = "10000000000000000"; // 0.01 ETH
    const arenaId = await seedArena("running", 8, { entryFee, rakeBps: 1000 });

    let eliminationCount = 0;

    for (let round = 1; round <= 7; round++) {
      let arena = (await repo.getArena(arenaId))!;
      expect(arena.current_phase).toBe("alliance");
      expect(arena.current_round).toBe(round);

      // alliance -> voting
      await engine.advancePhase(arena);
      arena = (await repo.getArena(arenaId))!;
      expect(arena.current_phase).toBe("voting");

      // Get active players and have them vote for the first active player
      const activePlayers = await repo.getActivePlayers(arenaId);
      const target = activePlayers[0].agent_id;
      for (const p of activePlayers) {
        if (p.agent_id !== target) {
          await repo.castVote(arenaId, round, {
            agent_id: p.agent_id,
            target_id: target,
          });
        } else {
          // Target votes for someone else
          const otherTarget = activePlayers[1].agent_id;
          await repo.castVote(arenaId, round, {
            agent_id: p.agent_id,
            target_id: otherTarget,
          });
        }
      }

      // voting -> elimination
      arena = (await repo.getArena(arenaId))!;
      await engine.advancePhase(arena);
      eliminationCount++;

      arena = (await repo.getArena(arenaId))!;
      if (arena.status === "complete") break;

      // elimination -> next round alliance
      await engine.advancePhase(arena);
    }

    expect(eliminationCount).toBe(7);

    const finalArena = (await repo.getArena(arenaId))!;
    expect(finalArena.status).toBe("complete");
    expect(finalArena.current_phase).toBe("complete");
    expect(finalArena.winner_id).toBeTruthy();

    // Verify exactly 7 eliminations, 1 winner
    const allPlayers = await repo.getPlayers(arenaId);
    const eliminatedPlayers = allPlayers.filter(
      (p) => p.status === "eliminated",
    );
    const winners = allPlayers.filter((p) => p.status === "winner");
    expect(eliminatedPlayers.length).toBe(7);
    expect(winners.length).toBe(1);

    // Verify payouts sum correctly
    const payoutsTable = pool.tables.get("arena_payouts")!;
    const prizePayout = payoutsTable.find(
      (p) => p.arena_id === arenaId && p.type === "prize",
    );
    const rakePayout = payoutsTable.find(
      (p) => p.arena_id === arenaId && p.type === "rake",
    );
    expect(prizePayout).toBeDefined();
    expect(rakePayout).toBeDefined();

    const prizePool = BigInt("80000000000000000"); // 8 * 0.01 ETH
    const totalPayouts =
      BigInt(String(prizePayout!.amount_wei)) +
      BigInt(String(rakePayout!.amount_wei));
    expect(totalPayouts).toBe(prizePool);
  });
});

// ===========================================================================
// tick() Method
// ===========================================================================

describe("tick() Method", () => {
  it("advances arenas with expired phases", async () => {
    const arenaId = await seedArena("running");

    // Set phase_ends_at to the past
    const past = new Date(Date.now() - 60_000).toISOString();
    await repo.updateArena(arenaId, { phase_ends_at: past });

    await engine.tick();

    const arena = (await repo.getArena(arenaId))!;
    // Should have advanced from alliance to voting
    expect(arena.current_phase).toBe("voting");
  });

  it("does not advance arenas whose phase hasn't expired", async () => {
    const arenaId = await seedArena("running");

    // Phase ends in the future
    const future = new Date(Date.now() + 300_000).toISOString();
    await repo.updateArena(arenaId, { phase_ends_at: future });

    await engine.tick();

    const arena = (await repo.getArena(arenaId))!;
    expect(arena.current_phase).toBe("alliance");
  });

  it("auto-starts 'full' arenas", async () => {
    const arenaId = await seedArena("full");

    await engine.tick();

    const arena = (await repo.getArena(arenaId))!;
    expect(arena.status).toBe("running");
    expect(arena.current_phase).toBe("alliance");
    expect(arena.current_round).toBe(1);
  });

  it("cancels stale 'open' arenas (>30 min)", async () => {
    const staleTime = new Date(
      Date.now() - 31 * 60 * 1000,
    ).toISOString();
    const arenaId = await seedArena("open", 3, { createdAt: staleTime });

    await engine.tick();

    const arena = (await repo.getArena(arenaId))!;
    expect(arena.status).toBe("cancelled");

    const cancelEvent = events.find(
      (e) => e.event.event === "arena_cancelled",
    );
    expect(cancelEvent).toBeDefined();
  });
});

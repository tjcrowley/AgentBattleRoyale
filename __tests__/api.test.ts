import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMockPool } from "./mock-pool.js";
import { buildApp } from "../src/build-app.js";
import type { GameEngine } from "../src/game-engine.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ADMIN_KEY = "test-admin-key-42";
let pool: ReturnType<typeof createMockPool>;
let app: FastifyInstance;
let engine: GameEngine;

beforeEach(async () => {
  pool = createMockPool();
  const built = await buildApp({
    pool: pool as any,
    adminKey: ADMIN_KEY,
    logger: false,
  });
  app = built.app;
  engine = built.engine;
});

afterEach(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an arena via admin endpoint. Returns the arena object. */
async function createArena(
  entryFeeWei = "10000000000000000",
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/arenas",
    headers: { "x-admin-key": ADMIN_KEY },
    payload: { entry_fee_wei: entryFeeWei },
  });
  return JSON.parse(res.payload);
}

/** Open an arena for joining. */
async function openArena(arenaId: string): Promise<void> {
  await app.inject({
    method: "POST",
    url: `/admin/arenas/${arenaId}/open`,
    headers: { "x-admin-key": ADMIN_KEY },
  });
}

/** Join an arena as a specific agent. */
async function joinArena(
  arenaId: string,
  agentId: string,
  displayName: string,
): Promise<ReturnType<FastifyInstance["inject"]> extends Promise<infer R> ? R : never> {
  return app.inject({
    method: "POST",
    url: `/arenas/${arenaId}/join`,
    headers: { "x-agent-id": agentId },
    payload: { display_name: displayName },
  });
}

/** Create an arena, open it, and fill with N players. Returns arena id. */
async function seedRunningArena(
  playerCount = 8,
): Promise<string> {
  const arena = await createArena();
  const arenaId = arena.id as string;
  await openArena(arenaId);

  for (let i = 0; i < playerCount; i++) {
    await joinArena(arenaId, `agent-${i}`, `Agent ${i}`);
  }
  return arenaId;
}

// ===========================================================================
// Health
// ===========================================================================

describe("Health", () => {
  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeTruthy();
  });
});

// ===========================================================================
// Arena Admin
// ===========================================================================

describe("Arena Admin", () => {
  it("POST /admin/arenas creates arena (requires admin key)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/arenas",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { entry_fee_wei: "10000000000000000" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("created");
    expect(body.entry_fee_wei).toBe("10000000000000000");
  });

  it("POST /admin/arenas fails without admin key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/arenas",
      payload: { entry_fee_wei: "10000000000000000" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /admin/arenas/:id/open opens arena", async () => {
    const arena = await createArena();
    const res = await app.inject({
      method: "POST",
      url: `/admin/arenas/${arena.id}/open`,
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("open");
  });

  it("POST /admin/arenas accepts max_players 8–100", async () => {
    for (const max of [8, 16, 50, 100]) {
      const res = await app.inject({
        method: "POST",
        url: "/admin/arenas",
        headers: { "x-admin-key": ADMIN_KEY },
        payload: { entry_fee_wei: "10000000000000000", max_players: max },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.max_players).toBe(max);
    }
  });

  it("POST /admin/arenas rejects max_players < 8", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/arenas",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { entry_fee_wei: "10000000000000000", max_players: 4 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain("max_players");
  });

  it("POST /admin/arenas rejects max_players > 100", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/arenas",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { entry_fee_wei: "10000000000000000", max_players: 200 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain("max_players");
  });

  it("POST /admin/arenas auto-scales config for large arenas", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/arenas",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { entry_fee_wei: "10000000000000000", max_players: 100 },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    // 100-player arena should have shorter phases than default 300s
    expect(body.config.alliance_duration_s).toBe(60);
    expect(body.config.voting_duration_s).toBe(20);
    expect(body.config.between_rounds_s).toBe(10);
  });
});

// ===========================================================================
// Joining
// ===========================================================================

describe("Joining", () => {
  it("POST /arenas/:id/join adds player", async () => {
    const arena = await createArena();
    await openArena(arena.id as string);

    const res = await joinArena(
      arena.id as string,
      "agent-test",
      "Test Agent",
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("joined");
    expect(body.players_count).toBe(1);
  });

  it("POST /arenas/:id/join returns 409 if already joined", async () => {
    const arena = await createArena();
    await openArena(arena.id as string);

    await joinArena(arena.id as string, "agent-dupe", "Dupe Agent");
    const res = await joinArena(arena.id as string, "agent-dupe", "Dupe Agent");
    expect(res.statusCode).toBe(409);
  });

  it("POST /arenas/:id/join returns 403 if arena not open", async () => {
    const arena = await createArena();
    // Arena is in 'created' status, not opened

    const res = await joinArena(arena.id as string, "agent-x", "Agent X");
    expect(res.statusCode).toBe(403);
  });

  it("arena auto-starts when 8th player joins", async () => {
    const arena = await createArena();
    await openArena(arena.id as string);

    for (let i = 0; i < 7; i++) {
      await joinArena(arena.id as string, `agent-${i}`, `Agent ${i}`);
    }

    // 8th player triggers auto-start
    const res = await joinArena(arena.id as string, "agent-7", "Agent 7");
    expect(res.statusCode).toBe(201);

    // Verify arena is running
    const detailRes = await app.inject({
      method: "GET",
      url: `/arenas/${arena.id}`,
    });
    const detail = JSON.parse(detailRes.payload);
    expect(detail.arena.status).toBe("running");
    expect(detail.arena.current_phase).toBe("alliance");
    expect(detail.arena.current_round).toBe(1);
  });
});

// ===========================================================================
// Messaging
// ===========================================================================

describe("Messaging", () => {
  it("POST /arenas/:id/message sends public message", async () => {
    const arenaId = await seedRunningArena();

    const res = await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/message`,
      headers: { "x-agent-id": "agent-0" },
      payload: { content: "Hello everyone!" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.type).toBe("public");
    expect(body.message_id).toBeTruthy();
  });

  it("POST /arenas/:id/message sends DM", async () => {
    const arenaId = await seedRunningArena();

    const res = await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/message`,
      headers: { "x-agent-id": "agent-0" },
      payload: { content: "Secret message", recipient_id: "agent-1" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.type).toBe("dm");
  });

  it("POST /arenas/:id/message returns 403 if not alliance phase", async () => {
    const arenaId = await seedRunningArena();

    // Advance to voting phase
    const arena = JSON.parse(
      (await app.inject({ method: "GET", url: `/arenas/${arenaId}` })).payload,
    ).arena;

    // Manually set to voting phase via the engine
    const repoArena = pool.tables.get("arenas")!.find((a) => a.id === arenaId);
    repoArena!.current_phase = "voting";

    const res = await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/message`,
      headers: { "x-agent-id": "agent-0" },
      payload: { content: "Hello" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /arenas/:id/message returns 429 after 10 messages in one phase", async () => {
    const arenaId = await seedRunningArena();

    // Send 10 messages
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/arenas/${arenaId}/message`,
        headers: { "x-agent-id": "agent-0" },
        payload: { content: `Message ${i}` },
      });
      expect(res.statusCode).toBe(200);
    }

    // 11th message should be rate limited
    const res = await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/message`,
      headers: { "x-agent-id": "agent-0" },
      payload: { content: "Too many" },
    });
    expect(res.statusCode).toBe(429);
  });

  it("message content capped at 500 chars", async () => {
    const arenaId = await seedRunningArena();

    const longContent = "x".repeat(501);
    const res = await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/message`,
      headers: { "x-agent-id": "agent-0" },
      payload: { content: longContent },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("500");
  });
});

// ===========================================================================
// Voting
// ===========================================================================

describe("Voting", () => {
  /** Helper to get a running arena in voting phase. */
  async function seedVotingArena(): Promise<string> {
    const arenaId = await seedRunningArena();

    // Advance to voting — directly update mock DB
    const arenaRow = pool.tables.get("arenas")!.find((a) => a.id === arenaId)!;
    arenaRow.current_phase = "voting";

    return arenaId;
  }

  it("POST /arenas/:id/vote casts vote", async () => {
    const arenaId = await seedVotingArena();

    const res = await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/vote`,
      headers: { "x-agent-id": "agent-0" },
      payload: { target_id: "agent-1" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("vote_cast");
  });

  it("POST /arenas/:id/vote returns 409 if already voted", async () => {
    const arenaId = await seedVotingArena();

    await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/vote`,
      headers: { "x-agent-id": "agent-0" },
      payload: { target_id: "agent-1" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/vote`,
      headers: { "x-agent-id": "agent-0" },
      payload: { target_id: "agent-2" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /arenas/:id/vote returns 403 if not voting phase", async () => {
    const arenaId = await seedRunningArena();
    // Arena is in alliance phase

    const res = await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/vote`,
      headers: { "x-agent-id": "agent-0" },
      payload: { target_id: "agent-1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /arenas/:id/vote returns 400 if target is self", async () => {
    const arenaId = await seedVotingArena();

    const res = await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/vote`,
      headers: { "x-agent-id": "agent-0" },
      payload: { target_id: "agent-0" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ===========================================================================
// State
// ===========================================================================

describe("State", () => {
  it("GET /arenas/:id/state returns agent-specific view", async () => {
    const arenaId = await seedRunningArena();

    const res = await app.inject({
      method: "GET",
      url: `/arenas/${arenaId}/state`,
      headers: { "x-agent-id": "agent-0" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.arena_id).toBe(arenaId);
    expect(body.agent_id).toBe("agent-0");
    expect(body.status).toBe("running");
    expect(body.current_round).toBe(1);
    expect(body.current_phase).toBe("alliance");
    expect(body.active_players).toHaveLength(8);
    expect(Array.isArray(body.public_messages)).toBe(true);
    expect(Array.isArray(body.my_dms)).toBe(true);
    expect(Array.isArray(body.vote_history)).toBe(true);
    expect(Array.isArray(body.my_votes)).toBe(true);
  });

  it("agent sees own DMs but not others'", async () => {
    const arenaId = await seedRunningArena();

    // agent-0 sends DM to agent-1
    await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/message`,
      headers: { "x-agent-id": "agent-0" },
      payload: { content: "Secret from 0 to 1", recipient_id: "agent-1" },
    });

    // agent-2 sends DM to agent-3
    await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/message`,
      headers: { "x-agent-id": "agent-2" },
      payload: { content: "Secret from 2 to 3", recipient_id: "agent-3" },
    });

    // agent-0 should see their own DM
    const res0 = await app.inject({
      method: "GET",
      url: `/arenas/${arenaId}/state`,
      headers: { "x-agent-id": "agent-0" },
    });
    const state0 = JSON.parse(res0.payload);
    expect(state0.my_dms.length).toBe(1);
    expect(state0.my_dms[0].content).toBe("Secret from 0 to 1");

    // agent-1 should see the DM received from agent-0
    const res1 = await app.inject({
      method: "GET",
      url: `/arenas/${arenaId}/state`,
      headers: { "x-agent-id": "agent-1" },
    });
    const state1 = JSON.parse(res1.payload);
    expect(state1.my_dms.length).toBe(1);
    expect(state1.my_dms[0].content).toBe("Secret from 0 to 1");

    // agent-4 should not see any DMs
    const res4 = await app.inject({
      method: "GET",
      url: `/arenas/${arenaId}/state`,
      headers: { "x-agent-id": "agent-4" },
    });
    const state4 = JSON.parse(res4.payload);
    expect(state4.my_dms.length).toBe(0);
  });
});

// ===========================================================================
// Spectator
// ===========================================================================

describe("Spectator", () => {
  it("GET /arenas returns arena list", async () => {
    await createArena();
    await createArena();

    const res = await app.inject({ method: "GET", url: "/arenas" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.arenas).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("GET /arenas/:id returns arena details", async () => {
    const arena = await createArena();
    await openArena(arena.id as string);
    await joinArena(arena.id as string, "agent-0", "Agent 0");

    const res = await app.inject({
      method: "GET",
      url: `/arenas/${arena.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.arena.id).toBe(arena.id);
    expect(body.players).toHaveLength(1);
    expect(body.current_phase).toBe("waiting");
  });

  it("GET /arenas/:id/recap returns full replay for completed arena", async () => {
    // Create a 2-player arena and run it to completion
    const arenaData = await createArena();
    const arenaId = arenaData.id as string;
    await openArena(arenaId);

    // Patch max_players to 2 in the mock
    const arenaRow = pool.tables.get("arenas")!.find((a) => a.id === arenaId)!;
    arenaRow.max_players = 2;

    await joinArena(arenaId, "alice", "Alice");
    await joinArena(arenaId, "bob", "Bob");

    // Arena should be running now (auto-start on full)
    // Advance: alliance -> voting
    let arenaState = pool.tables
      .get("arenas")!
      .find((a) => a.id === arenaId)!;

    // Set phase expired so we can advance via engine
    arenaState.phase_ends_at = new Date(Date.now() - 1000).toISOString();

    // Use engine to advance through the game
    const { ArenaRepo } = await import("../src/arena-repo.js");
    const repo = new ArenaRepo(pool as any);
    let arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena); // alliance -> voting

    // Cast votes
    await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/vote`,
      headers: { "x-agent-id": "alice" },
      payload: { target_id: "bob" },
    });
    await app.inject({
      method: "POST",
      url: `/arenas/${arenaId}/vote`,
      headers: { "x-agent-id": "bob" },
      payload: { target_id: "alice" },
    });

    // voting -> elimination
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // elimination -> complete (declare winner)
    arena = (await repo.getArena(arenaId))!;
    await engine.advancePhase(arena);

    // Now test recap
    const res = await app.inject({
      method: "GET",
      url: `/arenas/${arenaId}/recap`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.arena.status).toBe("complete");
    expect(body.winner).toBeTruthy();
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0].round).toBe(1);
  });
});

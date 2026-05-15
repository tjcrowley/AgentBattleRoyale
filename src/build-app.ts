import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { Pool } from "pg";

import { ArenaRepo } from "./arena-repo.js";
import { GameEngine } from "./game-engine.js";
import { SpectatorFeed } from "./spectator-feed.js";
import { ArenaEscrow } from "./escrow.js";
import { setupHealthMonitoring } from "./health.js";
import type { SwarmTradeIntegration } from "./swarmtrade.js";
import {
  MIN_PLAYERS,
  MAX_PLAYERS,
  scaleConfig,
} from "./types.js";
import type {
  ArenaStatus,
  CreateArenaParams,
  AgentStateView,
} from "./types.js";

// ---------------------------------------------------------------------------
// __dirname equivalent for ESM
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpError(statusCode: number, message: string): never {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  throw err;
}

// ---------------------------------------------------------------------------
// buildApp
// ---------------------------------------------------------------------------

export async function buildApp(opts: {
  pool: Pool;
  adminKey: string;
  escrow?: ArenaEscrow;
  swarmtrade?: SwarmTradeIntegration;
  logger?: boolean;
}): Promise<{ app: FastifyInstance; engine: GameEngine; feed: SpectatorFeed }> {
  const { pool, adminKey } = opts;
  const escrow = opts.escrow ?? new ArenaEscrow(process.env.ESCROW_WALLET_PRIVATE_KEY);
  const swarmtrade = opts.swarmtrade;

  const app = Fastify({ logger: opts.logger ?? false });
  const repo = new ArenaRepo(pool);
  const feed = new SpectatorFeed();
  const engine = new GameEngine(
    repo,
    (arenaId, event) => feed.broadcast(arenaId, event),
    escrow,
    swarmtrade,
  );

  // -----------------------------------------------------------------------
  // Plugins
  // -----------------------------------------------------------------------

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyRateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(fastifyCookie);
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
    decorateReply: false,
  });

  // -----------------------------------------------------------------------
  // Health monitoring (Slack alerts on high error rates)
  // -----------------------------------------------------------------------

  setupHealthMonitoring(app);

  // -----------------------------------------------------------------------
  // Error handler
  // -----------------------------------------------------------------------

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    reply.status(statusCode).send({
      error: error.message,
      statusCode,
    });
  });

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    escrow: escrow.isEnabled() ? "enabled" : "mock",
    wallet: escrow.getWalletAddress() ?? "none",
  }));

  // -----------------------------------------------------------------------
  // Admin routes
  // -----------------------------------------------------------------------

  function requireAdmin(request: FastifyRequest): void {
    const key = request.headers["x-admin-key"];
    if (key !== adminKey) {
      httpError(403, "Invalid or missing admin key");
    }
  }

  // POST /admin/arenas — create arena
  app.post("/admin/arenas", async (request, reply) => {
    requireAdmin(request);
    const body = request.body as CreateArenaParams;
    if (!body?.entry_fee_wei) {
      httpError(400, "entry_fee_wei is required");
    }
    const maxPlayers = body.max_players ?? 8;
    if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
      httpError(400, `max_players must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
    }
    // Auto-generate scaled config if none provided
    if (!body.config) {
      body.config = scaleConfig(maxPlayers);
    }
    const arena = await repo.createArena(body);
    reply.status(201).send(arena);
  });

  // POST /admin/arenas/:id/open — open arena for joining
  app.post<{ Params: { id: string } }>(
    "/admin/arenas/:id/open",
    async (request, reply) => {
      requireAdmin(request);
      const arena = await repo.getArena(request.params.id);
      if (!arena) httpError(404, "Arena not found");
      if (arena.status !== "created") {
        httpError(400, `Arena is '${arena.status}', expected 'created'`);
      }
      const updated = await repo.updateArena(arena.id, { status: "open" });
      reply.send(updated);
    },
  );

  // POST /admin/arenas/:id/payout — trigger winner payout
  app.post<{ Params: { id: string } }>(
    "/admin/arenas/:id/payout",
    async (request, reply) => {
      requireAdmin(request);
      const arena = await repo.getArena(request.params.id);
      if (!arena) httpError(404, "Arena not found");
      if (arena.status !== "complete") {
        httpError(400, `Arena is '${arena.status}', expected 'complete'`);
      }
      if (!arena.winner_id) {
        httpError(400, "Arena has no winner");
      }

      // Get pending payouts for this arena
      const allPayouts = await repo.getPayouts(arena.id);
      const pendingPayouts = allPayouts.filter((p) => p.status === "pending");

      if (pendingPayouts.length === 0) {
        return { status: "no_pending_payouts", payouts: [] };
      }

      const results: Array<{
        payout_id: number;
        agent_id: string;
        amount_wei: string;
        tx_hash?: string;
        error?: string;
      }> = [];

      for (const payout of pendingPayouts) {
        // Skip rake payouts (platform keeps those)
        if (payout.type === "rake") {
          results.push({
            payout_id: payout.id,
            agent_id: payout.agent_id,
            amount_wei: payout.amount_wei,
            tx_hash: "rake:retained",
          });
          await repo.updatePayoutStatus(payout.id, "confirmed", "rake:retained");
          continue;
        }

        try {
          const { txHash } = await escrow.sendPayout({
            to: payout.agent_id,
            amountWei: payout.amount_wei,
            chainId: arena.chain_id,
          });
          await repo.updatePayoutStatus(payout.id, "sent", txHash);
          results.push({
            payout_id: payout.id,
            agent_id: payout.agent_id,
            amount_wei: payout.amount_wei,
            tx_hash: txHash,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await repo.updatePayoutStatus(payout.id, "failed");
          results.push({
            payout_id: payout.id,
            agent_id: payout.agent_id,
            amount_wei: payout.amount_wei,
            error: errorMsg,
          });
        }
      }

      return { status: "processed", payouts: results };
    },
  );

  // GET /admin/wallet — platform wallet info
  app.get("/admin/wallet", async (request) => {
    requireAdmin(request);
    const address = escrow.getWalletAddress();
    return {
      enabled: escrow.isEnabled(),
      address: address ?? null,
    };
  });

  // -----------------------------------------------------------------------
  // Admin dashboard — cookie auth
  // -----------------------------------------------------------------------

  const ADMIN_COOKIE = "abs_session";
  const serverStartedAt = new Date().toISOString();

  function requireAdminCookie(request: FastifyRequest): void {
    const cookie = request.cookies[ADMIN_COOKIE];
    if (cookie !== adminKey) {
      // Also accept header-based auth for backward compat
      const headerKey = request.headers["x-admin-key"];
      if (headerKey !== adminKey) {
        httpError(401, "Not authenticated");
      }
    }
  }

  // POST /admin/login — set session cookie
  app.post("/admin/login", async (request, reply) => {
    const body = request.body as { key?: string };
    if (!body?.key || body.key !== adminKey) {
      httpError(401, "Invalid admin key");
    }
    reply
      .setCookie(ADMIN_COOKIE, adminKey, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        maxAge: 86400, // 24 hours
      })
      .send({ success: true });
  });

  // GET /admin/session — check if authenticated
  app.get("/admin/session", async (request) => {
    requireAdminCookie(request);
    return { authenticated: true };
  });

  // POST /admin/logout
  app.post("/admin/logout", async (_request, reply) => {
    reply
      .clearCookie(ADMIN_COOKIE, { path: "/" })
      .send({ success: true });
  });

  // -----------------------------------------------------------------------
  // Admin dashboard — analytics endpoints
  // -----------------------------------------------------------------------

  // GET /admin/stats — aggregate overview stats
  app.get("/admin/stats", async (request) => {
    requireAdminCookie(request);

    const arenaStats = await pool.query(`
      SELECT
        COUNT(*)::int as total_arenas,
        COUNT(*) FILTER (WHERE status = 'running')::int as active_arenas,
        COUNT(*) FILTER (WHERE status = 'open')::int as open_arenas,
        COUNT(*) FILTER (WHERE status = 'complete')::int as completed_arenas,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int as cancelled_arenas,
        COALESCE(SUM(prize_pool_wei) FILTER (WHERE status = 'complete'), 0)::text as total_prize_distributed,
        COALESCE(AVG(EXTRACT(epoch FROM (completed_at - started_at)))
          FILTER (WHERE status = 'complete' AND completed_at IS NOT NULL AND started_at IS NOT NULL), 0) as avg_duration_s
      FROM arenas
    `);

    const agentStats = await pool.query(
      `SELECT COUNT(DISTINCT agent_id)::int as unique_agents FROM arena_players`
    );

    const rakeStats = await pool.query(`
      SELECT COALESCE(SUM(amount_wei), 0)::text as total_rake
      FROM arena_payouts WHERE type = 'rake' AND status IN ('sent', 'confirmed')
    `);

    const payoutStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int as pending_payouts,
        COUNT(*) FILTER (WHERE status = 'failed')::int as failed_payouts
      FROM arena_payouts
    `);

    // Arena creation by day (last 30 days)
    const creationByDay = await pool.query(`
      SELECT DATE(created_at) as day, COUNT(*)::int as count
      FROM arenas
      WHERE created_at >= now() - interval '30 days'
      GROUP BY DATE(created_at)
      ORDER BY day
    `);

    // Status distribution
    const statusDist = await pool.query(`
      SELECT status, COUNT(*)::int as count
      FROM arenas GROUP BY status
    `);

    // Player count distribution
    const playerDist = await pool.query(`
      SELECT max_players, COUNT(*)::int as count
      FROM arenas GROUP BY max_players ORDER BY max_players
    `);

    return {
      arenas: arenaStats.rows[0],
      agents: agentStats.rows[0],
      rake: rakeStats.rows[0],
      payouts: payoutStats.rows[0],
      creation_by_day: creationByDay.rows,
      status_distribution: statusDist.rows,
      player_distribution: playerDist.rows,
    };
  });

  // GET /admin/stats/revenue — daily revenue time series
  app.get("/admin/stats/revenue", async (request) => {
    requireAdminCookie(request);
    const { rows } = await pool.query(`
      SELECT
        DATE(created_at) as day,
        SUM(amount_wei)::text as rake_wei,
        COUNT(*)::int as payout_count
      FROM arena_payouts
      WHERE type = 'rake'
      GROUP BY DATE(created_at)
      ORDER BY day
    `);
    return { revenue: rows };
  });

  // GET /admin/stats/agents — agent leaderboard
  app.get("/admin/stats/agents", async (request) => {
    requireAdminCookie(request);
    const { rows } = await pool.query(`
      SELECT
        p.agent_id,
        array_agg(DISTINCT p.display_name) as names_used,
        COUNT(DISTINCT p.arena_id)::int as arenas_played,
        COUNT(*) FILTER (WHERE p.status = 'winner')::int as wins,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE p.status = 'winner') / COUNT(*), 1)
          ELSE 0 END as win_rate,
        ROUND(AVG(COALESCE(p.eliminated_round, a.current_round)), 1) as avg_survival_round,
        COALESCE((SELECT COUNT(*)::int FROM arena_messages m WHERE m.sender_id = p.agent_id), 0) as total_messages,
        SUM(p.vote_count)::int as total_votes_received
      FROM arena_players p
      JOIN arenas a ON a.id = p.arena_id
      GROUP BY p.agent_id
      ORDER BY wins DESC, win_rate DESC
    `);
    return { agents: rows };
  });

  // GET /admin/arenas/:id/detail — deep arena view
  app.get<{ Params: { id: string } }>(
    "/admin/arenas/:id/detail",
    async (request) => {
      requireAdminCookie(request);
      const arena = await repo.getArena(request.params.id);
      if (!arena) httpError(404, "Arena not found");

      const players = await repo.getPlayers(arena.id);
      const voteHistory = await repo.getVoteHistory(arena.id);
      const payouts = await repo.getPayouts(arena.id);

      // Build round summaries
      const rounds: Array<{
        round: number;
        message_count: number;
        dm_count: number;
        public_count: number;
        votes: Record<string, number>;
        vote_detail: Record<string, string>;
        eliminated: string | null;
        eliminated_name: string | null;
      }> = [];

      const maxRound = arena.current_round || 0;
      for (let r = 1; r <= maxRound; r++) {
        const allMsgs = await repo.getMessages(arena.id, { round: r });
        const publicMsgs = allMsgs.filter((m) => m.recipient_id === null);
        const dmMsgs = allMsgs.filter((m) => m.recipient_id !== null);

        const roundVotes = voteHistory[r] ?? [];
        const tally: Record<string, number> = {};
        const detail: Record<string, string> = {};
        for (const v of roundVotes) {
          tally[v.target_id] = (tally[v.target_id] ?? 0) + 1;
          detail[v.voter_id] = v.target_id;
        }

        const eliminated = players.find((p) => p.eliminated_round === r);

        rounds.push({
          round: r,
          message_count: allMsgs.length,
          dm_count: dmMsgs.length,
          public_count: publicMsgs.length,
          votes: tally,
          vote_detail: detail,
          eliminated: eliminated?.agent_id ?? null,
          eliminated_name: eliminated?.display_name ?? null,
        });
      }

      return {
        arena,
        players,
        rounds,
        payouts,
        spectator_count: feed.getSpectatorCount(arena.id),
      };
    },
  );

  // GET /admin/arenas/:id/messages — paginated message log
  app.get<{
    Params: { id: string };
    Querystring: { round?: string; limit?: string; offset?: string };
  }>("/admin/arenas/:id/messages", async (request) => {
    requireAdminCookie(request);
    const arena = await repo.getArena(request.params.id);
    if (!arena) httpError(404, "Arena not found");

    const round = request.query.round
      ? parseInt(request.query.round, 10)
      : undefined;

    const messages = await repo.getMessages(arena.id, { round });
    const limit = Math.min(
      parseInt(request.query.limit ?? "100", 10) || 100,
      500,
    );
    const offset = parseInt(request.query.offset ?? "0", 10) || 0;

    return {
      messages: messages.slice(offset, offset + limit),
      total: messages.length,
    };
  });

  // GET /admin/arenas/:id/votes — vote detail per round
  app.get<{
    Params: { id: string };
    Querystring: { round?: string };
  }>("/admin/arenas/:id/votes", async (request) => {
    requireAdminCookie(request);
    const arena = await repo.getArena(request.params.id);
    if (!arena) httpError(404, "Arena not found");

    if (request.query.round) {
      const round = parseInt(request.query.round, 10);
      const votes = await repo.getVotes(arena.id, round);
      return { round, votes };
    }

    const allVotes = await repo.getVoteHistory(arena.id);
    return { votes: allVotes };
  });

  // GET /admin/agents — agent list with stats
  app.get<{
    Querystring: { limit?: string; offset?: string };
  }>("/admin/agents", async (request) => {
    requireAdminCookie(request);
    const limit = Math.min(
      parseInt(request.query.limit ?? "50", 10) || 50,
      200,
    );
    const offset = parseInt(request.query.offset ?? "0", 10) || 0;

    const { rows } = await pool.query(`
      SELECT
        p.agent_id,
        array_agg(DISTINCT p.display_name) as names_used,
        COUNT(DISTINCT p.arena_id)::int as arenas_played,
        COUNT(*) FILTER (WHERE p.status = 'winner')::int as wins,
        MAX(p.joined_at) as last_seen
      FROM arena_players p
      GROUP BY p.agent_id
      ORDER BY arenas_played DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT agent_id)::int as total FROM arena_players`
    );

    return { agents: rows, total: countResult.rows[0].total };
  });

  // GET /admin/agents/:id — single agent profile
  app.get<{ Params: { id: string } }>(
    "/admin/agents/:id",
    async (request) => {
      requireAdminCookie(request);
      const agentId = request.params.id;

      // Agent summary
      const { rows: summary } = await pool.query(`
        SELECT
          p.agent_id,
          array_agg(DISTINCT p.display_name) as names_used,
          COUNT(DISTINCT p.arena_id)::int as arenas_played,
          COUNT(*) FILTER (WHERE p.status = 'winner')::int as wins,
          COUNT(*) FILTER (WHERE p.status = 'eliminated')::int as losses,
          ROUND(AVG(COALESCE(p.eliminated_round, a.current_round)), 1) as avg_survival_round
        FROM arena_players p
        JOIN arenas a ON a.id = p.arena_id
        WHERE p.agent_id = $1
        GROUP BY p.agent_id
      `, [agentId]);

      if (summary.length === 0) httpError(404, "Agent not found");

      // Arena history
      const { rows: history } = await pool.query(`
        SELECT
          p.arena_id, p.status, p.eliminated_round, p.vote_count, p.joined_at,
          a.max_players, a.entry_fee_wei, a.prize_pool_wei, a.status as arena_status,
          a.created_at as arena_created
        FROM arena_players p
        JOIN arenas a ON a.id = p.arena_id
        WHERE p.agent_id = $1
        ORDER BY p.joined_at DESC
      `, [agentId]);

      // Messaging stats
      const { rows: msgStats } = await pool.query(`
        SELECT
          COUNT(*)::int as total_messages,
          COUNT(*) FILTER (WHERE recipient_id IS NULL)::int as public_messages,
          COUNT(*) FILTER (WHERE recipient_id IS NOT NULL)::int as dms,
          ROUND(AVG(CHAR_LENGTH(content)), 0)::int as avg_length
        FROM arena_messages
        WHERE sender_id = $1
      `, [agentId]);

      // Voting patterns: who this agent votes for most
      const { rows: voteTargets } = await pool.query(`
        SELECT target_id, COUNT(*)::int as times
        FROM arena_votes WHERE voter_id = $1
        GROUP BY target_id ORDER BY times DESC LIMIT 10
      `, [agentId]);

      // Who votes against this agent most
      const { rows: votedBy } = await pool.query(`
        SELECT voter_id, COUNT(*)::int as times
        FROM arena_votes WHERE target_id = $1
        GROUP BY voter_id ORDER BY times DESC LIMIT 10
      `, [agentId]);

      // SwarmTrade reputation
      let swarmtradeProfile = null;
      if (swarmtrade) {
        try {
          swarmtradeProfile = await swarmtrade.getAgentProfile(agentId);
        } catch { /* graceful degradation */ }
      }

      return {
        agent: summary[0],
        history,
        messaging: msgStats[0],
        vote_targets: voteTargets,
        voted_by: votedBy,
        swarmtrade: swarmtradeProfile,
      };
    },
  );

  // GET /admin/payouts — filterable payout list
  app.get<{
    Querystring: {
      status?: string;
      type?: string;
      limit?: string;
      offset?: string;
    };
  }>("/admin/payouts", async (request) => {
    requireAdminCookie(request);
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (request.query.status) {
      const statuses = request.query.status.split(",");
      const placeholders = statuses.map(() => `$${paramIdx++}`);
      conditions.push(`p.status IN (${placeholders.join(",")})`);
      values.push(...statuses);
    }
    if (request.query.type) {
      conditions.push(`p.type = $${paramIdx++}`);
      values.push(request.query.type);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const limit = Math.min(
      parseInt(request.query.limit ?? "100", 10) || 100,
      500,
    );
    const offset = parseInt(request.query.offset ?? "0", 10) || 0;

    const { rows } = await pool.query(
      `SELECT p.*, a.entry_fee_wei, a.chain_id, a.max_players
       FROM arena_payouts p
       JOIN arenas a ON a.id = p.arena_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...values, limit, offset],
    );

    const countResult = await pool.query(
      `SELECT COUNT(*)::int as total FROM arena_payouts p ${where}`,
      values,
    );

    return { payouts: rows, total: countResult.rows[0].total };
  });

  // POST /admin/payouts/:id/retry — retry a failed payout
  app.post<{ Params: { id: string } }>(
    "/admin/payouts/:id/retry",
    async (request) => {
      requireAdminCookie(request);
      const payoutId = parseInt(request.params.id, 10);

      const { rows } = await pool.query(
        `SELECT p.*, a.chain_id FROM arena_payouts p
         JOIN arenas a ON a.id = p.arena_id
         WHERE p.id = $1`,
        [payoutId],
      );
      if (rows.length === 0) httpError(404, "Payout not found");

      const payout = rows[0];
      if (payout.status !== "failed") {
        httpError(400, `Payout status is '${payout.status}', expected 'failed'`);
      }

      // Skip rake payouts
      if (payout.type === "rake") {
        await repo.updatePayoutStatus(payoutId, "confirmed", "rake:retained");
        return { status: "confirmed", tx_hash: "rake:retained" };
      }

      try {
        const { txHash } = await escrow.sendPayout({
          to: payout.agent_id,
          amountWei: String(payout.amount_wei),
          chainId: payout.chain_id,
        });
        await repo.updatePayoutStatus(payoutId, "sent", txHash);
        return { status: "sent", tx_hash: txHash };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { status: "failed", error: errorMsg };
      }
    },
  );

  // GET /admin/system — system health
  app.get("/admin/system", async (request) => {
    requireAdminCookie(request);

    // Count active SSE connections across all arenas
    let totalConnections = 0;
    const runningArenas = await repo.listArenas({ status: "running" });
    for (const arena of runningArenas) {
      totalConnections += feed.getSpectatorCount(arena.id);
    }

    // Migration status
    let migrations: Array<{ name: string; applied_at: string }> = [];
    try {
      const { rows } = await pool.query(
        `SELECT name, applied_at FROM schema_migrations ORDER BY name`
      );
      migrations = rows.map((r) => ({
        name: r.name,
        applied_at: new Date(r.applied_at).toISOString(),
      }));
    } catch { /* table might not exist yet */ }

    // SwarmTrade status
    let swarmtradeStatus = "not_configured";
    if (swarmtrade) {
      try {
        const rep = await swarmtrade.getAgentReputation("__health_check__");
        swarmtradeStatus = rep === null ? "reachable" : "reachable";
      } catch {
        swarmtradeStatus = "unreachable";
      }
    }

    return {
      server: {
        started_at: serverStartedAt,
        uptime_s: Math.floor(
          (Date.now() - new Date(serverStartedAt).getTime()) / 1000,
        ),
        node_version: process.version,
        env: process.env.NODE_ENV ?? "development",
      },
      escrow: {
        enabled: escrow.isEnabled(),
        wallet: escrow.getWalletAddress() ?? null,
      },
      game_loop: {
        tick_interval_s: 5,
        running_arenas: runningArenas.length,
      },
      sse_connections: totalConnections,
      migrations,
      swarmtrade: {
        status: swarmtradeStatus,
        base_url: swarmtrade?.getBaseUrl?.() ?? null,
      },
    };
  });

  // GET /admin/wallet/balance — live on-chain balance (placeholder, requires RPC call)
  app.get("/admin/wallet/balance", async (request) => {
    requireAdminCookie(request);
    const address = escrow.getWalletAddress();
    if (!address) {
      return { balance: null, error: "Escrow not enabled" };
    }
    // For now return the address; live balance query requires viem publicClient
    // which we can add when needed
    return {
      address,
      balance: null,
      note: "Live balance query not yet implemented — check basescan.org",
    };
  });

  // -----------------------------------------------------------------------
  // Public routes (no auth)
  // -----------------------------------------------------------------------

  // GET /arenas — list arenas
  app.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/arenas", async (request) => {
    const { status, limit: limitStr, offset: offsetStr } = request.query;
    const limit = Math.min(Math.max(parseInt(limitStr ?? "20", 10) || 20, 1), 100);
    const offset = Math.max(parseInt(offsetStr ?? "0", 10) || 0, 0);

    let statusFilter: ArenaStatus[] | undefined;
    if (status) {
      statusFilter = status.split(",").map((s) => s.trim()) as ArenaStatus[];
    }

    const allArenas = statusFilter
      ? await repo.listArenas({ status: statusFilter })
      : await repo.listArenas();

    return {
      arenas: allArenas.slice(offset, offset + limit),
      total: allArenas.length,
    };
  });

  // GET /arenas/:id — arena detail (with optional SwarmTrade trust scores)
  app.get<{ Params: { id: string } }>(
    "/arenas/:id",
    async (request) => {
      const arena = await repo.getArena(request.params.id);
      if (!arena) httpError(404, "Arena not found");

      const players = await repo.getPlayers(arena.id);

      const phaseRemainingS =
        arena.phase_ends_at
          ? Math.max(
              0,
              Math.floor(
                (new Date(arena.phase_ends_at).getTime() - Date.now()) / 1000,
              ),
            )
          : null;

      // Enrich players with SwarmTrade trust scores (graceful degradation)
      let enrichedPlayers = players.map((p) => ({
        ...p,
        swarmtrade_trust_score: null as number | null,
      }));

      if (swarmtrade) {
        const profiles = await Promise.allSettled(
          players.map((p) => swarmtrade.getAgentReputation(p.agent_id)),
        );
        enrichedPlayers = players.map((p, i) => {
          const result = profiles[i];
          const rep =
            result.status === "fulfilled" ? result.value : null;
          return {
            ...p,
            swarmtrade_trust_score: rep?.trust_score ?? null,
          };
        });
      }

      return {
        arena,
        players: enrichedPlayers,
        current_round: arena.current_round,
        current_phase: arena.current_phase,
        phase_ends_at: arena.phase_ends_at,
        phase_remaining_s: phaseRemainingS,
      };
    },
  );

  // GET /arenas/:id/players-profile — players with SwarmTrade reputation data
  app.get<{ Params: { id: string } }>(
    "/arenas/:id/players-profile",
    async (request) => {
      const arena = await repo.getArena(request.params.id);
      if (!arena) httpError(404, "Arena not found");

      const players = await repo.getPlayers(arena.id);

      const profileData = await Promise.allSettled(
        players.map((p) =>
          swarmtrade
            ? swarmtrade.getAgentProfile(p.agent_id)
            : Promise.resolve(null),
        ),
      );

      const result = players.map((p, i) => {
        const profileResult = profileData[i];
        const profile =
          profileResult.status === "fulfilled"
            ? profileResult.value
            : null;
        return {
          agent_id: p.agent_id,
          display_name: p.display_name,
          status: p.status,
          swarmtrade: profile
            ? {
                trust_score: profile.trust_score,
                total_trades: profile.total_trades,
                avg_rating: profile.avg_rating,
              }
            : null,
        };
      });

      return { players: result };
    },
  );

  // -----------------------------------------------------------------------
  // Agent routes (require x-agent-id)
  // -----------------------------------------------------------------------

  function getAgentId(request: FastifyRequest): string {
    const agentId = request.headers["x-agent-id"] as string | undefined;
    if (!agentId) httpError(400, "Missing x-agent-id header");
    return agentId;
  }

  // POST /arenas/:id/join
  app.post<{
    Params: { id: string };
    Body: { display_name: string; deposit_tx_hash?: string };
  }>("/arenas/:id/join", async (request, reply) => {
    const agentId = getAgentId(request);
    const arena = await repo.getArena(request.params.id);
    if (!arena) httpError(404, "Arena not found");
    if (arena.status !== "open") {
      httpError(403, `Arena is '${arena.status}', not open for joining`);
    }

    const body = request.body as {
      display_name: string;
      deposit_tx_hash?: string;
    };
    if (!body?.display_name) httpError(400, "display_name is required");

    // Deposit verification
    if (escrow.isEnabled()) {
      if (!body.deposit_tx_hash) {
        httpError(400, "deposit_tx_hash required when escrow is enabled");
      }
      const result = await escrow.verifyDeposit({
        txHash: body.deposit_tx_hash,
        expectedAmount: arena.entry_fee_wei,
        chainId: arena.chain_id,
      });
      if (!result.verified) {
        httpError(402, result.error ?? "Deposit verification failed");
      }
    }

    // Check for duplicate join
    const existingPlayers = await repo.getPlayers(arena.id);
    if (existingPlayers.some((p) => p.agent_id === agentId)) {
      httpError(409, "Agent already joined this arena");
    }

    // Add player
    await repo.addPlayer(arena.id, {
      agent_id: agentId,
      display_name: body.display_name,
      deposit_tx_hash: body.deposit_tx_hash,
    });

    const playerCount = await repo.getPlayerCount(arena.id);

    // Check if arena is now full
    if (playerCount >= arena.max_players) {
      await repo.updateArena(arena.id, { status: "full" });
      await engine.startArena(arena.id);
    }

    reply.status(201).send({
      status: "joined",
      players_count: playerCount,
      max_players: arena.max_players,
    });
  });

  // POST /arenas/:id/message
  app.post<{
    Params: { id: string };
    Body: { content: string; recipient_id?: string };
  }>("/arenas/:id/message", async (request) => {
    const agentId = getAgentId(request);
    const arena = await repo.getArena(request.params.id);
    if (!arena) httpError(404, "Arena not found");
    if (arena.status !== "running") {
      httpError(403, "Arena is not running");
    }
    if (arena.current_phase !== "alliance") {
      httpError(403, "Messages can only be sent during the alliance phase");
    }

    // Verify agent is active
    const players = await repo.getActivePlayers(arena.id);
    const sender = players.find((p) => p.agent_id === agentId);
    if (!sender) httpError(403, "Agent is not an active player in this arena");

    const body = request.body as { content: string; recipient_id?: string };
    if (!body?.content) httpError(400, "content is required");
    if (body.content.length > 500) {
      httpError(400, "Message content exceeds 500 character limit");
    }

    // Rate limit: max 10 messages per phase per agent
    const msgCount = await repo.getMessageCountForPhase(
      arena.id,
      arena.current_round,
      agentId,
    );
    if (msgCount >= 10) {
      httpError(429, "Message limit reached for this phase (max 10)");
    }

    // Validate recipient if DM
    if (body.recipient_id) {
      const recipient = players.find(
        (p) => p.agent_id === body.recipient_id,
      );
      if (!recipient) {
        httpError(404, "Recipient is not an active player");
      }
    }

    const message = await repo.addMessage(arena.id, arena.current_round, {
      agent_id: agentId,
      content: body.content,
      recipient_id: body.recipient_id,
    });

    // Broadcast to spectators
    if (body.recipient_id) {
      feed.broadcast(arena.id, {
        event: "dm_sent",
        data: {
          round: arena.current_round,
          from: agentId,
          to: body.recipient_id,
        },
      });
    } else {
      feed.broadcast(arena.id, {
        event: "public_message",
        data: {
          round: arena.current_round,
          sender: agentId,
          sender_name: sender.display_name,
          content: body.content,
        },
      });
    }

    return {
      message_id: message.id,
      type: body.recipient_id ? ("dm" as const) : ("public" as const),
    };
  });

  // POST /arenas/:id/vote
  app.post<{
    Params: { id: string };
    Body: { target_id: string };
  }>("/arenas/:id/vote", async (request) => {
    const agentId = getAgentId(request);
    const arena = await repo.getArena(request.params.id);
    if (!arena) httpError(404, "Arena not found");
    if (arena.status !== "running") {
      httpError(403, "Arena is not running");
    }
    if (arena.current_phase !== "voting") {
      httpError(403, "Votes can only be cast during the voting phase");
    }

    // Verify agent is active
    const players = await repo.getActivePlayers(arena.id);
    const voter = players.find((p) => p.agent_id === agentId);
    if (!voter) httpError(403, "Agent is not an active player in this arena");

    const body = request.body as { target_id: string };
    if (!body?.target_id) httpError(400, "target_id is required");

    // Cannot vote for self
    if (body.target_id === agentId) {
      httpError(400, "Cannot vote for yourself");
    }

    // Target must be active
    const target = players.find((p) => p.agent_id === body.target_id);
    if (!target) {
      httpError(404, "Target is not an active player");
    }

    // Check duplicate vote
    const alreadyVoted = await repo.hasVoted(
      arena.id,
      arena.current_round,
      agentId,
    );
    if (alreadyVoted) {
      httpError(409, "Agent has already voted this round");
    }

    await repo.castVote(arena.id, arena.current_round, {
      agent_id: agentId,
      target_id: body.target_id,
    });

    feed.broadcast(arena.id, {
      event: "vote_cast",
      data: {
        round: arena.current_round,
        voter: agentId,
      },
    });

    return { status: "vote_cast" };
  });

  // GET /arenas/:id/state — agent-specific view
  app.get<{
    Params: { id: string };
  }>("/arenas/:id/state", async (request) => {
    const agentId = getAgentId(request);
    const arena = await repo.getArena(request.params.id);
    if (!arena) httpError(404, "Arena not found");

    // Verify agent is a player (any status)
    const allPlayers = await repo.getPlayers(arena.id);
    const self = allPlayers.find((p) => p.agent_id === agentId);
    if (!self) httpError(403, "Agent is not a player in this arena");

    const activePlayers = allPlayers.filter(
      (p) => p.status === "active" || p.status === "registered",
    );
    const eliminatedPlayers = allPlayers.filter(
      (p) => p.status === "eliminated",
    );

    // Messages visible to this agent (public + own DMs)
    const messages = await repo.getAgentMessages(arena.id, agentId);
    const publicMessages = messages
      .filter((m) => m.recipient_id === null)
      .map((m) => {
        const senderPlayer = allPlayers.find(
          (p) => p.agent_id === m.sender_id,
        );
        return {
          round: m.round,
          sender_id: m.sender_id,
          sender_name: senderPlayer?.display_name ?? m.sender_id,
          content: m.content,
          created_at: m.created_at,
        };
      });

    const myDms = messages
      .filter((m) => m.recipient_id !== null)
      .map((m) => ({
        round: m.round,
        from: m.sender_id,
        to: m.recipient_id!,
        content: m.content,
        created_at: m.created_at,
      }));

    // Vote history: full detail for past rounds, own vote for current
    const voteHistory = await repo.getVoteHistory(arena.id);
    const pastVoteHistory: AgentStateView["vote_history"] = [];
    const myVotes: AgentStateView["my_votes"] = [];

    for (const [roundStr, roundVotes] of Object.entries(voteHistory)) {
      const round = parseInt(roundStr, 10);

      // Record agent's own vote for every round
      const myVote = roundVotes.find((v) => v.voter_id === agentId);
      if (myVote) {
        myVotes.push({ round, target_id: myVote.target_id });
      }

      // Full vote detail only for past rounds (not current)
      if (round < arena.current_round) {
        const tally: Record<string, number> = {};
        const detail: Record<string, string> = {};
        for (const v of roundVotes) {
          tally[v.target_id] = (tally[v.target_id] ?? 0) + 1;
          detail[v.voter_id] = v.target_id;
        }
        const eliminated = eliminatedPlayers.find(
          (p) => p.eliminated_round === round,
        );
        pastVoteHistory.push({
          round,
          eliminated: eliminated?.agent_id ?? "",
          votes: tally,
          vote_detail: detail,
        });
      }
    }

    const stateView: AgentStateView = {
      arena_id: arena.id,
      agent_id: agentId,
      status: arena.status,
      current_round: arena.current_round,
      current_phase: arena.current_phase,
      phase_ends_at: arena.phase_ends_at,
      active_players: activePlayers.map((p) => ({
        agent_id: p.agent_id,
        display_name: p.display_name,
      })),
      eliminated_players: eliminatedPlayers.map((p) => ({
        agent_id: p.agent_id,
        display_name: p.display_name,
        eliminated_round: p.eliminated_round!,
      })),
      public_messages: publicMessages,
      my_dms: myDms,
      vote_history: pastVoteHistory,
      my_votes: myVotes,
    };

    return stateView;
  });

  // -----------------------------------------------------------------------
  // Spectator routes
  // -----------------------------------------------------------------------

  // GET /arenas/:id/spectate — SSE stream
  app.get<{ Params: { id: string } }>(
    "/arenas/:id/spectate",
    async (request, reply) => {
      const arena = await repo.getArena(request.params.id);
      if (!arena) httpError(404, "Arena not found");

      // Set SSE headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send initial state
      const players = await repo.getActivePlayers(arena.id);
      const initialEvent = `event: phase_start\ndata: ${JSON.stringify({
        round: arena.current_round,
        phase: arena.current_phase,
        ends_at: arena.phase_ends_at,
        active_players: players.map((p) => p.agent_id),
      })}\n\n`;
      reply.raw.write(initialEvent);

      // Register connection
      feed.addConnection(arena.id, reply);

      // Keep-alive ping every 30 seconds
      const keepAlive = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n");
        } catch {
          clearInterval(keepAlive);
        }
      }, 30_000);

      // Clean up on disconnect
      request.raw.on("close", () => {
        clearInterval(keepAlive);
        feed.removeConnection(arena.id, reply);
      });

      // Prevent Fastify from auto-closing the response
      await reply.hijack();
    },
  );

  // GET /arenas/:id/recap — full replay of a completed arena
  app.get<{ Params: { id: string } }>(
    "/arenas/:id/recap",
    async (request) => {
      const arena = await repo.getArena(request.params.id);
      if (!arena) httpError(404, "Arena not found");
      if (arena.status !== "complete") {
        httpError(400, "Recap is only available for completed arenas");
      }

      const allPlayers = await repo.getPlayers(arena.id);
      const voteHistory = await repo.getVoteHistory(arena.id);

      const rounds: Array<{
        round: number;
        public_messages: Array<{
          sender_id: string;
          sender_name: string;
          content: string;
          created_at: string;
        }>;
        votes: Record<string, number>;
        eliminated: string;
        revealed_dms: Array<{
          from: string;
          to: string;
          content: string;
        }>;
      }> = [];

      // Build round data for every round played
      const maxRound = arena.current_round;
      for (let r = 1; r <= maxRound; r++) {
        const roundMessages = await repo.getMessages(arena.id, {
          round: r,
          publicOnly: true,
        });
        const allRoundMessages = await repo.getMessages(arena.id, { round: r });

        const roundVotes = voteHistory[r] ?? [];
        const tally: Record<string, number> = {};
        for (const v of roundVotes) {
          tally[v.target_id] = (tally[v.target_id] ?? 0) + 1;
        }

        const eliminated = allPlayers.find(
          (p) => p.eliminated_round === r,
        );

        // Revealed DMs (from eliminated player)
        const revealedDms = allRoundMessages
          .filter(
            (m) =>
              m.recipient_id !== null &&
              m.revealed &&
              m.sender_id === eliminated?.agent_id,
          )
          .map((m) => ({
            from: m.sender_id,
            to: m.recipient_id!,
            content: m.content,
          }));

        rounds.push({
          round: r,
          public_messages: roundMessages.map((m) => {
            const sender = allPlayers.find(
              (p) => p.agent_id === m.sender_id,
            );
            return {
              sender_id: m.sender_id,
              sender_name: sender?.display_name ?? m.sender_id,
              content: m.content,
              created_at: m.created_at,
            };
          }),
          votes: tally,
          eliminated: eliminated?.agent_id ?? "",
          revealed_dms: revealedDms,
        });
      }

      const winner = allPlayers.find((p) => p.status === "winner");

      return {
        arena,
        rounds,
        winner: winner
          ? { agent_id: winner.agent_id, display_name: winner.display_name }
          : null,
      };
    },
  );

  return { app, engine, feed };
}

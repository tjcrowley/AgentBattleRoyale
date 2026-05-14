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
  logger?: boolean;
}): Promise<{ app: FastifyInstance; engine: GameEngine; feed: SpectatorFeed }> {
  const { pool, adminKey } = opts;

  const app = Fastify({ logger: opts.logger ?? false });
  const repo = new ArenaRepo(pool);
  const feed = new SpectatorFeed();
  const engine = new GameEngine(repo, (arenaId, event) =>
    feed.broadcast(arenaId, event),
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

  // GET /arenas/:id — arena detail
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

      return {
        arena,
        players,
        current_round: arena.current_round,
        current_phase: arena.current_phase,
        phase_ends_at: arena.phase_ends_at,
        phase_remaining_s: phaseRemainingS,
      };
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

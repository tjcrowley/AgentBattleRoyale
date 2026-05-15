import pg from "pg";
import { buildApp } from "./build-app.js";
import { ArenaEscrow } from "./escrow.js";
import { SwarmTradeIntegration } from "./swarmtrade.js";
import { runMigrations } from "./migrate.js";

const connectionString = process.env.DATABASE_URL;
const ssl = connectionString?.includes("sslmode=require")
  ? { rejectUnauthorized: false }
  : undefined;
const pool = new pg.Pool({ connectionString, ssl });
const adminKey = process.env.ADMIN_API_KEY || "dev-admin-key";
const port = parseInt(process.env.PORT || "8080", 10);

// Run migrations before anything else
await runMigrations(pool);

const escrow = new ArenaEscrow(process.env.ESCROW_WALLET_PRIVATE_KEY);
const swarmtrade = new SwarmTradeIntegration();
const { app, engine } = await buildApp({
  pool,
  adminKey,
  escrow,
  swarmtrade,
  logger: true,
});

// Game loop: tick every 5 seconds
const gameLoop = setInterval(async () => {
  try {
    await engine.tick();
  } catch (err: any) {
    console.error("[game-loop] tick error:", err.message);
  }
}, 5000);

// Graceful shutdown
const shutdown = async () => {
  clearInterval(gameLoop);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port, host: "0.0.0.0" });

console.log("=".repeat(50));
console.log("  AI Survivor -- Agent Battle Royale");
console.log("=".repeat(50));
console.log(`  Port:       ${port}`);
console.log(`  Escrow:     ${escrow.isEnabled() ? "ENABLED" : "MOCK MODE"}`);
if (escrow.getWalletAddress()) {
  console.log(`  Wallet:     ${escrow.getWalletAddress()}`);
}
console.log(`  SwarmTrade: ${swarmtrade.getBaseUrl()}`);
console.log("  Game loop:  5s tick");
console.log("=".repeat(50));

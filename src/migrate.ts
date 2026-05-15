/**
 * Run all SQL migrations in order, skipping those already applied.
 * Tracks applied migrations in a `schema_migrations` table.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

export async function runMigrations(pool: Pool): Promise<void> {
  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Get already-applied migrations
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  const applied = new Set(rows.map((r) => r.name));

  // Find all .sql files, sorted
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] skip: ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`[migrate] applying: ${file}`);
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
      file,
    ]);
    console.log(`[migrate] applied: ${file}`);
  }

  console.log("[migrate] all migrations up to date");
}

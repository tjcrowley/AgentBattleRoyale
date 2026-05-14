/**
 * In-memory mock of pg.Pool for testing ArenaRepo without a real database.
 *
 * Supports the SQL patterns used in arena-repo.ts:
 *   - INSERT INTO ... VALUES ($1, ...) RETURNING *
 *   - SELECT ... FROM ... WHERE ... ORDER BY ...
 *   - UPDATE ... SET ... WHERE ... RETURNING *
 *   - SELECT COUNT(*)::int AS count FROM ... WHERE ...
 *   - SELECT 1 FROM ... WHERE ...
 *
 * For queries that are too complex for the naive parser, register a custom
 * handler via `pool.registerHandler(pattern, fn)`.
 */

import type { Pool, QueryResult, QueryResultRow } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Table = Row[];
type QueryHandler = (sql: string, params: unknown[]) => QueryResult;

interface MockPoolInstance {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  tables: Map<string, Table>;
  registerHandler: (pattern: RegExp, handler: QueryHandler) => void;
  reset: () => void;
  /** Auto-increment counters per table (for SERIAL/BIGSERIAL columns) */
  _sequences: Map<string, number>;
  /** Custom query handlers */
  _handlers: Array<{ pattern: RegExp; handler: QueryHandler }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/** Resolve a $N parameter reference to its value. */
function resolveParam(token: string, params: unknown[]): unknown {
  const match = token.match(/^\$(\d+)$/);
  if (match) return params[Number(match[1]) - 1];
  // Strip surrounding single quotes for string literals
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  if (token.toLowerCase() === "null") return null;
  if (token.toLowerCase() === "true") return true;
  if (token.toLowerCase() === "false") return false;
  const num = Number(token);
  if (!isNaN(num)) return num;
  return token;
}

/** Normalize SQL for easier matching: collapse whitespace, lowercase keywords. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Extract table name from a FROM/INTO/UPDATE clause. */
function extractTable(sql: string, keyword: string): string {
  const norm = normalizeSql(sql).toLowerCase();
  const idx = norm.indexOf(keyword.toLowerCase());
  if (idx === -1) throw new Error(`Could not find '${keyword}' in: ${sql}`);
  const after = normalizeSql(sql)
    .slice(idx + keyword.length)
    .trim();
  // Table name is the first word after the keyword
  const tableName = after.split(/[\s(,]/)[0];
  return tableName.toLowerCase();
}

/** Parse a simple WHERE clause into filter conditions. */
function parseWhere(
  whereClause: string,
  params: unknown[],
): Array<(row: Row) => boolean> {
  const filters: Array<(row: Row) => boolean> = [];
  // Split on AND (case-insensitive)
  const conditions = whereClause.split(/\bAND\b/i).map((c) => c.trim());

  for (const cond of conditions) {
    if (!cond) continue;

    // Handle IS NOT NULL
    const isNotNullMatch = cond.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
    if (isNotNullMatch) {
      const col = isNotNullMatch[1].toLowerCase();
      filters.push((row) => row[col] != null);
      continue;
    }

    // Handle IS NULL
    const isNullMatch = cond.match(/^(\w+)\s+IS\s+NULL$/i);
    if (isNullMatch) {
      const col = isNullMatch[1].toLowerCase();
      filters.push((row) => row[col] == null);
      continue;
    }

    // Handle IN (...)
    const inMatch = cond.match(/^(\w+)\s+IN\s*\(([^)]+)\)$/i);
    if (inMatch) {
      const col = inMatch[1].toLowerCase();
      const valueTokens = inMatch[2].split(",").map((v) => v.trim());
      const values = valueTokens.map((v) => resolveParam(v, params));
      filters.push((row) => values.some((val) => String(row[col]) === String(val)));
      continue;
    }

    // Handle <= (for timestamps like phase_ends_at <= now())
    const lteNowMatch = cond.match(/^(\w+)\s*<=\s*now\(\)$/i);
    if (lteNowMatch) {
      const col = lteNowMatch[1].toLowerCase();
      filters.push((row) => {
        if (row[col] == null) return false;
        return new Date(String(row[col])).getTime() <= Date.now();
      });
      continue;
    }

    // Handle basic col = $N or col = 'value'
    const eqMatch = cond.match(/^(\w+)\s*=\s*(.+)$/i);
    if (eqMatch) {
      const col = eqMatch[1].toLowerCase();
      const val = resolveParam(eqMatch[2].trim(), params);
      filters.push((row) => String(row[col]) === String(val));
      continue;
    }
  }

  return filters;
}

/** Apply WHERE filters to rows. */
function applyFilters(rows: Row[], filters: Array<(row: Row) => boolean>): Row[] {
  return rows.filter((row) => filters.every((f) => f(row)));
}

/** Parse SET clause for UPDATE: "col1 = $1, col2 = $2" */
function parseSet(
  setClause: string,
  params: unknown[],
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  // Split on comma, but be careful of CASE expressions
  const assignments = splitSetClause(setClause);

  for (const assignment of assignments) {
    const eqIdx = assignment.indexOf("=");
    if (eqIdx === -1) continue;
    const col = assignment.slice(0, eqIdx).trim().toLowerCase();
    const valExpr = assignment.slice(eqIdx + 1).trim();

    // Handle CASE WHEN $1 = 'confirmed' THEN now() ELSE col END
    const caseMatch = valExpr.match(/^CASE\s+WHEN\b/i);
    if (caseMatch) {
      // For the mock, evaluate the CASE simply
      const nowMatch = valExpr.match(
        /WHEN\s+\$(\d+)\s*=\s*'(\w+)'\s+THEN\s+now\(\)\s+ELSE\s+(\w+)\s+END/i,
      );
      if (nowMatch) {
        const paramVal = params[Number(nowMatch[1]) - 1];
        if (String(paramVal) === nowMatch[2]) {
          updates[col] = new Date().toISOString();
        }
        // else keep existing (ELSE col END) — handled by not setting
      }
      continue;
    }

    // Handle expressions like: prize_pool_wei + (SELECT entry_fee_wei FROM arenas WHERE id = $1)
    // For the mock, we skip these — they're handled by custom handlers or addPlayer logic
    if (valExpr.includes("SELECT") || valExpr.includes("(")) {
      // Store a marker so the caller knows to handle it
      updates[col] = { __expr: valExpr, params };
      continue;
    }

    updates[col] = resolveParam(valExpr, params);
  }

  return updates;
}

/** Split SET clause on commas, respecting CASE...END blocks. */
function splitSetClause(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of clause) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Parse INSERT column list from "INSERT INTO table (col1, col2, ...) VALUES ..." */
function parseInsertColumns(sql: string): string[] {
  const match = normalizeSql(sql).match(/\(([^)]+)\)\s*VALUES/i);
  if (!match) return [];
  return match[1].split(",").map((c) => c.trim().toLowerCase());
}

/** Parse INSERT values from "... VALUES ($1, $2, ...)" */
function parseInsertValues(sql: string, params: unknown[]): unknown[] {
  const norm = normalizeSql(sql);
  const match = norm.match(/VALUES\s*\(([^)]+)\)/i);
  if (!match) return [];
  return match[1].split(",").map((v) => resolveParam(v.trim(), params));
}

// ---------------------------------------------------------------------------
// Mock result builder
// ---------------------------------------------------------------------------

function makeResult(rows: Row[]): QueryResult {
  return {
    rows: deepClone(rows) as QueryResultRow[],
    rowCount: rows.length,
    command: "",
    oid: 0,
    fields: [],
  };
}

// ---------------------------------------------------------------------------
// createMockPool
// ---------------------------------------------------------------------------

export function createMockPool(): MockPoolInstance {
  const tables = new Map<string, Table>();
  const sequences = new Map<string, number>();
  const handlers: Array<{ pattern: RegExp; handler: QueryHandler }> = [];

  // Ensure default tables exist
  for (const t of [
    "arenas",
    "arena_players",
    "arena_messages",
    "arena_votes",
    "arena_payouts",
  ]) {
    tables.set(t, []);
  }

  // Built-in handler for the prize_pool_wei subquery UPDATE used by addPlayer.
  // The generic UPDATE regex fails because the subquery contains its own WHERE clause.
  handlers.push({
    pattern: /UPDATE arenas SET prize_pool_wei\s*=\s*prize_pool_wei\s*\+/i,
    handler(_sql: string, params: unknown[]): QueryResult {
      const arenaId = params[0];
      const table = getTable("arenas");
      const row = table.find((r) => String(r.id) === String(arenaId));
      if (row) {
        const entryFee = BigInt(String(row.entry_fee_wei ?? "0"));
        const current = BigInt(String(row.prize_pool_wei ?? "0"));
        row.prize_pool_wei = String(current + entryFee);
      }
      return makeResult([]);
    },
  });

  function nextId(table: string): number {
    const current = sequences.get(table) ?? 0;
    const next = current + 1;
    sequences.set(table, next);
    return next;
  }

  function getTable(name: string): Table {
    const key = name.toLowerCase();
    const t = tables.get(key);
    if (!t) {
      tables.set(key, []);
      return tables.get(key)!;
    }
    return t;
  }

  async function query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const norm = normalizeSql(sql);

    // Check custom handlers first
    for (const { pattern, handler } of handlers) {
      if (pattern.test(norm)) {
        return handler(sql, params);
      }
    }

    // --- INSERT ---
    if (/^\s*INSERT\s+INTO\s+/i.test(norm)) {
      const tableName = extractTable(sql, "INTO");
      const table = getTable(tableName);
      const columns = parseInsertColumns(sql);
      const values = parseInsertValues(sql, params);

      const row: Row = {};

      // Apply column values
      for (let i = 0; i < columns.length; i++) {
        row[columns[i]] = values[i] ?? null;
      }

      // Apply defaults based on table
      const now = new Date().toISOString();
      if (tableName === "arenas") {
        row.id = row.id ?? crypto.randomUUID();
        row.status = row.status ?? "created";
        row.prize_pool_wei = row.prize_pool_wei ?? "0";
        row.rake_bps = row.rake_bps ?? 1000;
        row.max_players = row.max_players ?? 8;
        row.current_round = row.current_round ?? 0;
        row.current_phase = row.current_phase ?? "waiting";
        row.phase_ends_at = row.phase_ends_at ?? null;
        row.winner_id = row.winner_id ?? null;
        row.config = row.config ?? "{}";
        row.token_address = row.token_address ?? null;
        row.scheduled_at = row.scheduled_at ?? null;
        row.created_at = row.created_at ?? now;
        row.started_at = row.started_at ?? null;
        row.completed_at = row.completed_at ?? null;
        // Parse JSON config if it's a string
        if (typeof row.config === "string") {
          try {
            row.config = JSON.parse(row.config);
          } catch {
            // leave as-is
          }
        }
      } else if (tableName === "arena_players") {
        row.status = row.status ?? "registered";
        row.eliminated_round = row.eliminated_round ?? null;
        row.vote_count = row.vote_count ?? 0;
        row.joined_at = row.joined_at ?? now;
        // Check for duplicate PK
        const existing = table.find(
          (r) => r.arena_id === row.arena_id && r.agent_id === row.agent_id,
        );
        if (existing) {
          throw new Error(
            `duplicate key value violates unique constraint "arena_players_pkey"`,
          );
        }
      } else if (tableName === "arena_messages") {
        row.id = nextId("arena_messages");
        row.revealed = row.revealed ?? false;
        row.created_at = row.created_at ?? now;
      } else if (tableName === "arena_votes") {
        row.created_at = row.created_at ?? now;
        // Check for duplicate PK (arena_id, round, voter_id)
        const existing = table.find(
          (r) =>
            r.arena_id === row.arena_id &&
            r.round === row.round &&
            r.voter_id === row.voter_id,
        );
        if (existing) {
          throw new Error(
            `duplicate key value violates unique constraint "arena_votes_pkey"`,
          );
        }
      } else if (tableName === "arena_payouts") {
        row.id = nextId("arena_payouts");
        row.status = row.status ?? "pending";
        row.tx_hash = row.tx_hash ?? null;
        row.created_at = row.created_at ?? now;
        row.confirmed_at = row.confirmed_at ?? null;
      }

      table.push(row);

      if (/RETURNING\s+\*/i.test(norm)) {
        return makeResult([row]);
      }
      return makeResult([]);
    }

    // --- UPDATE ---
    if (/^\s*UPDATE\s+/i.test(norm)) {
      const tableName = extractTable(sql, "UPDATE");
      const table = getTable(tableName);

      // Extract SET clause
      const setMatch = norm.match(/SET\s+(.+?)\s+WHERE/i);
      if (!setMatch) throw new Error(`UPDATE without SET/WHERE: ${sql}`);
      const updates = parseSet(setMatch[1], params);

      // Extract WHERE clause
      const whereMatch = norm.match(/WHERE\s+(.+?)(?:\s+RETURNING|\s*$)/i);
      if (!whereMatch) throw new Error(`UPDATE without WHERE: ${sql}`);
      const filters = parseWhere(whereMatch[1], params);

      const matched = applyFilters(table, filters);

      for (const row of matched) {
        for (const [col, val] of Object.entries(updates)) {
          if (val && typeof val === "object" && "__expr" in (val as Row)) {
            // Handle expression: prize_pool_wei + (SELECT entry_fee_wei FROM arenas WHERE id = $1)
            const expr = (val as Row).__expr as string;
            if (expr.includes("prize_pool_wei") && expr.includes("entry_fee_wei")) {
              // Self-referencing update: add entry_fee_wei to prize_pool_wei
              const entryFee = BigInt(String(row.entry_fee_wei ?? "0"));
              const current = BigInt(String(row[col] ?? "0"));
              row[col] = String(current + entryFee);
            }
          } else {
            row[col] = val;
          }
        }
      }

      if (/RETURNING\s+\*/i.test(norm)) {
        return makeResult(matched);
      }
      return makeResult([]);
    }

    // --- SELECT COUNT ---
    if (/SELECT\s+COUNT\(\*\)/i.test(norm)) {
      const tableName = extractTable(sql, "FROM");
      const table = getTable(tableName);

      const whereMatch = norm.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s*$)/i);
      let rows = table;
      if (whereMatch) {
        const filters = parseWhere(whereMatch[1], params);
        rows = applyFilters(table, filters);
      }

      return makeResult([{ count: rows.length }]);
    }

    // --- SELECT 1 (existence check) ---
    if (/SELECT\s+1\s+FROM/i.test(norm)) {
      const tableName = extractTable(sql, "FROM");
      const table = getTable(tableName);

      const whereMatch = norm.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s*$)/i);
      let rows = table;
      if (whereMatch) {
        const filters = parseWhere(whereMatch[1], params);
        rows = applyFilters(table, filters);
      }

      if (rows.length > 0) {
        return makeResult([{ "?column?": 1 }]);
      }
      return makeResult([]);
    }

    // --- SELECT ---
    if (/^\s*SELECT\s+/i.test(norm)) {
      const tableName = extractTable(sql, "FROM");
      const table = getTable(tableName);

      const whereMatch = norm.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s*$)/i);
      let rows = [...table];
      if (whereMatch) {
        const whereClause = whereMatch[1];

        // Handle OR conditions (for getAgentMessages complex WHERE)
        if (/\bOR\b/i.test(whereClause)) {
          // Split top-level on AND first, then handle OR within groups
          // For the arena_messages query pattern:
          //   arena_id = $1 AND (recipient_id IS NULL OR sender_id = $2 OR recipient_id = $2)
          const andParts = whereClause.split(/\bAND\b/i).map((p) => p.trim());
          let filtered = [...table];

          for (const part of andParts) {
            // Check if this part contains OR (possibly wrapped in parens)
            const unwrapped = part.replace(/^\(/, "").replace(/\)$/, "").trim();
            if (/\bOR\b/i.test(unwrapped)) {
              const orParts = unwrapped.split(/\bOR\b/i).map((p) => p.trim());
              const orFilters = orParts.map((op) => parseWhere(op, params));
              filtered = filtered.filter((row) =>
                orFilters.some((filterGroup) => filterGroup.every((f) => f(row))),
              );
            } else {
              const filters = parseWhere(part, params);
              filtered = applyFilters(filtered, filters);
            }
          }
          rows = filtered;
        } else {
          const filters = parseWhere(whereClause, params);
          rows = applyFilters(table, filters);
        }
      }

      // Handle ORDER BY (basic: single column ASC/DESC)
      const orderMatch = norm.match(/ORDER\s+BY\s+([\w,\s]+?)(?:\s+ASC|\s+DESC)?(?:\s*,|\s*$)/i);
      if (orderMatch) {
        const orderCol = orderMatch[1].split(",")[0].trim().toLowerCase();
        const isDesc = /DESC/i.test(norm.slice(norm.toLowerCase().indexOf("order by")));
        rows.sort((a, b) => {
          const aVal = String(a[orderCol] ?? "");
          const bVal = String(b[orderCol] ?? "");
          return isDesc ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
        });
      }

      return makeResult(rows);
    }

    throw new Error(`MockPool: unrecognized query pattern: ${sql}`);
  }

  const pool: MockPoolInstance = {
    query: query as MockPoolInstance["query"],
    tables,
    registerHandler(pattern: RegExp, handler: QueryHandler) {
      handlers.push({ pattern, handler });
    },
    reset() {
      tables.forEach((table) => {
        table.length = 0;
      });
      sequences.clear();
      handlers.length = 0;
    },
    _sequences: sequences,
    _handlers: handlers,
  };

  return pool;
}

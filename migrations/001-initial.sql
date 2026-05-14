-- AI Survivor: initial schema
-- 5 tables: arenas, arena_players, arena_messages, arena_votes, arena_payouts

BEGIN;

-- ---------------------------------------------------------------------------
-- arenas
-- ---------------------------------------------------------------------------
CREATE TABLE arenas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status          TEXT NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created','open','full','running','complete','cancelled')),
  entry_fee_wei   NUMERIC(78,0) NOT NULL,
  chain_id        TEXT NOT NULL DEFAULT '8453',
  token_address   TEXT,
  prize_pool_wei  NUMERIC(78,0) NOT NULL DEFAULT 0,
  rake_bps        INTEGER NOT NULL DEFAULT 1000,
  max_players     INTEGER NOT NULL DEFAULT 8,
  current_round   INTEGER NOT NULL DEFAULT 0,
  current_phase   TEXT NOT NULL DEFAULT 'waiting'
                  CHECK (current_phase IN ('waiting','alliance','voting','elimination','complete')),
  phase_ends_at   TIMESTAMPTZ,
  winner_id       TEXT,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_arenas_status ON arenas(status);
CREATE INDEX idx_arenas_scheduled ON arenas(scheduled_at) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- arena_players
-- ---------------------------------------------------------------------------
CREATE TABLE arena_players (
  arena_id        UUID NOT NULL REFERENCES arenas(id),
  agent_id        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  deposit_tx_hash TEXT,
  status          TEXT NOT NULL DEFAULT 'registered'
                  CHECK (status IN ('registered','active','eliminated','winner')),
  eliminated_round INTEGER,
  vote_count      INTEGER NOT NULL DEFAULT 0,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (arena_id, agent_id)
);

CREATE INDEX idx_arena_players_agent ON arena_players(agent_id);

-- ---------------------------------------------------------------------------
-- arena_messages
-- ---------------------------------------------------------------------------
CREATE TABLE arena_messages (
  id              BIGSERIAL PRIMARY KEY,
  arena_id        UUID NOT NULL REFERENCES arenas(id),
  round           INTEGER NOT NULL,
  sender_id       TEXT NOT NULL,
  recipient_id    TEXT,
  content         TEXT NOT NULL,
  revealed        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_arena_messages_arena_round ON arena_messages(arena_id, round);
CREATE INDEX idx_arena_messages_sender ON arena_messages(arena_id, sender_id);

-- ---------------------------------------------------------------------------
-- arena_votes
-- ---------------------------------------------------------------------------
CREATE TABLE arena_votes (
  arena_id        UUID NOT NULL REFERENCES arenas(id),
  round           INTEGER NOT NULL,
  voter_id        TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (arena_id, round, voter_id)
);

-- ---------------------------------------------------------------------------
-- arena_payouts
-- ---------------------------------------------------------------------------
CREATE TABLE arena_payouts (
  id              BIGSERIAL PRIMARY KEY,
  arena_id        UUID NOT NULL REFERENCES arenas(id),
  agent_id        TEXT NOT NULL,
  amount_wei      NUMERIC(78,0) NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('prize','rake')),
  tx_hash         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','confirmed','failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at    TIMESTAMPTZ
);

CREATE INDEX idx_arena_payouts_status ON arena_payouts(status);

COMMIT;

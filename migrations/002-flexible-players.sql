-- Variable player count: 8–100 players per arena
ALTER TABLE arenas ALTER COLUMN max_players SET DEFAULT 8;
ALTER TABLE arenas ADD CONSTRAINT chk_max_players CHECK (max_players >= 8 AND max_players <= 100);

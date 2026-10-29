-- Derivion CRM: Add persistent refresh_tokens table for "Remember Me" feature
-- Run once against production PostgreSQL BEFORE deploying the updated backend.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(64) NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens (token_hash);

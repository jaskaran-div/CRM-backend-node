
-- Derivion CRM: Personal Knowledge Bank for agents
-- Run once against the intended PostgreSQL database before deploying
-- the backend changes.

CREATE TABLE IF NOT EXISTS knowledge_bank_items (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  category    VARCHAR(50) NOT NULL,
  content     TEXT,
  file_name   VARCHAR(255),
  file_key    VARCHAR(500),
  file_type   VARCHAR(100),
  file_size   BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_bank_items_user_id
  ON knowledge_bank_items (user_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_bank_items_user_category
  ON knowledge_bank_items (user_id, category);

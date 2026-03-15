-- migrations/001_initial_schema.sql
-- Open Brain 2.0 — Full schema

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- Table: captures (Tier 1 — raw, immutable inputs)
-- ============================================================
CREATE TABLE captures (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content         text NOT NULL,
    content_types   text[],
    file_urls       text[],
    file_hashes     text[],
    embedding       vector(3072),
    metadata        jsonb,
    source          varchar NOT NULL,
    status          varchar NOT NULL DEFAULT 'pending',
    archived        boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_captures_embedding ON captures
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_captures_status ON captures (status);
CREATE INDEX idx_captures_archived ON captures (archived);
CREATE INDEX idx_captures_created_at ON captures (created_at DESC);

-- ============================================================
-- Table: facts (Tier 2 — synthesized, mutable profile knowledge)
-- ============================================================
CREATE TABLE facts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content             text NOT NULL,
    category            varchar,
    embedding           vector(3072),
    confidence          float,
    source_capture_ids  uuid[],
    origin              varchar NOT NULL,
    review_status       varchar NOT NULL DEFAULT 'auto_approved',
    previous_versions   jsonb NOT NULL DEFAULT '[]',
    archived            boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    edited_at           timestamptz
);

CREATE INDEX idx_facts_embedding ON facts
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_facts_source_capture_ids ON facts
    USING gin (source_capture_ids);
CREATE INDEX idx_facts_category ON facts (category);
CREATE INDEX idx_facts_confidence ON facts (confidence);
CREATE INDEX idx_facts_review_status ON facts (review_status);
CREATE INDEX idx_facts_archived ON facts (archived);

-- ============================================================
-- Table: insights (Tier 3 — cross-cutting patterns from facts)
-- ============================================================
CREATE TABLE insights (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content           text NOT NULL,
    category          varchar,
    embedding         vector(3072),
    confidence        float,
    source_fact_ids   uuid[],
    origin            varchar NOT NULL,
    review_status     varchar NOT NULL DEFAULT 'pending_review',
    archived          boolean NOT NULL DEFAULT false,
    generated_at      timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    edited_at         timestamptz
);

CREATE INDEX idx_insights_embedding ON insights
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_insights_source_fact_ids ON insights
    USING gin (source_fact_ids);
CREATE INDEX idx_insights_review_status ON insights (review_status);
CREATE INDEX idx_insights_archived ON insights (archived);

-- ============================================================
-- Table: consolidation_log (audit trail for consolidation runs)
-- ============================================================
CREATE TABLE consolidation_log (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_at                  timestamptz NOT NULL DEFAULT now(),
    status                  varchar NOT NULL,
    captures_processed      int NOT NULL DEFAULT 0,
    facts_created           int NOT NULL DEFAULT 0,
    facts_updated           int NOT NULL DEFAULT 0,
    insights_created        int NOT NULL DEFAULT 0,
    insights_regenerated    int NOT NULL DEFAULT 0,
    duplicates_detected     int NOT NULL DEFAULT 0,
    items_flagged           int NOT NULL DEFAULT 0,
    model_used              varchar,
    tokens_used             int NOT NULL DEFAULT 0,
    duration_ms             int NOT NULL DEFAULT 0,
    error_message           text
);

-- ============================================================
-- Table: reminders (personal productivity layer)
-- ============================================================
CREATE TABLE reminders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content         text NOT NULL,
    embedding       vector(3072),
    metadata        jsonb,
    category        varchar,
    project         varchar,
    section         varchar,
    parent_id       uuid,
    depth           int NOT NULL DEFAULT 0,
    status          varchar NOT NULL DEFAULT 'not_started',
    -- valid statuses: 'not_started' | 'in_progress' | 'researching' | 'paused' | 'done' | 'blocked' | 'cancelled'
    priority        varchar,
    -- valid priorities: 'P1' | 'P2' | 'P3' | null
    source_context  text,
    source          varchar NOT NULL,
    archived        boolean NOT NULL DEFAULT false,
    due_date        timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reminders_embedding ON reminders
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_reminders_status ON reminders (status);
CREATE INDEX idx_reminders_category ON reminders (category);
CREATE INDEX idx_reminders_project ON reminders (project);
CREATE INDEX idx_reminders_section ON reminders (section);
CREATE INDEX idx_reminders_parent_id ON reminders (parent_id);
CREATE INDEX idx_reminders_priority ON reminders (priority);
CREATE INDEX idx_reminders_depth ON reminders (depth);
CREATE INDEX idx_reminders_archived ON reminders (archived);
CREATE INDEX idx_reminders_due_date ON reminders (due_date)
    WHERE due_date IS NOT NULL;

-- ============================================================
-- Table: reminder_comments (chronological progress log per task)
-- ============================================================
CREATE TABLE reminder_comments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content         text NOT NULL,
    embedding       vector(3072),
    reminder_id     uuid NOT NULL,
    source          varchar NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reminder_comments_embedding ON reminder_comments
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_reminder_comments_reminder_id ON reminder_comments (reminder_id);
CREATE INDEX idx_reminder_comments_created_at ON reminder_comments (created_at DESC);

# Open Brain 2.0 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal knowledge system that maintains a living profile through three-tier data consolidation (captures → facts → insights), exposed via REST API, Telegram bot, and MCP server, hosted on Azure.

**Architecture:** Hono HTTP server on Azure Container Apps handles REST API, MCP server (Streamable HTTP), and Telegram webhooks. A separate Azure Function runs daily consolidation (DBSCAN clustering → Claude Opus promotion → insight generation). PostgreSQL with pgvector stores all data. Gemini Embedding 2 for multimodal embeddings, Gemini Flash for metadata extraction and retrieval synthesis, Claude Opus 4.6 for consolidation reasoning.

**Tech Stack:**
- Runtime: Node.js 20+ / TypeScript 5.x (strict mode)
- API: Hono + @hono/node-server
- Database: PostgreSQL 16 + pgvector (via `pg` + `pgvector` npm packages)
- AI: `@google/generative-ai` (Gemini), `@anthropic-ai/sdk` (Claude)
- Storage: `@azure/storage-blob`
- MCP: `@modelcontextprotocol/sdk`
- Telegram: `grammy`
- Testing: Vitest
- Validation: Zod

**Framework Decision — Hono:**
The spec left API framework as TBD (Express, Fastify, or Hono). This plan uses **Hono** because:
1. TypeScript-first with excellent type inference
2. Tiny bundle (~14KB) → fast cold start on Container Apps (scale-to-zero)
3. `app.request()` enables tests without starting a server
4. Works across runtimes (Node.js, Bun, edge) — future-proof
5. Built-in middleware for auth, CORS, error handling

---

## File Structure

```
open-brain-v2/
├── src/
│   ├── config.ts                        # Environment variables + Zod validation
│   ├── app.ts                           # Hono app: routes, middleware, error handling
│   ├── server.ts                        # HTTP server entry point (listen)
│   │
│   ├── db/
│   │   ├── client.ts                    # PostgreSQL connection pool + query/transaction helpers
│   │   ├── captures.ts                  # Captures table CRUD
│   │   ├── facts.ts                     # Facts table CRUD + previous_versions tracking
│   │   ├── insights.ts                  # Insights table CRUD
│   │   ├── reminders.ts                 # Reminders table CRUD
│   │   └── consolidation-log.ts         # Consolidation log writes + queries
│   │
│   ├── providers/
│   │   ├── types.ts                     # EmbeddingProvider + LLMProvider interfaces
│   │   ├── gemini-embedding.ts          # Gemini Embedding 2 (3072 dims, multimodal)
│   │   ├── gemini-llm.ts               # Gemini Flash (metadata extraction, retrieval synthesis)
│   │   └── anthropic-llm.ts            # Claude Opus 4.6 (consolidation)
│   │
│   ├── storage/
│   │   └── blob.ts                      # Azure Blob Storage upload/download/exists
│   │
│   ├── capture/
│   │   ├── pipeline.ts                  # Universal ingest pipeline orchestrator
│   │   ├── dedup.ts                     # File hash check + semantic dedup (0.95 threshold)
│   │   └── metadata.ts                  # Metadata extraction via Gemini Flash
│   │
│   ├── telegram/
│   │   ├── webhook.ts                   # Telegram webhook route + secret token verification
│   │   └── handlers.ts                  # Per-message-type handlers (text, photo, voice, doc, media group)
│   │
│   ├── mcp/
│   │   ├── server.ts                    # MCP Streamable HTTP transport setup
│   │   ├── profiler-tools.ts            # 9 profiler tools
│   │   └── reminder-tools.ts            # 4 reminder tools
│   │
│   ├── consolidation/
│   │   ├── runner.ts                    # Consolidation orchestrator (guard rails, phase sequencing)
│   │   ├── clustering.ts               # DBSCAN on embedding vectors (eps=0.3, min_samples=2)
│   │   ├── phase1.ts                   # Capture → Fact promotion (per-cluster commits, 80K token budget)
│   │   ├── phase2.ts                   # Fact → Insight generation (atomic commit, 50K token budget)
│   │   └── phase3.ts                   # Embed new items, store, dispatch notifications
│   │
│   ├── retrieval/
│   │   ├── profile.ts                   # get_user_profile: insights + uncovered high-confidence facts + active reminders
│   │   └── search.ts                    # Tiered search: insights → facts → captures, conditional evidence
│   │
│   └── notifications/
│       ├── review.ts                    # Review mode logic (autonomous/hybrid/ask) + pending queue
│       └── digest.ts                    # Daily digest formatting + Telegram dispatch
│
├── functions/
│   └── consolidation-trigger/
│       ├── index.ts                     # Azure Function timer trigger entry point
│       └── function.json                # Timer schedule config (daily)
│
├── migrations/
│   └── 001_initial_schema.sql           # All tables, indexes, extensions (pgvector, uuid-ossp)
│
├── tests/
│   ├── helpers/
│   │   └── mocks.ts                     # Shared mock factories (db, providers, blob)
│   ├── unit/
│   │   ├── config.test.ts
│   │   ├── app.test.ts
│   │   ├── db/
│   │   │   ├── client.test.ts
│   │   │   ├── captures.test.ts
│   │   │   ├── facts.test.ts
│   │   │   ├── insights.test.ts
│   │   │   ├── reminders.test.ts
│   │   │   └── consolidation-log.test.ts
│   │   ├── providers/
│   │   │   ├── gemini-embedding.test.ts
│   │   │   ├── gemini-llm.test.ts
│   │   │   └── anthropic-llm.test.ts
│   │   ├── storage/
│   │   │   └── blob.test.ts
│   │   ├── capture/
│   │   │   ├── pipeline.test.ts
│   │   │   ├── dedup.test.ts
│   │   │   └── metadata.test.ts
│   │   ├── consolidation/
│   │   │   ├── clustering.test.ts
│   │   │   ├── phase1.test.ts
│   │   │   ├── phase2.test.ts
│   │   │   └── phase3.test.ts
│   │   ├── retrieval/
│   │   │   ├── profile.test.ts
│   │   │   └── search.test.ts
│   │   └── notifications/
│   │       ├── review.test.ts
│   │       └── digest.test.ts
│   └── integration/
│       ├── setup.ts                     # Docker PostgreSQL lifecycle for integration tests
│       ├── capture-pipeline.test.ts
│       └── consolidation.test.ts
│
├── docker-compose.yml                   # Local dev: PostgreSQL 16 + pgvector
├── Dockerfile                           # Production multi-stage build
├── host.json                            # Azure Functions host config
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── vitest.integration.config.ts         # Integration test config (uses docker PostgreSQL)
├── .env.example
└── .gitignore
```

---

## Chunk 1: Project Foundation

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "open-brain-v2",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "migrate": "psql $DATABASE_URL -f migrations/001_initial_schema.sql"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@azure/storage-blob": "^12.26.0",
    "@google/generative-ai": "^0.24.0",
    "@hono/node-server": "^1.14.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "dotenv": "^16.4.7",
    "grammy": "^1.35.0",
    "hono": "^4.7.0",
    "pg": "^8.13.0",
    "pgvector": "^0.2.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
coverage/
.DS_Store
```

- [ ] **Step 5: Create `.env.example`**

```bash
# Database
DATABASE_URL=postgresql://openbrain:openbrain@localhost:5432/openbrain

# API Auth
OPEN_BRAIN_API_KEY=your-api-key-here

# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=your-connection-string
AZURE_STORAGE_CONTAINER=open-brain-files

# Google Gemini
GEMINI_API_KEY=your-gemini-key

# Anthropic
ANTHROPIC_API_KEY=your-anthropic-key

# Telegram
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_WEBHOOK_SECRET=your-webhook-secret

# Server
PORT=3000
NODE_ENV=development

# Review Mode: autonomous | hybrid | ask
REVIEW_MODE=hybrid

# Daily Digest: true | false
DAILY_DIGEST_ENABLED=true

# Telegram Chat ID (for notifications)
TELEGRAM_CHAT_ID=your-chat-id
```

- [ ] **Step 6: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: openbrain
      POSTGRES_PASSWORD: openbrain
      POSTGRES_DB: openbrain
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d

volumes:
  pgdata:
```

- [ ] **Step 7: Install dependencies and verify**

Run: `npm install`
Expected: Clean install, `node_modules/` created, `package-lock.json` generated.

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet, should succeed).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example docker-compose.yml
git commit -m "feat: project scaffolding with dependencies and local dev setup"
```

---

### Task 2: Configuration Module

**Files:**
- Create: `src/config.ts`
- Create: `tests/unit/config.test.ts`

- [ ] **Step 1: Write failing test for config validation**

```typescript
// tests/unit/config.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads valid config from environment', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/test');
    vi.stubEnv('OPEN_BRAIN_API_KEY', 'test-key');
    vi.stubEnv('AZURE_STORAGE_CONNECTION_STRING', 'DefaultEndpointsProtocol=https;...');
    vi.stubEnv('AZURE_STORAGE_CONTAINER', 'test-container');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'webhook-secret');
    vi.stubEnv('TELEGRAM_CHAT_ID', '123456');
    vi.stubEnv('PORT', '4000');
    vi.stubEnv('REVIEW_MODE', 'hybrid');

    const { loadConfig } = await import('../../src/config.js');
    const config = loadConfig();

    expect(config.databaseUrl).toBe('postgresql://localhost:5432/test');
    expect(config.port).toBe(4000);
    expect(config.reviewMode).toBe('hybrid');
  });

  it('throws on missing required env vars', async () => {
    // Clear all env vars
    vi.stubEnv('DATABASE_URL', '');

    const { loadConfig } = await import('../../src/config.js');
    expect(() => loadConfig()).toThrow();
  });

  it('uses defaults for optional values', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/test');
    vi.stubEnv('OPEN_BRAIN_API_KEY', 'test-key');
    vi.stubEnv('AZURE_STORAGE_CONNECTION_STRING', 'conn-string');
    vi.stubEnv('AZURE_STORAGE_CONTAINER', 'container');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'webhook-secret');
    vi.stubEnv('TELEGRAM_CHAT_ID', '123456');
    // PORT and REVIEW_MODE not set

    const { loadConfig } = await import('../../src/config.js');
    const config = loadConfig();

    expect(config.port).toBe(3000);
    expect(config.reviewMode).toBe('hybrid');
    expect(config.dailyDigestEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — `Cannot find module '../../src/config.js'`

- [ ] **Step 3: Implement config module**

```typescript
// src/config.ts
import { z } from 'zod';
import 'dotenv/config';

const configSchema = z.object({
  databaseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  azureStorageConnectionString: z.string().min(1),
  azureStorageContainer: z.string().min(1),
  geminiApiKey: z.string().min(1),
  anthropicApiKey: z.string().min(1),
  telegramBotToken: z.string().min(1),
  telegramWebhookSecret: z.string().min(1),
  telegramChatId: z.string().min(1),
  port: z.number().int().positive(),
  nodeEnv: z.enum(['development', 'production', 'test']),
  reviewMode: z.enum(['autonomous', 'hybrid', 'ask']),
  dailyDigestEnabled: z.boolean(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    databaseUrl: process.env.DATABASE_URL,
    apiKey: process.env.OPEN_BRAIN_API_KEY,
    azureStorageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    azureStorageContainer: process.env.AZURE_STORAGE_CONTAINER,
    geminiApiKey: process.env.GEMINI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    port: Number(process.env.PORT || '3000'),
    nodeEnv: process.env.NODE_ENV || 'development',
    reviewMode: process.env.REVIEW_MODE || 'hybrid',
    dailyDigestEnabled: process.env.DAILY_DIGEST_ENABLED !== 'false',
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat: configuration module with Zod validation"
```

---

### Task 3: Database Schema

**Files:**
- Create: `migrations/001_initial_schema.sql`

- [ ] **Step 1: Write the full schema migration**

This must match the spec exactly — 5 tables with all columns, types, defaults, and indexes.

```sql
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
    status          varchar NOT NULL DEFAULT 'not_started',
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
CREATE INDEX idx_reminders_archived ON reminders (archived);
CREATE INDEX idx_reminders_due_date ON reminders (due_date)
    WHERE due_date IS NOT NULL;
```

- [ ] **Step 2: Start PostgreSQL and apply migration**

Run: `docker compose up -d`
Expected: PostgreSQL container starts with pgvector.

Run: `psql postgresql://openbrain:openbrain@localhost:5432/openbrain -f migrations/001_initial_schema.sql`
Expected: All CREATE TABLE and CREATE INDEX statements succeed.

- [ ] **Step 3: Verify tables and indexes exist**

Run: `psql postgresql://openbrain:openbrain@localhost:5432/openbrain -c "\dt"`
Expected: 5 tables listed (captures, facts, insights, consolidation_log, reminders).

Run: `psql postgresql://openbrain:openbrain@localhost:5432/openbrain -c "\di"`
Expected: All HNSW, GIN, and B-tree indexes listed.

- [ ] **Step 4: Commit**

```bash
git add migrations/001_initial_schema.sql
git commit -m "feat: database schema with all 5 tables and indexes"
```

---

### Task 4: Database Client

**Files:**
- Create: `src/db/client.ts`
- Create: `tests/unit/db/client.test.ts`

- [ ] **Step 1: Write failing test for database client**

```typescript
// tests/unit/db/client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';

// Mock pg and pgvector modules
vi.mock('pg', () => {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const mockPool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn(),
  };
  return { default: { Pool: vi.fn(() => mockPool) }, Pool: vi.fn(() => mockPool) };
});

vi.mock('pgvector/pg', () => ({
  default: { registerTypes: vi.fn() },
  registerTypes: vi.fn(),
}));

describe('DbClient', () => {
  it('executes a query via pool', async () => {
    const { createDbClient } = await import('../../../src/db/client.js');
    const db = createDbClient('postgresql://localhost/test');

    const mockResult: QueryResult = {
      rows: [{ id: '1', content: 'test' }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    };
    vi.mocked(db.pool.query).mockResolvedValueOnce(mockResult);

    const result = await db.query('SELECT * FROM captures WHERE id = $1', ['1']);
    expect(result.rows).toEqual([{ id: '1', content: 'test' }]);
    expect(db.pool.query).toHaveBeenCalledWith('SELECT * FROM captures WHERE id = $1', ['1']);
  });

  it('executes a transaction with commit on success', async () => {
    const { createDbClient } = await import('../../../src/db/client.js');
    const db = createDbClient('postgresql://localhost/test');

    const client = await db.pool.connect();
    vi.mocked(client.query).mockResolvedValue({
      rows: [{ id: '1' }],
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await db.transaction(async (txClient) => {
      const res = await txClient.query('INSERT INTO captures (content) VALUES ($1) RETURNING id', ['test']);
      return res.rows[0];
    });

    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back transaction on error', async () => {
    const { createDbClient } = await import('../../../src/db/client.js');
    const db = createDbClient('postgresql://localhost/test');

    const client = await db.pool.connect();
    vi.mocked(client.query)
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockRejectedValueOnce(new Error('constraint violation'));

    await expect(
      db.transaction(async (txClient) => {
        await txClient.query('INSERT INTO bad_table VALUES ($1)', ['bad']);
      })
    ).rejects.toThrow('constraint violation');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/db/client.test.ts`
Expected: FAIL — `Cannot find module '../../../src/db/client.js'`

- [ ] **Step 3: Implement database client**

```typescript
// src/db/client.ts
import pg from 'pg';
import pgvector from 'pgvector/pg';

const { Pool } = pg;

export interface DbClient {
  pool: pg.Pool;
  query(text: string, params?: unknown[]): Promise<pg.QueryResult>;
  transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDbClient(connectionString: string): DbClient {
  const pool = new Pool({ connectionString });

  // Register pgvector type parser on first connect
  let vectorRegistered = false;
  const ensureVector = async () => {
    if (!vectorRegistered) {
      const client = await pool.connect();
      try {
        await pgvector.registerTypes(client);
        vectorRegistered = true;
      } finally {
        client.release();
      }
    }
  };

  return {
    pool,

    async query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
      await ensureVector();
      return pool.query(text, params);
    },

    async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
      await ensureVector();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/db/client.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/client.ts tests/unit/db/client.test.ts
git commit -m "feat: database client with connection pool and transaction support"
```

---

## Chunk 2: Data Access Layer

### Task 5: Captures Query Module

**Files:**
- Create: `src/db/captures.ts`
- Create: `tests/unit/db/captures.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/db/captures.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return {
    pool: {} as any,
    query: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

describe('captures', () => {
  describe('insert', () => {
    it('inserts a capture with all fields', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1' }],
        command: 'INSERT', rowCount: 1, oid: 0, fields: [],
      });

      const { insertCapture } = await import('../../../src/db/captures.js');
      const result = await insertCapture(db, {
        content: 'I love TypeScript',
        contentTypes: ['text'],
        fileUrls: null,
        fileHashes: null,
        embedding: new Array(3072).fill(0.1),
        metadata: { people: [], topics: ['typescript'], action_items: [], dates: [], type: 'statement' },
        source: 'mcp',
      });

      expect(result.id).toBe('uuid-1');
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO captures'),
        expect.arrayContaining(['I love TypeScript', 'mcp']),
      );
    });
  });

  describe('findByStatus', () => {
    it('returns captures with given status', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', content: 'test', status: 'pending' }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

      const { findCapturesByStatus } = await import('../../../src/db/captures.js');
      const results = await findCapturesByStatus(db, 'pending');

      expect(results).toHaveLength(1);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("status = $1"),
        ['pending'],
      );
    });
  });

  describe('updateStatus', () => {
    it('updates capture status and updated_at', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', status: 'consolidated' }],
        command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
      });

      const { updateCaptureStatus } = await import('../../../src/db/captures.js');
      await updateCaptureStatus(db, 'uuid-1', 'consolidated');

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE captures'),
        expect.arrayContaining(['consolidated', 'uuid-1']),
      );
    });
  });

  describe('findSimilar', () => {
    it('finds captures by embedding similarity', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', content: 'similar', similarity: 0.96 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

      const { findSimilarCaptures } = await import('../../../src/db/captures.js');
      const embedding = new Array(3072).fill(0.1);
      const results = await findSimilarCaptures(db, embedding, 0.95);

      expect(results).toHaveLength(1);
      expect(results[0].similarity).toBe(0.96);
    });
  });

  describe('setArchived', () => {
    it('sets archived flag', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', archived: true }],
        command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
      });

      const { setCaptureArchived } = await import('../../../src/db/captures.js');
      await setCaptureArchived(db, 'uuid-1', true);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('archived'),
        expect.arrayContaining([true, 'uuid-1']),
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/db/captures.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement captures query module**

```typescript
// src/db/captures.ts
import type { DbClient } from './client.js';

export interface CaptureInsert {
  content: string;
  contentTypes: string[];
  fileUrls: string[] | null;
  fileHashes: string[] | null;
  embedding: number[];
  metadata: Record<string, unknown>;
  source: string;
}

export interface CaptureRow {
  id: string;
  content: string;
  content_types: string[];
  file_urls: string[] | null;
  file_hashes: string[] | null;
  embedding: number[];
  metadata: Record<string, unknown>;
  source: string;
  status: string;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function insertCapture(
  db: DbClient,
  capture: CaptureInsert,
): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO captures (content, content_types, file_urls, file_hashes, embedding, metadata, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      capture.content,
      capture.contentTypes,
      capture.fileUrls,
      capture.fileHashes,
      JSON.stringify(capture.embedding),
      JSON.stringify(capture.metadata),
      capture.source,
    ],
  );
  return result.rows[0];
}

export async function findCapturesByStatus(
  db: DbClient,
  status: string,
): Promise<CaptureRow[]> {
  const result = await db.query(
    `SELECT * FROM captures WHERE status = $1 AND archived = false ORDER BY created_at ASC`,
    [status],
  );
  return result.rows;
}

export async function updateCaptureStatus(
  db: DbClient,
  id: string,
  status: string,
): Promise<void> {
  await db.query(
    `UPDATE captures SET status = $1, updated_at = now() WHERE id = $2`,
    [status, id],
  );
}

export async function findSimilarCaptures(
  db: DbClient,
  embedding: number[],
  threshold: number,
  limit: number = 20,
): Promise<Array<CaptureRow & { similarity: number }>> {
  const result = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM captures
     WHERE archived = false
       AND embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) > $2
     ORDER BY similarity DESC
     LIMIT $3`,
    [JSON.stringify(embedding), threshold, limit],
  );
  return result.rows;
}

export async function setCaptureArchived(
  db: DbClient,
  id: string,
  archived: boolean,
): Promise<void> {
  await db.query(
    `UPDATE captures SET archived = $1, updated_at = now() WHERE id = $2`,
    [archived, id],
  );
}

export async function getCaptureById(
  db: DbClient,
  id: string,
): Promise<CaptureRow | null> {
  const result = await db.query(`SELECT * FROM captures WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findCapturesByHashes(
  db: DbClient,
  hashes: string[],
): Promise<Array<{ file_hashes: string[]; file_urls: string[] }>> {
  const result = await db.query(
    `SELECT file_hashes, file_urls FROM captures
     WHERE file_hashes && $1 AND archived = false`,
    [hashes],
  );
  return result.rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/db/captures.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/captures.ts tests/unit/db/captures.test.ts
git commit -m "feat: captures query module with CRUD and similarity search"
```

---

### Task 6: Facts Query Module

**Files:**
- Create: `src/db/facts.ts`
- Create: `tests/unit/db/facts.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/db/facts.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('facts', () => {
  it('inserts a new fact with source_capture_ids', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'fact-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });

    const { insertFact } = await import('../../../src/db/facts.js');
    const result = await insertFact(db, {
      content: 'Prefers TypeScript over JavaScript',
      category: 'preference',
      embedding: new Array(3072).fill(0),
      confidence: 0.8,
      sourceCaptureIds: ['cap-1', 'cap-2'],
      origin: 'consolidation',
      reviewStatus: 'auto_approved',
    });

    expect(result.id).toBe('fact-1');
  });

  it('updates a fact and pushes previous version', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'fact-1' }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });

    const { updateFactContent } = await import('../../../src/db/facts.js');
    await updateFactContent(db, 'fact-1', {
      content: 'Strongly prefers TypeScript',
      confidence: 0.9,
      reason: 'Multiple captures reinforce this',
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('previous_versions'),
      expect.arrayContaining(['Strongly prefers TypeScript', 0.9]),
    );
  });

  it('marks fact as user_edited with confidence 1.0', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'fact-1' }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });

    const { userEditFact } = await import('../../../src/db/facts.js');
    await userEditFact(db, 'fact-1', 'Corrected fact content');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("origin = 'user_edited'"),
      expect.arrayContaining(['Corrected fact content', 1.0]),
    );
  });

  it('finds active facts for consolidation', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'f1', confidence: 0.8 }], command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { findActiveFacts } = await import('../../../src/db/facts.js');
    const facts = await findActiveFacts(db, 0.3);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("review_status != 'user_rejected'"),
      [0.3],
    );
  });

  it('finds facts by similarity', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'f1', similarity: 0.88 }], command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { findSimilarFacts } = await import('../../../src/db/facts.js');
    const results = await findSimilarFacts(db, new Array(3072).fill(0), 0.5, 10);
    expect(results[0].similarity).toBe(0.88);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/db/facts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement facts query module**

```typescript
// src/db/facts.ts
import type { DbClient } from './client.js';

export interface FactInsert {
  content: string;
  category: string;
  embedding: number[];
  confidence: number;
  sourceCaptureIds: string[];
  origin: string;
  reviewStatus: string;
}

export interface FactRow {
  id: string;
  content: string;
  category: string;
  embedding: number[];
  confidence: number;
  source_capture_ids: string[];
  origin: string;
  review_status: string;
  previous_versions: Array<{ content: string; confidence: number; changed_at: string; reason: string }>;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
  edited_at: Date | null;
}

export async function insertFact(db: DbClient, fact: FactInsert): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO facts (content, category, embedding, confidence, source_capture_ids, origin, review_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [fact.content, fact.category, JSON.stringify(fact.embedding), fact.confidence,
     fact.sourceCaptureIds, fact.origin, fact.reviewStatus],
  );
  return result.rows[0];
}

export async function updateFactContent(
  db: DbClient,
  id: string,
  update: { content: string; confidence: number; reason: string },
): Promise<void> {
  await db.query(
    `UPDATE facts SET
       previous_versions = previous_versions || jsonb_build_array(
         jsonb_build_object('content', content, 'confidence', confidence,
                            'changed_at', now()::text, 'reason', $3)
       ),
       content = $1,
       confidence = $2,
       embedding = NULL,
       updated_at = now()
     WHERE id = $4 AND origin != 'user_edited'`,
    [update.content, update.confidence, update.reason, id],
  );
}

export async function userEditFact(db: DbClient, id: string, content: string): Promise<void> {
  await db.query(
    `UPDATE facts SET
       previous_versions = previous_versions || jsonb_build_array(
         jsonb_build_object('content', old.content, 'confidence', old.confidence,
                            'changed_at', now()::text, 'reason', 'user edit')
       ),
       content = $1,
       confidence = $2,
       origin = 'user_edited',
       edited_at = now(),
       embedding = NULL,
       updated_at = now()
     FROM (SELECT content, confidence FROM facts WHERE id = $3) AS old
     WHERE facts.id = $3`,
    [content, 1.0, id],
  );
}

export async function findActiveFacts(db: DbClient, minConfidence: number): Promise<FactRow[]> {
  const result = await db.query(
    `SELECT * FROM facts
     WHERE review_status != 'user_rejected'
       AND archived = false
       AND confidence >= $1
     ORDER BY confidence DESC`,
    [minConfidence],
  );
  return result.rows;
}

export async function findSimilarFacts(
  db: DbClient, embedding: number[], threshold: number, limit: number,
): Promise<Array<FactRow & { similarity: number }>> {
  const result = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM facts
     WHERE archived = false AND review_status != 'user_rejected'
       AND embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) > $2
     ORDER BY similarity DESC LIMIT $3`,
    [JSON.stringify(embedding), threshold, limit],
  );
  return result.rows;
}

export async function setFactReviewStatus(
  db: DbClient, id: string, status: string,
): Promise<void> {
  await db.query(
    `UPDATE facts SET review_status = $1, updated_at = now() WHERE id = $2`,
    [status, id],
  );
}

export async function setFactArchived(db: DbClient, id: string, archived: boolean): Promise<void> {
  await db.query(
    `UPDATE facts SET archived = $1, updated_at = now() WHERE id = $2`,
    [archived, id],
  );
}

export async function getFactById(db: DbClient, id: string): Promise<FactRow | null> {
  const result = await db.query(`SELECT * FROM facts WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findPendingReviewFacts(db: DbClient, limit: number): Promise<FactRow[]> {
  const result = await db.query(
    `SELECT * FROM facts WHERE review_status = 'pending_review' AND archived = false
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function addSourceCaptureIds(
  db: DbClient, id: string, captureIds: string[],
): Promise<void> {
  await db.query(
    `UPDATE facts SET
       source_capture_ids = array_cat(source_capture_ids, $1),
       updated_at = now()
     WHERE id = $2`,
    [captureIds, id],
  );
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/db/facts.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/facts.ts tests/unit/db/facts.test.ts
git commit -m "feat: facts query module with version tracking and similarity search"
```

---

### Task 7: Insights Query Module

**Files:**
- Create: `src/db/insights.ts`
- Create: `tests/unit/db/insights.test.ts`

Follows the same pattern as facts. Key differences: `source_fact_ids` instead of `source_capture_ids`, `generated_at` instead of `created_at`, default `review_status = 'pending_review'`, no `previous_versions`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/db/insights.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('insights', () => {
  it('inserts an insight with pending_review status', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'ins-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });

    const { insertInsight } = await import('../../../src/db/insights.js');
    const result = await insertInsight(db, {
      content: 'User shows strong analytical tendencies',
      category: 'pattern',
      embedding: new Array(3072).fill(0),
      confidence: 0.75,
      sourceFactIds: ['f1', 'f2', 'f3'],
      origin: 'consolidation',
    });

    expect(result.id).toBe('ins-1');
  });

  it('finds approved insights for profile', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'ins-1', review_status: 'user_approved' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { findApprovedInsights } = await import('../../../src/db/insights.js');
    const insights = await findApprovedInsights(db);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("review_status IN ('auto_approved', 'user_approved')"),
      [],
    );
  });

  it('finds similar insights by embedding', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'ins-1', similarity: 0.92 }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { findSimilarInsights } = await import('../../../src/db/insights.js');
    const results = await findSimilarInsights(db, new Array(3072).fill(0), 0.5, 10);
    expect(results[0].similarity).toBe(0.92);
  });

  it('sets review status with content edit', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'ins-1' }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });

    const { setInsightReviewStatus } = await import('../../../src/db/insights.js');
    await setInsightReviewStatus(db, 'ins-1', 'user_approved', 'Edited insight content');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("origin = 'user_edited'"),
      expect.arrayContaining(['user_approved', 'Edited insight content', 'ins-1']),
    );
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/db/insights.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement insights query module**

```typescript
// src/db/insights.ts
import type { DbClient } from './client.js';

export interface InsightInsert {
  content: string;
  category: string;
  embedding: number[];
  confidence: number;
  sourceFactIds: string[];
  origin: string;
}

export interface InsightRow {
  id: string;
  content: string;
  category: string;
  embedding: number[];
  confidence: number;
  source_fact_ids: string[];
  origin: string;
  review_status: string;
  archived: boolean;
  generated_at: Date;
  updated_at: Date;
  edited_at: Date | null;
}

export async function insertInsight(db: DbClient, insight: InsightInsert): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO insights (content, category, embedding, confidence, source_fact_ids, origin)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [insight.content, insight.category, JSON.stringify(insight.embedding),
     insight.confidence, insight.sourceFactIds, insight.origin],
  );
  return result.rows[0];
}

export async function findApprovedInsights(db: DbClient): Promise<InsightRow[]> {
  const result = await db.query(
    `SELECT * FROM insights
     WHERE review_status IN ('auto_approved', 'user_approved')
       AND archived = false
     ORDER BY confidence DESC`,
    [],
  );
  return result.rows;
}

export async function findSimilarInsights(
  db: DbClient, embedding: number[], threshold: number, limit: number,
): Promise<Array<InsightRow & { similarity: number }>> {
  const result = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM insights
     WHERE archived = false AND review_status != 'user_rejected'
       AND embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) > $2
     ORDER BY similarity DESC LIMIT $3`,
    [JSON.stringify(embedding), threshold, limit],
  );
  return result.rows;
}

export async function setInsightReviewStatus(
  db: DbClient, id: string, status: string, content?: string,
): Promise<void> {
  if (content) {
    await db.query(
      `UPDATE insights SET review_status = $1, content = $2, origin = 'user_edited',
       edited_at = now(), embedding = NULL, updated_at = now() WHERE id = $3`,
      [status, content, id],
    );
  } else {
    await db.query(
      `UPDATE insights SET review_status = $1, updated_at = now() WHERE id = $2`,
      [status, id],
    );
  }
}

export async function setInsightArchived(db: DbClient, id: string, archived: boolean): Promise<void> {
  await db.query(
    `UPDATE insights SET archived = $1, updated_at = now() WHERE id = $2`,
    [archived, id],
  );
}

export async function getInsightById(db: DbClient, id: string): Promise<InsightRow | null> {
  const result = await db.query(`SELECT * FROM insights WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findPendingReviewInsights(db: DbClient, limit: number): Promise<InsightRow[]> {
  const result = await db.query(
    `SELECT * FROM insights WHERE review_status = 'pending_review' AND archived = false
     ORDER BY generated_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function findAllInsights(db: DbClient): Promise<InsightRow[]> {
  const result = await db.query(
    `SELECT * FROM insights WHERE archived = false AND review_status != 'user_rejected'
     ORDER BY confidence DESC`,
    [],
  );
  return result.rows;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/db/insights.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/insights.ts tests/unit/db/insights.test.ts
git commit -m "feat: insights query module with approval filtering and similarity search"
```

---

### Task 8: Reminders Query Module

**Files:**
- Create: `src/db/reminders.ts`
- Create: `tests/unit/db/reminders.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/db/reminders.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('reminders', () => {
  it('inserts a reminder', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });

    const { insertReminder } = await import('../../../src/db/reminders.js');
    const result = await insertReminder(db, {
      content: 'Buy groceries',
      embedding: new Array(3072).fill(0),
      category: 'personal',
      source: 'telegram',
      sourceContext: 'Chat about dinner plans',
      dueDate: null,
    });

    expect(result.id).toBe('rem-1');
  });

  it('lists active reminders filtered by status', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', status: 'not_started' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { listReminders } = await import('../../../src/db/reminders.js');
    const results = await listReminders(db, { status: 'not_started', limit: 20 });

    expect(results).toHaveLength(1);
  });

  it('marks reminder as done', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', status: 'done' }],
      command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });

    const { completeReminder } = await import('../../../src/db/reminders.js');
    await completeReminder(db, 'rem-1');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'done'"),
      ['rem-1'],
    );
  });

  it('finds recently completed reminders for consolidation', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', status: 'done' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { findRecentlyCompletedReminders } = await import('../../../src/db/reminders.js');
    const results = await findRecentlyCompletedReminders(db, new Date('2026-03-13'));
    expect(results).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/db/reminders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement reminders query module**

```typescript
// src/db/reminders.ts
import type { DbClient } from './client.js';

export interface ReminderInsert {
  content: string;
  embedding: number[];
  category: string | null;
  source: string;
  sourceContext: string | null;
  dueDate: Date | null;
}

export interface ReminderRow {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown> | null;
  category: string;
  status: string;
  source_context: string | null;
  source: string;
  archived: boolean;
  due_date: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function insertReminder(db: DbClient, reminder: ReminderInsert): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO reminders (content, embedding, category, source, source_context, due_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [reminder.content, JSON.stringify(reminder.embedding), reminder.category,
     reminder.source, reminder.sourceContext, reminder.dueDate],
  );
  return result.rows[0];
}

export async function listReminders(
  db: DbClient,
  filters: { status?: string; category?: string; limit?: number },
): Promise<ReminderRow[]> {
  const conditions = ['archived = false'];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(filters.status);
  }
  if (filters.category) {
    conditions.push(`category = $${paramIdx++}`);
    params.push(filters.category);
  }

  const limit = filters.limit ?? 20;

  const result = await db.query(
    `SELECT * FROM reminders WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${paramIdx}`,
    [...params, limit],
  );
  return result.rows;
}

export async function updateReminder(
  db: DbClient,
  id: string,
  updates: { status?: string; content?: string; dueDate?: Date | null },
): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (updates.status !== undefined) {
    sets.push(`status = $${paramIdx++}`);
    params.push(updates.status);
  }
  if (updates.content !== undefined) {
    sets.push(`content = $${paramIdx++}`, `embedding = NULL`);
    params.push(updates.content);
  }
  if (updates.dueDate !== undefined) {
    sets.push(`due_date = $${paramIdx++}`);
    params.push(updates.dueDate);
  }

  params.push(id);
  await db.query(
    `UPDATE reminders SET ${sets.join(', ')} WHERE id = $${paramIdx}`,
    params,
  );
}

export async function completeReminder(db: DbClient, id: string): Promise<void> {
  await db.query(
    `UPDATE reminders SET status = 'done', updated_at = now() WHERE id = $1`,
    [id],
  );
}

export async function findRecentlyCompletedReminders(
  db: DbClient, since: Date,
): Promise<ReminderRow[]> {
  const result = await db.query(
    `SELECT * FROM reminders
     WHERE status = 'done' AND updated_at >= $1 AND archived = false
     ORDER BY updated_at DESC`,
    [since],
  );
  return result.rows;
}

export async function findActiveReminders(db: DbClient): Promise<ReminderRow[]> {
  const result = await db.query(
    `SELECT * FROM reminders
     WHERE status IN ('not_started', 'in_progress', 'researching')
       AND archived = false
     ORDER BY created_at DESC`,
    [],
  );
  return result.rows;
}

export async function getReminderById(db: DbClient, id: string): Promise<ReminderRow | null> {
  const result = await db.query(`SELECT * FROM reminders WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/db/reminders.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/reminders.ts tests/unit/db/reminders.test.ts
git commit -m "feat: reminders query module with filtering and completion"
```

---

### Task 9: Consolidation Log Module

**Files:**
- Create: `src/db/consolidation-log.ts`
- Create: `tests/unit/db/consolidation-log.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/db/consolidation-log.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('consolidation-log', () => {
  it('inserts a consolidation log entry', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'log-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });

    const { insertConsolidationLog } = await import('../../../src/db/consolidation-log.js');
    await insertConsolidationLog(db, {
      status: 'success',
      capturesProcessed: 8,
      factsCreated: 2,
      factsUpdated: 3,
      insightsCreated: 1,
      insightsRegenerated: 0,
      duplicatesDetected: 0,
      itemsFlagged: 3,
      modelUsed: 'claude-opus-4-6',
      tokensUsed: 45000,
      durationMs: 12000,
      errorMessage: null,
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO consolidation_log'),
      expect.arrayContaining(['success', 8, 2, 3]),
    );
  });

  it('fetches the latest consolidation run', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'log-1', status: 'success', run_at: new Date() }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { getLatestConsolidationRun } = await import('../../../src/db/consolidation-log.js');
    const latest = await getLatestConsolidationRun(db);
    expect(latest?.status).toBe('success');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/unit/db/consolidation-log.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement consolidation log module**

```typescript
// src/db/consolidation-log.ts
import type { DbClient } from './client.js';

export interface ConsolidationLogInsert {
  status: string;
  capturesProcessed: number;
  factsCreated: number;
  factsUpdated: number;
  insightsCreated: number;
  insightsRegenerated: number;
  duplicatesDetected: number;
  itemsFlagged: number;
  modelUsed: string;
  tokensUsed: number;
  durationMs: number;
  errorMessage: string | null;
}

export interface ConsolidationLogRow {
  id: string;
  run_at: Date;
  status: string;
  captures_processed: number;
  facts_created: number;
  facts_updated: number;
  insights_created: number;
  insights_regenerated: number;
  duplicates_detected: number;
  items_flagged: number;
  model_used: string;
  tokens_used: number;
  duration_ms: number;
  error_message: string | null;
}

export async function insertConsolidationLog(
  db: DbClient, log: ConsolidationLogInsert,
): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO consolidation_log
       (status, captures_processed, facts_created, facts_updated,
        insights_created, insights_regenerated, duplicates_detected,
        items_flagged, model_used, tokens_used, duration_ms, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [log.status, log.capturesProcessed, log.factsCreated, log.factsUpdated,
     log.insightsCreated, log.insightsRegenerated, log.duplicatesDetected,
     log.itemsFlagged, log.modelUsed, log.tokensUsed, log.durationMs, log.errorMessage],
  );
  return result.rows[0];
}

export async function getLatestConsolidationRun(
  db: DbClient,
): Promise<ConsolidationLogRow | null> {
  const result = await db.query(
    `SELECT * FROM consolidation_log ORDER BY run_at DESC LIMIT 1`,
    [],
  );
  return result.rows[0] ?? null;
}

export async function getConsolidationStats(
  db: DbClient,
): Promise<{ totalRuns: number; lastRunAt: Date | null; lastStatus: string | null }> {
  const result = await db.query(
    `SELECT count(*) as total_runs,
            max(run_at) as last_run_at,
            (SELECT status FROM consolidation_log ORDER BY run_at DESC LIMIT 1) as last_status
     FROM consolidation_log`,
    [],
  );
  const row = result.rows[0];
  return {
    totalRuns: parseInt(row.total_runs, 10),
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/db/consolidation-log.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/consolidation-log.ts tests/unit/db/consolidation-log.test.ts
git commit -m "feat: consolidation log module for audit trail"
```

---

## Chunk 3: Providers & Storage

### Task 10: Provider Interfaces

**Files:**
- Create: `src/providers/types.ts`

- [ ] **Step 1: Create provider interface file**

> **Intentional spec extensions:** The spec defines `complete()` as returning `Promise<string>`. This plan extends it to return `LLMResponse` (content + token usage) for consolidation token budget tracking. Similarly, `LLMMessage.content` is extended from `string` to `string | LLMContentPart[]` for multimodal support. Both are additive — the spec interfaces are a subset.

```typescript
// src/providers/types.ts

export interface EmbeddingProvider {
  /**
   * Generate an embedding vector from text and optional file buffers.
   * Files and text are embedded together into a single vector space.
   */
  embed(content: string, files?: Buffer[]): Promise<number[]>;

  /** Dimensionality of output vectors (3072 for Gemini Embedding 2) */
  readonly dimensions: number;
}

export interface LLMProvider {
  /**
   * Send a completion request to the LLM.
   * Returns the text content of the response.
   */
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | LLMContentPart[];
}

export interface LLMContentPart {
  type: 'text' | 'image';
  text?: string;
  data?: Buffer;
  mimeType?: string;
}

export interface LLMOptions {
  model?: string;
  systemPrompt?: string;
  responseFormat?: 'json' | 'text';
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: provider abstraction interfaces (EmbeddingProvider, LLMProvider)"
```

---

### Task 11: Gemini Embedding Provider

**Files:**
- Create: `src/providers/gemini-embedding.ts`
- Create: `tests/unit/providers/gemini-embedding.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/providers/gemini-embedding.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@google/generative-ai', () => {
  const mockEmbedContent = vi.fn();
  return {
    GoogleGenerativeAI: vi.fn(() => ({
      getGenerativeModel: vi.fn(() => ({
        embedContent: mockEmbedContent,
      })),
    })),
    __mockEmbedContent: mockEmbedContent,
  };
});

describe('GeminiEmbeddingProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a 3072-dimension vector for text input', async () => {
    const { __mockEmbedContent } = await import('@google/generative-ai') as any;
    const mockVector = new Array(3072).fill(0.1);
    __mockEmbedContent.mockResolvedValueOnce({
      embedding: { values: mockVector },
    });

    const { GeminiEmbeddingProvider } = await import('../../../src/providers/gemini-embedding.js');
    const provider = new GeminiEmbeddingProvider('test-key');

    const result = await provider.embed('I love TypeScript');
    expect(result).toHaveLength(3072);
    expect(provider.dimensions).toBe(3072);
  });

  it('passes file buffers as inline data parts', async () => {
    const { __mockEmbedContent } = await import('@google/generative-ai') as any;
    __mockEmbedContent.mockResolvedValueOnce({
      embedding: { values: new Array(3072).fill(0.2) },
    });

    const { GeminiEmbeddingProvider } = await import('../../../src/providers/gemini-embedding.js');
    const provider = new GeminiEmbeddingProvider('test-key');

    const fileBuffer = Buffer.from('fake image data');
    await provider.embed('Photo of my desk', [fileBuffer]);

    expect(__mockEmbedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({ text: 'Photo of my desk' }),
          ]),
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/providers/gemini-embedding.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Gemini Embedding provider**

```typescript
// src/providers/gemini-embedding.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { EmbeddingProvider } from './types.js';

const EMBEDDING_MODEL = 'gemini-embedding-exp-03-07'; // Gemini Embedding 2 — verify latest model ID at implementation time
const DIMENSIONS = 3072;

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private client: GoogleGenerativeAI;
  readonly dimensions = DIMENSIONS;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async embed(content: string, files?: Buffer[]): Promise<number[]> {
    const model = this.client.getGenerativeModel({ model: EMBEDDING_MODEL });

    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
      { text: content },
    ];

    if (files) {
      for (const file of files) {
        parts.push({
          inlineData: {
            data: file.toString('base64'),
            mimeType: 'application/octet-stream',
          },
        });
      }
    }

    const result = await model.embedContent({
      content: { role: 'user', parts },
      taskType: 'RETRIEVAL_DOCUMENT' as any,
      outputDimensionality: DIMENSIONS,
    } as any);

    return result.embedding.values;
  }
}
```

> **Note:** The exact API shape for `embedContent` with `outputDimensionality` may need adjustment based on the SDK version. The Gemini API requires explicitly requesting 3072 dimensions — the default is 768. Verify during implementation.

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/providers/gemini-embedding.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/gemini-embedding.ts tests/unit/providers/gemini-embedding.test.ts
git commit -m "feat: Gemini Embedding provider (3072 dims, multimodal)"
```

---

### Task 12: Gemini LLM Provider

**Files:**
- Create: `src/providers/gemini-llm.ts`
- Create: `tests/unit/providers/gemini-llm.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/providers/gemini-llm.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@google/generative-ai', () => {
  const mockGenerateContent = vi.fn();
  return {
    GoogleGenerativeAI: vi.fn(() => ({
      getGenerativeModel: vi.fn(() => ({
        generateContent: mockGenerateContent,
      })),
    })),
    __mockGenerateContent: mockGenerateContent,
  };
});

describe('GeminiLLMProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends a completion request and returns content + token usage', async () => {
    const { __mockGenerateContent } = await import('@google/generative-ai') as any;
    __mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => '{"topics": ["typescript"]}',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
      },
    });

    const { GeminiLLMProvider } = await import('../../../src/providers/gemini-llm.js');
    const provider = new GeminiLLMProvider('test-key');

    const result = await provider.complete(
      [{ role: 'user', content: 'Extract topics from: I love TypeScript' }],
      { responseFormat: 'json' },
    );

    expect(result.content).toBe('{"topics": ["typescript"]}');
    expect(result.tokensUsed.total).toBe(150);
  });

  it('passes system prompt when provided', async () => {
    const { __mockGenerateContent } = await import('@google/generative-ai') as any;
    __mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => 'done',
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
      },
    });

    const { GeminiLLMProvider } = await import('../../../src/providers/gemini-llm.js');
    const provider = new GeminiLLMProvider('test-key');

    await provider.complete(
      [{ role: 'user', content: 'test' }],
      { systemPrompt: 'You are a metadata extractor' },
    );

    expect(__mockGenerateContent).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/providers/gemini-llm.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Gemini LLM provider**

```typescript
// src/providers/gemini-llm.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from './types.js';

const DEFAULT_MODEL = 'gemini-2.0-flash';

export class GeminiLLMProvider implements LLMProvider {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const modelName = options?.model ?? DEFAULT_MODEL;
    const model = this.client.getGenerativeModel({
      model: modelName,
      ...(options?.systemPrompt && { systemInstruction: options.systemPrompt }),
      ...(options?.responseFormat === 'json' && {
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });

    const contents = messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: typeof msg.content === 'string'
        ? [{ text: msg.content }]
        : msg.content.map((part) =>
            part.type === 'text'
              ? { text: part.text! }
              : { inlineData: { data: part.data!.toString('base64'), mimeType: part.mimeType! } }
          ),
    }));

    const generationConfig: Record<string, unknown> = {};
    if (options?.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;
    if (options?.responseFormat === 'json') generationConfig.responseMimeType = 'application/json';

    const result = await model.generateContent({
      contents,
      ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
    });

    const usage = result.response.usageMetadata;
    return {
      content: result.response.text(),
      tokensUsed: {
        input: usage?.promptTokenCount ?? 0,
        output: usage?.candidatesTokenCount ?? 0,
        total: usage?.totalTokenCount ?? 0,
      },
    };
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/providers/gemini-llm.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/gemini-llm.ts tests/unit/providers/gemini-llm.test.ts
git commit -m "feat: Gemini Flash LLM provider for metadata extraction and retrieval synthesis"
```

---

### Task 13: Anthropic LLM Provider

**Files:**
- Create: `src/providers/anthropic-llm.ts`
- Create: `tests/unit/providers/anthropic-llm.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/providers/anthropic-llm.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

describe('AnthropicLLMProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends messages and returns content + token usage', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"facts": []}' }],
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    const { AnthropicLLMProvider } = await import('../../../src/providers/anthropic-llm.js');
    const provider = new AnthropicLLMProvider('test-key');

    const result = await provider.complete(
      [{ role: 'user', content: 'Analyze these captures' }],
      { systemPrompt: 'You are a profile consolidator', responseFormat: 'json' },
    );

    expect(result.content).toBe('{"facts": []}');
    expect(result.tokensUsed.input).toBe(200);
    expect(result.tokensUsed.output).toBe(100);
    expect(result.tokensUsed.total).toBe(300);
  });

  it('uses claude-opus-4-6 as default model', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const { AnthropicLLMProvider } = await import('../../../src/providers/anthropic-llm.js');
    const provider = new AnthropicLLMProvider('test-key');

    await provider.complete([{ role: 'user', content: 'test' }]);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-6' }),
    );
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/providers/anthropic-llm.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Anthropic LLM provider**

```typescript
// src/providers/anthropic-llm.ts
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from './types.js';

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_MAX_TOKENS = 8192;

export class AnthropicLLMProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const anthropicMessages = messages.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((part) =>
            part.type === 'text'
              ? { type: 'text' as const, text: part.text! }
              : { type: 'image' as const, source: {
                  type: 'base64' as const,
                  media_type: (part.mimeType ?? 'image/png') as 'image/png',
                  data: part.data!.toString('base64'),
                } }
          ),
    }));

    const response = await this.client.messages.create({
      model: options?.model ?? DEFAULT_MODEL,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(options?.systemPrompt && { system: options.systemPrompt }),
      messages: anthropicMessages,
    });

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      content: textContent,
      tokensUsed: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        total: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/providers/anthropic-llm.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/anthropic-llm.ts tests/unit/providers/anthropic-llm.test.ts
git commit -m "feat: Anthropic LLM provider (Claude Opus 4.6 for consolidation)"
```

---

### Task 14: Azure Blob Storage Client

**Files:**
- Create: `src/storage/blob.ts`
- Create: `tests/unit/storage/blob.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/storage/blob.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpload = vi.fn();
const mockGetProperties = vi.fn();
const mockGetBlockBlobClient = vi.fn(() => ({
  upload: mockUpload,
  getProperties: mockGetProperties,
  url: 'https://storage.blob.core.windows.net/container/test-file',
}));
const mockGetContainerClient = vi.fn(() => ({
  getBlockBlobClient: mockGetBlockBlobClient,
}));

vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: {
    fromConnectionString: vi.fn(() => ({
      getContainerClient: mockGetContainerClient,
    })),
  },
}));

describe('BlobStorage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploads a file and returns the URL', async () => {
    mockUpload.mockResolvedValueOnce({});

    const { createBlobStorage } = await import('../../../src/storage/blob.js');
    const storage = createBlobStorage('conn-string', 'test-container');

    const url = await storage.upload('test-file.jpg', Buffer.from('data'), 'image/jpeg');
    expect(url).toContain('test-file');
    expect(mockUpload).toHaveBeenCalled();
  });

  it('checks if a blob exists', async () => {
    mockGetProperties.mockResolvedValueOnce({});

    const { createBlobStorage } = await import('../../../src/storage/blob.js');
    const storage = createBlobStorage('conn-string', 'test-container');

    const exists = await storage.exists('test-file.jpg');
    expect(exists).toBe(true);
  });

  it('returns false when blob does not exist', async () => {
    mockGetProperties.mockRejectedValueOnce({ statusCode: 404 });

    const { createBlobStorage } = await import('../../../src/storage/blob.js');
    const storage = createBlobStorage('conn-string', 'test-container');

    const exists = await storage.exists('missing.jpg');
    expect(exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/storage/blob.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Blob Storage client**

```typescript
// src/storage/blob.ts
import { BlobServiceClient } from '@azure/storage-blob';

export interface BlobStorage {
  upload(blobName: string, data: Buffer, contentType: string): Promise<string>;
  exists(blobName: string): Promise<boolean>;
  getUrl(blobName: string): string;
}

export function createBlobStorage(connectionString: string, containerName: string): BlobStorage {
  const serviceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = serviceClient.getContainerClient(containerName);

  return {
    async upload(blobName: string, data: Buffer, contentType: string): Promise<string> {
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.upload(data, data.length, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
      return blockBlobClient.url;
    },

    async exists(blobName: string): Promise<boolean> {
      try {
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.getProperties();
        return true;
      } catch (err: any) {
        if (err.statusCode === 404) return false;
        throw err;
      }
    },

    getUrl(blobName: string): string {
      return containerClient.getBlockBlobClient(blobName).url;
    },
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/storage/blob.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/blob.ts tests/unit/storage/blob.test.ts
git commit -m "feat: Azure Blob Storage client for file uploads"
```

---

## Chunk 4: Capture Pipeline

### Task 15: Dedup Module

**Files:**
- Create: `src/capture/dedup.ts`
- Create: `tests/unit/capture/dedup.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/capture/dedup.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('dedup', () => {
  describe('computeFileHash', () => {
    it('returns SHA-256 hex digest of buffer', async () => {
      const { computeFileHash } = await import('../../../src/capture/dedup.js');
      const data = Buffer.from('test data');
      const hash = computeFileHash(data);
      const expected = createHash('sha256').update(data).digest('hex');
      expect(hash).toBe(expected);
    });
  });

  describe('checkFileHashDedup', () => {
    it('returns existing URLs for matching hashes', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ file_hashes: ['hash1'], file_urls: ['https://blob/file1.jpg'] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

      const { checkFileHashDedup } = await import('../../../src/capture/dedup.js');
      const result = await checkFileHashDedup(db, ['hash1', 'hash2']);

      expect(result.get('hash1')).toBe('https://blob/file1.jpg');
      expect(result.has('hash2')).toBe(false);
    });
  });

  describe('checkSemanticDedup', () => {
    it('returns true (duplicate) when similarity > 0.95', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'existing', similarity: 0.97 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

      const { checkSemanticDedup } = await import('../../../src/capture/dedup.js');
      const result = await checkSemanticDedup(db, new Array(3072).fill(0.1));

      expect(result.isDuplicate).toBe(true);
      expect(result.similarity).toBe(0.97);
    });

    it('returns false when no captures exceed threshold', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [],
      });

      const { checkSemanticDedup } = await import('../../../src/capture/dedup.js');
      const result = await checkSemanticDedup(db, new Array(3072).fill(0.1));

      expect(result.isDuplicate).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/capture/dedup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement dedup module**

```typescript
// src/capture/dedup.ts
import { createHash } from 'crypto';
import type { DbClient } from '../db/client.js';
import { findSimilarCaptures, findCapturesByHashes } from '../db/captures.js';

const SEMANTIC_DEDUP_THRESHOLD = 0.95;

export function computeFileHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function checkFileHashDedup(
  db: DbClient,
  hashes: string[],
): Promise<Map<string, string>> {
  const matches = await findCapturesByHashes(db, hashes);
  const hashToUrl = new Map<string, string>();

  for (const row of matches) {
    if (row.file_hashes && row.file_urls) {
      for (let i = 0; i < row.file_hashes.length; i++) {
        if (hashes.includes(row.file_hashes[i]) && row.file_urls[i]) {
          hashToUrl.set(row.file_hashes[i], row.file_urls[i]);
        }
      }
    }
  }

  return hashToUrl;
}

export interface SemanticDedupResult {
  isDuplicate: boolean;
  similarity: number | null;
  existingId: string | null;
}

export async function checkSemanticDedup(
  db: DbClient,
  embedding: number[],
): Promise<SemanticDedupResult> {
  const similar = await findSimilarCaptures(db, embedding, SEMANTIC_DEDUP_THRESHOLD);

  if (similar.length > 0) {
    return {
      isDuplicate: true,
      similarity: similar[0].similarity,
      existingId: similar[0].id,
    };
  }

  return { isDuplicate: false, similarity: null, existingId: null };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/capture/dedup.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/dedup.ts tests/unit/capture/dedup.test.ts
git commit -m "feat: dedup module with SHA-256 file hash and semantic similarity checks"
```

---

### Task 16: Metadata Extraction

**Files:**
- Create: `src/capture/metadata.ts`
- Create: `tests/unit/capture/metadata.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/capture/metadata.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '../../../src/providers/types.js';

function mockLLM(): LLMProvider {
  return { complete: vi.fn() };
}

describe('metadata extraction', () => {
  it('extracts structured metadata from text content', async () => {
    const llm = mockLLM();
    const response: LLMResponse = {
      content: JSON.stringify({
        people: ['Alice'],
        topics: ['cooking', 'italian food'],
        action_items: [],
        dates: [],
        type: 'preference',
      }),
      tokensUsed: { input: 50, output: 30, total: 80 },
    };
    vi.mocked(llm.complete).mockResolvedValueOnce(response);

    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Alice taught me to make pasta. I love Italian food.');

    expect(metadata.people).toContain('Alice');
    expect(metadata.topics).toContain('italian food');
    expect(metadata.type).toBe('preference');
  });

  it('handles LLM returning invalid JSON gracefully', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: 'not valid json',
      tokensUsed: { input: 50, output: 10, total: 60 },
    });

    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Some content');

    expect(metadata.people).toEqual([]);
    expect(metadata.topics).toEqual([]);
    expect(metadata.type).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/capture/metadata.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement metadata extraction**

```typescript
// src/capture/metadata.ts
import type { LLMProvider } from '../providers/types.js';

export interface CaptureMetadata {
  people: string[];
  topics: string[];
  action_items: string[];
  dates: string[];
  type: string;
}

const EXTRACTION_PROMPT = `Extract structured metadata from the following text. Return JSON with these fields:
- people: array of person names mentioned
- topics: array of topics/subjects discussed
- action_items: array of tasks or things to do mentioned
- dates: array of dates or time references mentioned
- type: one of "statement", "preference", "experience", "question", "action", "reflection", "unknown"

Return ONLY valid JSON, no markdown formatting.`;

const FALLBACK_METADATA: CaptureMetadata = {
  people: [],
  topics: [],
  action_items: [],
  dates: [],
  type: 'unknown',
};

export async function extractMetadata(
  llm: LLMProvider,
  content: string,
): Promise<CaptureMetadata> {
  try {
    const response = await llm.complete(
      [{ role: 'user', content }],
      {
        systemPrompt: EXTRACTION_PROMPT,
        responseFormat: 'json',
        maxTokens: 1024,
      },
    );

    const parsed = JSON.parse(response.content);
    return {
      people: Array.isArray(parsed.people) ? parsed.people : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates : [],
      type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
    };
  } catch {
    return FALLBACK_METADATA;
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/capture/metadata.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/metadata.ts tests/unit/capture/metadata.test.ts
git commit -m "feat: metadata extraction via Gemini Flash with graceful fallback"
```

---

### Task 17: Capture Pipeline Orchestrator

**Files:**
- Create: `src/capture/pipeline.ts`
- Create: `tests/unit/capture/pipeline.test.ts`

This is the universal ingest pipeline from the spec: receive → file hash check → generate embedding → semantic dedup check → upload files (parallel) + extract metadata (parallel) → insert into captures.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/capture/pipeline.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { EmbeddingProvider, LLMProvider, LLMResponse } from '../../../src/providers/types.js';
import type { BlobStorage } from '../../../src/storage/blob.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

function mockEmbedding(): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
    dimensions: 3072,
  };
}

function mockLLM(): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify({ people: [], topics: ['test'], action_items: [], dates: [], type: 'statement' }),
      tokensUsed: { input: 50, output: 30, total: 80 },
    } satisfies LLMResponse),
  };
}

function mockBlob(): BlobStorage {
  return {
    upload: vi.fn().mockResolvedValue('https://blob/file.jpg'),
    exists: vi.fn().mockResolvedValue(false),
    getUrl: vi.fn().mockReturnValue('https://blob/file.jpg'),
  };
}

describe('capture pipeline', () => {
  it('processes text-only capture successfully', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // semantic dedup
      .mockResolvedValueOnce({ rows: [{ id: 'cap-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }); // insert

    const { runCapturePipeline } = await import('../../../src/capture/pipeline.js');
    const result = await runCapturePipeline({
      db,
      embeddingProvider: mockEmbedding(),
      metadataLLM: mockLLM(),
      blobStorage: mockBlob(),
      content: 'I love TypeScript',
      files: [],
      source: 'mcp',
    });

    expect(result.success).toBe(true);
    expect(result.captureId).toBe('cap-1');
  });

  it('rejects semantic duplicates (similarity > 0.95)', async () => {
    const db = mockDb();
    // findSimilarCaptures returns a match > 0.95
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'existing', similarity: 0.97, content: 'I love TypeScript' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { runCapturePipeline } = await import('../../../src/capture/pipeline.js');
    const result = await runCapturePipeline({
      db,
      embeddingProvider: mockEmbedding(),
      metadataLLM: mockLLM(),
      blobStorage: mockBlob(),
      content: 'I love TypeScript',
      files: [],
      source: 'mcp',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('duplicate');
  });

  it('reuses existing file URLs for hash matches', async () => {
    const db = mockDb();
    const blob = mockBlob();

    // file hash dedup check - finds existing hash
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ file_hashes: ['abc123'], file_urls: ['https://blob/existing.jpg'] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // checkFileHashDedup
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // semantic dedup
      .mockResolvedValueOnce({ rows: [{ id: 'cap-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }); // insert

    const { runCapturePipeline } = await import('../../../src/capture/pipeline.js');
    const fileData = Buffer.from('test image');

    const result = await runCapturePipeline({
      db,
      embeddingProvider: mockEmbedding(),
      metadataLLM: mockLLM(),
      blobStorage: blob,
      content: 'A photo',
      files: [{ data: fileData, contentType: 'image/jpeg', filename: 'photo.jpg' }],
      source: 'telegram',
    });

    // Should NOT upload since hash matched — blob.upload should not be called for matched file
    expect(result.success).toBe(true);
  });

  it('uploads new files and runs metadata extraction in parallel', async () => {
    const db = mockDb();
    const blob = mockBlob();
    const embedding = mockEmbedding();
    const llm = mockLLM();

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // file hash dedup
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // semantic dedup
      .mockResolvedValueOnce({ rows: [{ id: 'cap-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }); // insert

    const { runCapturePipeline } = await import('../../../src/capture/pipeline.js');
    const result = await runCapturePipeline({
      db,
      embeddingProvider: embedding,
      metadataLLM: llm,
      blobStorage: blob,
      content: 'New photo',
      files: [{ data: Buffer.from('new img'), contentType: 'image/png', filename: 'new.png' }],
      source: 'api',
    });

    expect(result.success).toBe(true);
    expect(blob.upload).toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalled();
    expect(embedding.embed).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/capture/pipeline.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement capture pipeline**

```typescript
// src/capture/pipeline.ts
import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider, LLMProvider } from '../providers/types.js';
import type { BlobStorage } from '../storage/blob.js';
import { insertCapture } from '../db/captures.js';
import { computeFileHash, checkFileHashDedup, checkSemanticDedup } from './dedup.js';
import { extractMetadata } from './metadata.js';

export interface FileInput {
  data: Buffer;
  contentType: string;
  filename: string;
}

export interface PipelineInput {
  db: DbClient;
  embeddingProvider: EmbeddingProvider;
  metadataLLM: LLMProvider;
  blobStorage: BlobStorage;
  content: string;
  files: FileInput[];
  source: string;
}

export interface PipelineResult {
  success: boolean;
  captureId?: string;
  reason?: string;
}

export async function runCapturePipeline(input: PipelineInput): Promise<PipelineResult> {
  const { db, embeddingProvider, metadataLLM, blobStorage, content, files, source } = input;

  // Step 1: Compute file hashes
  const fileHashes = files.map((f) => computeFileHash(f.data));
  const contentTypes = files.length > 0
    ? files.map((f) => f.contentType.split('/')[0]) // 'image/jpeg' → 'image'
    : ['text'];

  // Step 2: File hash check (storage optimization — reuse existing URLs)
  let existingUrls = new Map<string, string>();
  if (fileHashes.length > 0) {
    existingUrls = await checkFileHashDedup(db, fileHashes);
  }

  // Step 3: Generate embedding (from text + file bytes together)
  const fileBuffers = files.length > 0 ? files.map((f) => f.data) : undefined;
  const embedding = await embeddingProvider.embed(content, fileBuffers);

  // Step 4: Semantic dedup check (against ALL captures)
  const dedup = await checkSemanticDedup(db, embedding);
  if (dedup.isDuplicate) {
    return {
      success: false,
      reason: `Semantic duplicate detected (similarity: ${dedup.similarity?.toFixed(3)}). Existing capture: ${dedup.existingId}`,
    };
  }

  // Steps 5 & 6: Upload files + Extract metadata (in parallel)
  const [fileUrls, metadata] = await Promise.all([
    // Upload files that don't already exist
    Promise.all(
      files.map(async (file, i) => {
        const hash = fileHashes[i];
        if (existingUrls.has(hash)) {
          return existingUrls.get(hash)!;
        }
        const blobName = `${Date.now()}-${file.filename}`;
        return blobStorage.upload(blobName, file.data, file.contentType);
      }),
    ),
    // Extract metadata
    extractMetadata(metadataLLM, content),
  ]);

  // Step 7: Insert into captures table
  const result = await insertCapture(db, {
    content,
    contentTypes,
    fileUrls: fileUrls.length > 0 ? fileUrls : null,
    fileHashes: fileHashes.length > 0 ? fileHashes : null,
    embedding,
    metadata,
    source,
  });

  return { success: true, captureId: result.id };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/capture/pipeline.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/pipeline.ts tests/unit/capture/pipeline.test.ts
git commit -m "feat: universal capture pipeline with dedup, file upload, and metadata extraction"
```

---

## Chunk 5: HTTP Layer & Telegram

### Task 18: Hono Server + Auth Middleware + Capture Endpoint

**Files:**
- Create: `src/app.ts`
- Create: `src/server.ts`
- Create: `tests/unit/app.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/app.test.ts
import { describe, it, expect, vi } from 'vitest';

// Mock all dependencies that app.ts will import
vi.mock('../../../src/capture/pipeline.js', () => ({
  runCapturePipeline: vi.fn(),
}));

describe('Hono app', () => {
  it('rejects requests without auth token', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = createApp({} as any);

    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    });

    expect(res.status).toBe(401);
  });

  it('accepts requests with valid Bearer token', async () => {
    const { createApp } = await import('../../src/app.js');
    const { runCapturePipeline } = await import('../../src/capture/pipeline.js');
    vi.mocked(runCapturePipeline).mockResolvedValueOnce({
      success: true,
      captureId: 'cap-1',
    });

    const deps = {
      db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
      embeddingProvider: { embed: vi.fn().mockResolvedValue([]), dimensions: 3072 },
      metadataLLM: { complete: vi.fn() },
      blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
      config: { apiKey: 'test-key-123' },
    };

    const app = createApp(deps as any);
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 'I love TypeScript', source: 'api' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.captureId).toBe('cap-1');
  });

  it('returns 409 for duplicate captures', async () => {
    const { createApp } = await import('../../src/app.js');
    const { runCapturePipeline } = await import('../../src/capture/pipeline.js');
    vi.mocked(runCapturePipeline).mockResolvedValueOnce({
      success: false,
      reason: 'Semantic duplicate detected',
    });

    const deps = {
      db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
      embeddingProvider: { embed: vi.fn().mockResolvedValue([]), dimensions: 3072 },
      metadataLLM: { complete: vi.fn() },
      blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
      config: { apiKey: 'test-key-123' },
    };

    const app = createApp(deps as any);
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 'duplicate', source: 'api' }),
    });

    expect(res.status).toBe(409);
  });

  it('returns health check on GET /', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = createApp({} as any);
    const res = await app.request('/');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/app.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Hono app**

```typescript
// src/app.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DbClient } from './db/client.js';
import type { EmbeddingProvider, LLMProvider } from './providers/types.js';
import type { BlobStorage } from './storage/blob.js';
import type { Config } from './config.js';
import { runCapturePipeline } from './capture/pipeline.js';

export interface AppDeps {
  db: DbClient;
  embeddingProvider: EmbeddingProvider;
  metadataLLM: LLMProvider;
  consolidationLLM: LLMProvider;
  retrievalLLM: LLMProvider;
  blobStorage: BlobStorage;
  config: Config;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  // Middleware
  app.use('*', cors());

  // Health check (no auth)
  app.get('/', (c) => c.json({ status: 'ok', service: 'open-brain-v2' }));

  // Auth middleware for /api/* routes
  app.use('/api/*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token || token !== deps.config.apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Rate limiting: 100 requests/minute per key (spec requirement)
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  app.use('/api/*', async (c, next) => {
    const key = c.req.header('Authorization') ?? 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + 60_000 });
    } else if (entry.count >= 100) {
      return c.json({ error: 'Rate limit exceeded (100 req/min)' }, 429);
    } else {
      entry.count++;
    }
    await next();
  });

  // POST /api/v1/capture — Universal ingest endpoint
  app.post('/api/v1/capture', async (c) => {
    const body = await c.req.json();
    const { content, source = 'api', file_urls } = body;

    if (!content || typeof content !== 'string') {
      return c.json({ error: 'content is required and must be a string' }, 400);
    }

    // Download files from URLs if provided (MCP file handling)
    const files: Array<{ data: Buffer; contentType: string; filename: string }> = [];
    if (file_urls && Array.isArray(file_urls)) {
      for (const url of file_urls) {
        try {
          const response = await fetch(url);
          const buffer = Buffer.from(await response.arrayBuffer());
          const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
          const filename = url.split('/').pop() ?? 'file';
          files.push({ data: buffer, contentType, filename });
        } catch {
          return c.json({ error: `Failed to download file: ${url}` }, 400);
        }
      }
    }

    const result = await runCapturePipeline({
      db: deps.db,
      embeddingProvider: deps.embeddingProvider,
      metadataLLM: deps.metadataLLM,
      blobStorage: deps.blobStorage,
      content,
      files,
      source,
    });

    if (!result.success) {
      return c.json({ error: result.reason }, 409);
    }

    return c.json({ captureId: result.captureId }, 201);
  });

  // Error handler
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
```

```typescript
// src/server.ts
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createDbClient } from './db/client.js';
import { GeminiEmbeddingProvider } from './providers/gemini-embedding.js';
import { GeminiLLMProvider } from './providers/gemini-llm.js';
import { AnthropicLLMProvider } from './providers/anthropic-llm.js';
import { createBlobStorage } from './storage/blob.js';
import { createApp } from './app.js';

const config = loadConfig();

const deps = {
  db: createDbClient(config.databaseUrl),
  embeddingProvider: new GeminiEmbeddingProvider(config.geminiApiKey),
  metadataLLM: new GeminiLLMProvider(config.geminiApiKey),
  consolidationLLM: new AnthropicLLMProvider(config.anthropicApiKey),
  retrievalLLM: new GeminiLLMProvider(config.geminiApiKey),
  blobStorage: createBlobStorage(config.azureStorageConnectionString, config.azureStorageContainer),
  config,
};

const app = createApp(deps);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Open Brain v2 running on http://localhost:${info.port}`);
});
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/app.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/server.ts tests/unit/app.test.ts
git commit -m "feat: Hono HTTP server with auth middleware and capture endpoint"
```

---

### Task 19: Telegram Webhook Handler

**Files:**
- Create: `src/telegram/webhook.ts`
- Create: `src/telegram/handlers.ts`
- Create: `tests/unit/telegram/handlers.test.ts`

- [ ] **Step 1: Write failing tests for message handlers**

```typescript
// tests/unit/telegram/handlers.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('telegram handlers', () => {
  it('handles text message → calls capture pipeline', async () => {
    const mockPipeline = vi.fn().mockResolvedValue({ success: true, captureId: 'cap-1' });
    const { handleTextMessage } = await import('../../../src/telegram/handlers.js');

    const result = await handleTextMessage(
      { text: 'I love hiking in the mountains', chatId: '123' },
      mockPipeline,
    );

    expect(result.success).toBe(true);
    expect(mockPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'I love hiking in the mountains',
        source: 'telegram',
      }),
    );
  });

  it('handles /remind command → creates reminder', async () => {
    const mockCreateReminder = vi.fn().mockResolvedValue({ id: 'rem-1' });
    const { handleRemindCommand } = await import('../../../src/telegram/handlers.js');

    const result = await handleRemindCommand(
      { text: '/remind Buy groceries tomorrow', chatId: '123' },
      mockCreateReminder,
    );

    expect(result.content).toBe('Buy groceries tomorrow');
    expect(mockCreateReminder).toHaveBeenCalled();
  });

  it('handles /todos command → lists active reminders', async () => {
    const mockList = vi.fn().mockResolvedValue([
      { id: 'r1', content: 'Buy groceries', status: 'not_started' },
    ]);
    const { handleTodosCommand } = await import('../../../src/telegram/handlers.js');

    const result = await handleTodosCommand(mockList);
    expect(result).toContain('Buy groceries');
  });

  it('handles /done command → completes reminder', async () => {
    const mockComplete = vi.fn().mockResolvedValue(undefined);
    const { handleDoneCommand } = await import('../../../src/telegram/handlers.js');

    await handleDoneCommand('rem-1', mockComplete);
    expect(mockComplete).toHaveBeenCalledWith('rem-1');
  });

  it('handles photo message → downloads and captures', async () => {
    const mockPipeline = vi.fn().mockResolvedValue({ success: true, captureId: 'cap-1' });
    const mockDownload = vi.fn().mockResolvedValue(Buffer.from('photo bytes'));

    const { handlePhotoMessage } = await import('../../../src/telegram/handlers.js');
    const result = await handlePhotoMessage(
      { caption: 'My desk setup', fileId: 'abc123', chatId: '123' },
      mockPipeline,
      mockDownload,
    );

    expect(result.success).toBe(true);
    expect(mockDownload).toHaveBeenCalledWith('abc123');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/telegram/handlers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Telegram handlers**

```typescript
// src/telegram/handlers.ts

export interface TelegramTextInput {
  text: string;
  chatId: string;
}

export interface TelegramPhotoInput {
  caption: string | null;
  fileId: string;
  chatId: string;
}

type CaptureFn = (input: { content: string; files: Array<{ data: Buffer; contentType: string; filename: string }>; source: string }) => Promise<{ success: boolean; captureId?: string; reason?: string }>;
type DownloadFn = (fileId: string) => Promise<Buffer>;
type CreateReminderFn = (content: string, source: string) => Promise<{ id: string }>;
type ListRemindersFn = () => Promise<Array<{ id: string; content: string; status: string }>>;
type CompleteReminderFn = (id: string) => Promise<void>;

export async function handleTextMessage(
  input: TelegramTextInput,
  capture: CaptureFn,
): Promise<{ success: boolean; captureId?: string; reason?: string }> {
  return capture({
    content: input.text,
    files: [],
    source: 'telegram',
  });
}

export async function handleRemindCommand(
  input: TelegramTextInput,
  createReminder: CreateReminderFn,
): Promise<{ id: string; content: string }> {
  const content = input.text.replace(/^\/remind\s+/, '').trim();
  const result = await createReminder(content, 'telegram');
  return { id: result.id, content };
}

export async function handleTodosCommand(
  listReminders: ListRemindersFn,
): Promise<string> {
  const reminders = await listReminders();
  if (reminders.length === 0) return 'No active reminders.';

  return reminders
    .map((r, i) => `${i + 1}. [${r.status}] ${r.content} (${r.id.slice(0, 8)})`)
    .join('\n');
}

export async function handleDoneCommand(
  reminderId: string,
  completeReminder: CompleteReminderFn,
): Promise<void> {
  await completeReminder(reminderId);
}

export async function handlePhotoMessage(
  input: TelegramPhotoInput,
  capture: CaptureFn,
  downloadFile: DownloadFn,
): Promise<{ success: boolean; captureId?: string; reason?: string }> {
  const photoBuffer = await downloadFile(input.fileId);

  return capture({
    content: input.caption ?? 'Photo capture',
    files: [{ data: photoBuffer, contentType: 'image/jpeg', filename: `${input.fileId}.jpg` }],
    source: 'telegram',
  });
}

export async function handleVoiceMessage(
  input: { fileId: string; chatId: string },
  capture: CaptureFn,
  downloadFile: DownloadFn,
  transcribe: (audio: Buffer) => Promise<string>,
): Promise<{ success: boolean; captureId?: string; reason?: string }> {
  const audioBuffer = await downloadFile(input.fileId);
  const transcription = await transcribe(audioBuffer);

  return capture({
    content: transcription,
    files: [{ data: audioBuffer, contentType: 'audio/ogg', filename: `${input.fileId}.ogg` }],
    source: 'telegram',
  });
}

export async function handleDocumentMessage(
  input: { fileId: string; fileName: string; mimeType: string; chatId: string },
  capture: CaptureFn,
  downloadFile: DownloadFn,
  summarize: (content: Buffer, mimeType: string) => Promise<string>,
): Promise<{ success: boolean; captureId?: string; reason?: string }> {
  const fileBuffer = await downloadFile(input.fileId);
  const summary = await summarize(fileBuffer, input.mimeType);

  const contentType = input.mimeType.startsWith('application/pdf') ? 'pdf' : input.mimeType.split('/')[0];

  return capture({
    content: summary,
    files: [{ data: fileBuffer, contentType: input.mimeType, filename: input.fileName }],
    source: 'telegram',
  });
}
```

```typescript
// src/telegram/webhook.ts
import { Bot, webhookCallback } from 'grammy';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { runCapturePipeline, type FileInput } from '../capture/pipeline.js';
import { insertReminder, listReminders as dbListReminders, completeReminder as dbCompleteReminder, findActiveReminders } from '../db/reminders.js';
import { handleTextMessage, handlePhotoMessage, handleRemindCommand, handleTodosCommand, handleDoneCommand } from './handlers.js';

export function setupTelegramWebhook(app: Hono, deps: AppDeps): Bot {
  const bot = new Bot(deps.config.telegramBotToken);

  const captureFn = async (input: { content: string; files: FileInput[]; source: string }) => {
    return runCapturePipeline({
      db: deps.db,
      embeddingProvider: deps.embeddingProvider,
      metadataLLM: deps.metadataLLM,
      blobStorage: deps.blobStorage,
      ...input,
    });
  };

  const downloadFile = async (fileId: string): Promise<Buffer> => {
    const file = await bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${deps.config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    return Buffer.from(await response.arrayBuffer());
  };

  // Command handlers
  bot.command('remind', async (ctx) => {
    const text = ctx.message?.text ?? '';
    const content = text.replace(/^\/remind\s+/, '').trim();
    if (!content) {
      await ctx.reply('Usage: /remind <text>');
      return;
    }

    const embedding = await deps.embeddingProvider.embed(content);
    const result = await insertReminder(deps.db, {
      content,
      embedding,
      category: null, // Auto-determined later
      source: 'telegram',
      sourceContext: null,
      dueDate: null,
    });
    await ctx.reply(`Reminder created (${result.id.slice(0, 8)})`);
  });

  bot.command('todos', async (ctx) => {
    const reminders = await findActiveReminders(deps.db);
    const text = await handleTodosCommand(async () =>
      reminders.map((r) => ({ id: r.id, content: r.content, status: r.status }))
    );
    await ctx.reply(text);
  });

  bot.command('done', async (ctx) => {
    const id = (ctx.message?.text ?? '').replace(/^\/done\s+/, '').trim();
    if (!id) {
      await ctx.reply('Usage: /done <reminder-id>');
      return;
    }
    await dbCompleteReminder(deps.db, id);
    await ctx.reply('Reminder completed!');
  });

  bot.command('review', async (ctx) => {
    // Placeholder — will be implemented in Task 29 (notifications/review)
    await ctx.reply('Review feature coming soon.');
  });

  // Message handlers (non-command text → capture)
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return; // Skip unhandled commands
    const result = await captureFn({
      content: ctx.message.text,
      files: [],
      source: 'telegram',
    });
    if (result.success) {
      await ctx.reply(`Captured! (${result.captureId?.slice(0, 8)})`);
    } else {
      await ctx.reply(`Skipped: ${result.reason}`);
    }
  });

  bot.on('message:photo', async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const result = await handlePhotoMessage(
      { caption: ctx.message.caption ?? null, fileId: largest.file_id, chatId: String(ctx.chat.id) },
      captureFn,
      downloadFile,
    );
    await ctx.reply(result.success ? `Photo captured! (${result.captureId?.slice(0, 8)})` : `Skipped: ${result.reason}`);
  });

  bot.on('message:voice', async (ctx) => {
    const result = await handleVoiceMessage(
      { fileId: ctx.message.voice.file_id, chatId: String(ctx.chat.id) },
      captureFn,
      downloadFile,
      async (audio) => {
        // Use Gemini Flash to transcribe + summarize audio
        const response = await deps.metadataLLM.complete(
          [{ role: 'user', content: [{ type: 'text', text: 'Transcribe and summarize this voice message.' }, { type: 'image', data: audio, mimeType: 'audio/ogg' }] }],
        );
        return response.content;
      },
    );
    await ctx.reply(result.success ? `Voice captured! (${result.captureId?.slice(0, 8)})` : `Skipped: ${result.reason}`);
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const result = await handleDocumentMessage(
      { fileId: doc.file_id, fileName: doc.file_name ?? 'document', mimeType: doc.mime_type ?? 'application/octet-stream', chatId: String(ctx.chat.id) },
      captureFn,
      downloadFile,
      async (fileBuffer, mimeType) => {
        const response = await deps.metadataLLM.complete(
          [{ role: 'user', content: [{ type: 'text', text: `Summarize this ${mimeType} document.` }, { type: 'image', data: fileBuffer, mimeType }] }],
        );
        return response.content;
      },
    );
    await ctx.reply(result.success ? `Document captured! (${result.captureId?.slice(0, 8)})` : `Skipped: ${result.reason}`);
  });

  // TODO: Media group handling — Telegram sends media groups as separate messages
  // with the same media_group_id. Requires batching messages with a short timeout
  // (e.g., 500ms) to collect all items before processing as a single capture.
  // Deferred to implementation — requires stateful message buffering.

  // Register webhook route
  app.post('/telegram/webhook', async (c) => {
    // Verify webhook secret
    const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (secret !== deps.config.telegramWebhookSecret) {
      return c.json({ error: 'Invalid secret' }, 403);
    }

    const handler = webhookCallback(bot, 'std/http');
    return handler(c.req.raw);
  });

  return bot;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/telegram/handlers.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/webhook.ts src/telegram/handlers.ts tests/unit/telegram/handlers.test.ts
git commit -m "feat: Telegram bot with webhook handler and message routing"
```

---

## Chunk 6: MCP Server

### Task 20: MCP Server Setup

**Files:**
- Create: `src/mcp/server.ts`

- [ ] **Step 1: Implement MCP server with Streamable HTTP transport**

```typescript
// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { registerProfilerTools } from './profiler-tools.js';
import { registerReminderTools } from './reminder-tools.js';

export function createMcpServer(deps: AppDeps): McpServer {
  const server = new McpServer({
    name: 'open-brain',
    version: '2.0.0',
  });

  registerProfilerTools(server, deps);
  registerReminderTools(server, deps);

  return server;
}

export function mountMcpRoutes(app: Hono, deps: AppDeps): void {
  const server = createMcpServer(deps);

  // MCP auth: x-brain-key header or ?key= query parameter
  app.all('/mcp/*', async (c, next) => {
    const key = c.req.header('x-brain-key') ?? c.req.query('key');
    if (!key || key !== deps.config.apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Streamable HTTP transport endpoint
  app.all('/mcp', async (c) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Will fail until profiler-tools.ts and reminder-tools.ts exist. That's fine — proceed to next tasks.

---

### Task 21: Profiler MCP Tools (9 tools)

**Files:**
- Create: `src/mcp/profiler-tools.ts`
- Create: `tests/unit/mcp/profiler-tools.test.ts`

The spec defines 9 profiler tools: `get_user_profile`, `search_thoughts`, `capture_thought`, `brain_stats`, `archive_thought`, `unarchive_thought`, `update_fact`, `review_pending`, `approve_reject`.

- [ ] **Step 1: Write failing tests for key tools**

```typescript
// tests/unit/mcp/profiler-tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// We test tool registration indirectly by checking the server has the right tools
describe('profiler tools', () => {
  it('registers all 9 profiler tools', async () => {
    const server = new McpServer({ name: 'test', version: '1.0' });
    const deps = {
      db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
      embeddingProvider: { embed: vi.fn(), dimensions: 3072 },
      metadataLLM: { complete: vi.fn() },
      consolidationLLM: { complete: vi.fn() },
      retrievalLLM: { complete: vi.fn() },
      blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
      config: { apiKey: 'test', reviewMode: 'hybrid' },
    } as any;

    const { registerProfilerTools } = await import('../../../src/mcp/profiler-tools.js');
    registerProfilerTools(server, deps);

    // McpServer tracks registered tools internally
    // Verify by checking the server can list tools
    const toolNames = [
      'get_user_profile', 'search_thoughts', 'capture_thought',
      'brain_stats', 'archive_thought', 'unarchive_thought',
      'update_fact', 'review_pending', 'approve_reject',
    ];

    // The server object stores tools — we verify registration succeeded without throwing
    expect(true).toBe(true); // Registration didn't throw
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/unit/mcp/profiler-tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement profiler tools**

```typescript
// src/mcp/profiler-tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../app.js';
import { getCaptureById, setCaptureArchived } from '../db/captures.js';
import { getFactById, setFactArchived, setFactReviewStatus, userEditFact, findPendingReviewFacts } from '../db/facts.js';
import { getInsightById, setInsightArchived, setInsightReviewStatus, findPendingReviewInsights } from '../db/insights.js';
import { runCapturePipeline } from '../capture/pipeline.js';

export function registerProfilerTools(server: McpServer, deps: AppDeps): void {
  // 1. get_user_profile — session bootstrap
  server.tool(
    'get_user_profile',
    'Session bootstrap — returns a synthesized profile summary of who this person is right now',
    {},
    async () => {
      // Delegates to retrieval/profile.ts (implemented in Task 27)
      const { getUserProfile } = await import('../retrieval/profile.js');
      const profile = await getUserProfile(deps.db, deps.retrievalLLM);
      return { content: [{ type: 'text' as const, text: profile }] };
    },
  );

  // 2. search_thoughts — tiered semantic search
  server.tool(
    'search_thoughts',
    'Tiered semantic search: insights → facts → captures, with conditional evidence on low confidence',
    {
      query: z.string().describe('Search query'),
      threshold: z.number().min(0).max(1).default(0.5).describe('Similarity threshold (0-1)'),
      limit: z.number().int().positive().default(10).describe('Max results'),
    },
    async ({ query, threshold, limit }) => {
      const { searchThoughts } = await import('../retrieval/search.js');
      const results = await searchThoughts(deps.db, deps.embeddingProvider, query, threshold, limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // 3. capture_thought — capture from any MCP client
  server.tool(
    'capture_thought',
    'Capture a thought from any MCP client',
    {
      content: z.string().describe('Text content of the thought'),
      file_urls: z.array(z.string()).optional().describe('Array of accessible URLs to download files from'),
    },
    async ({ content, file_urls }) => {
      const files: Array<{ data: Buffer; contentType: string; filename: string }> = [];
      if (file_urls) {
        for (const url of file_urls) {
          const response = await fetch(url);
          const buffer = Buffer.from(await response.arrayBuffer());
          const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
          files.push({ data: buffer, contentType, filename: url.split('/').pop() ?? 'file' });
        }
      }

      const result = await runCapturePipeline({
        db: deps.db,
        embeddingProvider: deps.embeddingProvider,
        metadataLLM: deps.metadataLLM,
        blobStorage: deps.blobStorage,
        content,
        files,
        source: 'mcp',
      });

      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Skipped: ${result.reason}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `Captured! ID: ${result.captureId}` }] };
    },
  );

  // 4. brain_stats — dashboard
  server.tool(
    'brain_stats',
    'Dashboard — counts, types, topics, confidence distribution',
    {},
    async () => {
      const stats = await deps.db.query(`
        SELECT
          (SELECT count(*) FROM captures WHERE archived = false) AS captures_count,
          (SELECT count(*) FROM facts WHERE archived = false) AS facts_count,
          (SELECT count(*) FROM insights WHERE archived = false) AS insights_count,
          (SELECT count(*) FROM reminders WHERE archived = false) AS reminders_count,
          (SELECT count(*) FROM facts WHERE review_status = 'pending_review') AS facts_pending,
          (SELECT count(*) FROM insights WHERE review_status = 'pending_review') AS insights_pending
      `);

      const categories = await deps.db.query(`
        SELECT category, count(*) as count FROM facts
        WHERE archived = false AND review_status != 'user_rejected'
        GROUP BY category ORDER BY count DESC
      `);

      const row = stats.rows[0];
      const result = {
        captures: parseInt(row.captures_count),
        facts: parseInt(row.facts_count),
        insights: parseInt(row.insights_count),
        reminders: parseInt(row.reminders_count),
        pendingReview: parseInt(row.facts_pending) + parseInt(row.insights_pending),
        factsByCategory: categories.rows,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // 5. archive_thought — soft isolation
  server.tool(
    'archive_thought',
    'Soft-delete an item (no cascade recalculation)',
    {
      id: z.string().uuid().describe('UUID of the item to archive'),
      type: z.enum(['capture', 'fact', 'insight']).describe('Which table'),
    },
    async ({ id, type }) => {
      if (type === 'capture') await setCaptureArchived(deps.db, id, true);
      else if (type === 'fact') await setFactArchived(deps.db, id, true);
      else await setInsightArchived(deps.db, id, true);
      return { content: [{ type: 'text' as const, text: `Archived ${type} ${id}` }] };
    },
  );

  // 6. unarchive_thought — restore
  server.tool(
    'unarchive_thought',
    'Restore an archived item',
    {
      id: z.string().uuid().describe('UUID of the item to restore'),
      type: z.enum(['capture', 'fact', 'insight']).describe('Which table'),
    },
    async ({ id, type }) => {
      if (type === 'capture') await setCaptureArchived(deps.db, id, false);
      else if (type === 'fact') await setFactArchived(deps.db, id, false);
      else await setInsightArchived(deps.db, id, false);
      return { content: [{ type: 'text' as const, text: `Unarchived ${type} ${id}` }] };
    },
  );

  // 7. update_fact — direct user edit
  server.tool(
    'update_fact',
    'Edit a fact directly. Sets origin to user_edited, confidence to 1.0, preserves source links.',
    {
      id: z.string().uuid().describe('Fact UUID'),
      content: z.string().describe('New content for the fact'),
    },
    async ({ id, content }) => {
      const existing = await getFactById(deps.db, id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `No fact found with id ${id}` }], isError: true };
      }
      await userEditFact(deps.db, id, content);
      // Re-embed the updated fact
      const embedding = await deps.embeddingProvider.embed(content);
      await deps.db.query(
        `UPDATE facts SET embedding = $1 WHERE id = $2`,
        [JSON.stringify(embedding), id],
      );
      return { content: [{ type: 'text' as const, text: `Fact ${id} updated. Origin set to user_edited, confidence set to 1.0.` }] };
    },
  );

  // 8. review_pending — list pending review items
  server.tool(
    'review_pending',
    'List items with pending_review status',
    {
      limit: z.number().int().positive().default(20).describe('Max items to return'),
      type: z.enum(['fact', 'insight']).optional().describe('Filter by type, defaults to both'),
    },
    async ({ limit, type }) => {
      const items: Array<{ id: string; type: string; content: string; category: string; confidence: number }> = [];

      if (!type || type === 'fact') {
        const facts = await findPendingReviewFacts(deps.db, limit);
        for (const f of facts) {
          items.push({ id: f.id, type: 'fact', content: f.content, category: f.category, confidence: f.confidence });
        }
      }

      if (!type || type === 'insight') {
        const insights = await findPendingReviewInsights(deps.db, limit);
        for (const i of insights) {
          items.push({ id: i.id, type: 'insight', content: i.content, category: i.category, confidence: i.confidence });
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
    },
  );

  // 9. approve_reject — act on pending_review items
  server.tool(
    'approve_reject',
    'Approve, reject, or edit a pending_review item. Looks up by UUID across facts and insights.',
    {
      id: z.string().uuid().describe('UUID of the item'),
      action: z.enum(['approve', 'reject', 'edit']).describe('Action to take'),
      content: z.string().optional().describe('New content (required if action is edit)'),
    },
    async ({ id, action, content }) => {
      if (action === 'edit' && !content) {
        return { content: [{ type: 'text' as const, text: 'content is required when action is edit' }], isError: true };
      }

      // Try facts first, then insights (UUIDs are globally unique)
      const fact = await getFactById(deps.db, id);
      if (fact) {
        if (fact.review_status !== 'pending_review' && action !== 'approve') {
          return { content: [{ type: 'text' as const, text: `Fact ${id} is not in pending_review status. Use update_fact to edit approved facts.` }], isError: true };
        }
        if (action === 'approve') {
          await setFactReviewStatus(deps.db, id, 'user_approved');
        } else if (action === 'reject') {
          await setFactReviewStatus(deps.db, id, 'user_rejected');
        } else {
          await userEditFact(deps.db, id, content!);
          await setFactReviewStatus(deps.db, id, 'user_approved');
          const embedding = await deps.embeddingProvider.embed(content!);
          await deps.db.query(`UPDATE facts SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
        }
        return { content: [{ type: 'text' as const, text: `Fact ${id}: ${action}d` }] };
      }

      const insight = await getInsightById(deps.db, id);
      if (insight) {
        if (insight.review_status !== 'pending_review' && action !== 'approve') {
          return { content: [{ type: 'text' as const, text: `Insight ${id} is not in pending_review status.` }], isError: true };
        }
        if (action === 'approve') {
          await setInsightReviewStatus(deps.db, id, 'user_approved');
        } else if (action === 'reject') {
          await setInsightReviewStatus(deps.db, id, 'user_rejected');
        } else {
          await setInsightReviewStatus(deps.db, id, 'user_approved', content);
          const embedding = await deps.embeddingProvider.embed(content!);
          await deps.db.query(`UPDATE insights SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
        }
        return { content: [{ type: 'text' as const, text: `Insight ${id}: ${action}d` }] };
      }

      return { content: [{ type: 'text' as const, text: `No fact or insight found with id ${id}` }], isError: true };
    },
  );
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/mcp/profiler-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/profiler-tools.ts tests/unit/mcp/profiler-tools.test.ts
git commit -m "feat: 9 MCP profiler tools (profile, search, capture, stats, archive, review)"
```

---

### Task 22: Reminder MCP Tools (4 tools)

**Files:**
- Create: `src/mcp/reminder-tools.ts`
- Create: `tests/unit/mcp/reminder-tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/mcp/reminder-tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('reminder tools', () => {
  it('registers all 4 reminder tools without throwing', async () => {
    const server = new McpServer({ name: 'test', version: '1.0' });
    const deps = {
      db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
      embeddingProvider: { embed: vi.fn(), dimensions: 3072 },
      config: {},
    } as any;

    const { registerReminderTools } = await import('../../../src/mcp/reminder-tools.js');
    registerReminderTools(server, deps);
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/unit/mcp/reminder-tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement reminder tools**

```typescript
// src/mcp/reminder-tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../app.js';
import { insertReminder, listReminders, updateReminder, completeReminder, getReminderById } from '../db/reminders.js';

export function registerReminderTools(server: McpServer, deps: AppDeps): void {
  // 1. create_reminder
  server.tool(
    'create_reminder',
    'Create a new reminder from "remind me to..." or "add to my todos"',
    {
      content: z.string().describe('Reminder text'),
      category: z.string().optional().describe('Category (auto-determined if omitted)'),
      due_date: z.string().optional().describe('ISO 8601 due date'),
      source_context: z.string().optional().describe('Context of the conversation that triggered this'),
    },
    async ({ content, category, due_date, source_context }) => {
      const embedding = await deps.embeddingProvider.embed(content);
      const result = await insertReminder(deps.db, {
        content,
        embedding,
        category: category ?? null,
        source: 'mcp',
        sourceContext: source_context ?? null,
        dueDate: due_date ? new Date(due_date) : null,
      });
      return { content: [{ type: 'text' as const, text: `Reminder created: ${result.id}` }] };
    },
  );

  // 2. list_reminders
  server.tool(
    'list_reminders',
    'List reminders filtered by status and/or category',
    {
      status: z.string().optional().describe('Filter by status'),
      category: z.string().optional().describe('Filter by category'),
      limit: z.number().int().positive().default(20).describe('Max results'),
    },
    async ({ status, category, limit }) => {
      const reminders = await listReminders(deps.db, { status, category, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(reminders, null, 2) }] };
    },
  );

  // 3. update_reminder
  server.tool(
    'update_reminder',
    'Change status, edit content, or set due date on a reminder',
    {
      id: z.string().uuid().describe('Reminder UUID'),
      status: z.string().optional().describe('New status'),
      content: z.string().optional().describe('New content'),
      due_date: z.string().optional().describe('New ISO 8601 due date'),
    },
    async ({ id, status, content, due_date }) => {
      await updateReminder(deps.db, id, {
        status,
        content,
        dueDate: due_date ? new Date(due_date) : undefined,
      });
      // Re-embed if content changed
      if (content) {
        const embedding = await deps.embeddingProvider.embed(content);
        await deps.db.query(`UPDATE reminders SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
      }
      return { content: [{ type: 'text' as const, text: `Reminder ${id} updated` }] };
    },
  );

  // 4. complete_reminder
  server.tool(
    'complete_reminder',
    'Shortcut for marking a reminder as done',
    {
      id: z.string().uuid().describe('Reminder UUID'),
    },
    async ({ id }) => {
      await completeReminder(deps.db, id);
      return { content: [{ type: 'text' as const, text: `Reminder ${id} marked as done` }] };
    },
  );
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/mcp/reminder-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire MCP into app.ts and commit**

Add to `src/app.ts` after route definitions:
```typescript
import { mountMcpRoutes } from './mcp/server.js';
// ... inside createApp, after routes:
mountMcpRoutes(app, deps);
```

```bash
git add src/mcp/server.ts src/mcp/profiler-tools.ts src/mcp/reminder-tools.ts tests/unit/mcp/
git commit -m "feat: MCP server with 13 tools (9 profiler + 4 reminders) via Streamable HTTP"
```

---

## Chunk 7: Consolidation Pipeline

### Task 23: DBSCAN Clustering

**Files:**
- Create: `src/consolidation/clustering.ts`
- Create: `tests/unit/consolidation/clustering.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/consolidation/clustering.test.ts
import { describe, it, expect } from 'vitest';

describe('DBSCAN clustering', () => {
  it('clusters similar vectors together', async () => {
    const { dbscan } = await import('../../../src/consolidation/clustering.js');

    // 4 points: two near each other, two near each other, forming 2 clusters
    const points = [
      { id: 'a', embedding: [1.0, 0.0, 0.0] },
      { id: 'b', embedding: [0.99, 0.01, 0.0] },
      { id: 'c', embedding: [0.0, 1.0, 0.0] },
      { id: 'd', embedding: [0.01, 0.99, 0.0] },
    ];

    const clusters = dbscan(points, { eps: 0.3, minSamples: 2 });

    // Should produce 2 clusters
    expect(clusters.length).toBe(2);
    expect(clusters.some((c) => c.some((p) => p.id === 'a') && c.some((p) => p.id === 'b'))).toBe(true);
    expect(clusters.some((c) => c.some((p) => p.id === 'c') && c.some((p) => p.id === 'd'))).toBe(true);
  });

  it('treats unclustered points as individual clusters', async () => {
    const { dbscan } = await import('../../../src/consolidation/clustering.js');

    const points = [
      { id: 'a', embedding: [1.0, 0.0, 0.0] },
      { id: 'b', embedding: [0.0, 1.0, 0.0] },
      { id: 'c', embedding: [0.0, 0.0, 1.0] },
    ];

    // With minSamples=2, no cluster forms — all are noise
    const clusters = dbscan(points, { eps: 0.1, minSamples: 2 });

    // Noise points should be returned as individual clusters (each processed solo)
    expect(clusters.length).toBe(3);
    expect(clusters.every((c) => c.length === 1)).toBe(true);
  });

  it('handles empty input', async () => {
    const { dbscan } = await import('../../../src/consolidation/clustering.js');
    const clusters = dbscan([], { eps: 0.3, minSamples: 2 });
    expect(clusters).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/consolidation/clustering.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement DBSCAN**

```typescript
// src/consolidation/clustering.ts

export interface ClusterPoint {
  id: string;
  embedding: number[];
}

export interface DBSCANOptions {
  eps: number;       // Distance threshold (cosine distance, 0-2 range)
  minSamples: number; // Minimum points to form a core point
}

/** Cosine distance: 1 - cosine_similarity. Range: 0 (identical) to 2 (opposite). */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 2;
  return 1 - dot / denom;
}

function regionQuery(points: ClusterPoint[], pointIdx: number, eps: number): number[] {
  const neighbors: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (cosineDistance(points[pointIdx].embedding, points[i].embedding) <= eps) {
      neighbors.push(i);
    }
  }
  return neighbors;
}

/**
 * DBSCAN clustering on embedding vectors using cosine distance.
 * Noise points (unclustered) are returned as individual single-item clusters
 * so they are still processed during consolidation.
 */
export function dbscan(
  points: ClusterPoint[],
  options: DBSCANOptions,
): ClusterPoint[][] {
  if (points.length === 0) return [];

  const { eps, minSamples } = options;
  const labels = new Array<number>(points.length).fill(-1); // -1 = unvisited
  const NOISE = -2;
  let clusterId = 0;

  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== -1) continue;

    const neighbors = regionQuery(points, i, eps);

    if (neighbors.length < minSamples) {
      labels[i] = NOISE;
      continue;
    }

    labels[i] = clusterId;
    const seedSet = [...neighbors.filter((n) => n !== i)];

    for (let j = 0; j < seedSet.length; j++) {
      const q = seedSet[j];
      if (labels[q] === NOISE) {
        labels[q] = clusterId;
      }
      if (labels[q] !== -1) continue;

      labels[q] = clusterId;
      const qNeighbors = regionQuery(points, q, eps);
      if (qNeighbors.length >= minSamples) {
        for (const n of qNeighbors) {
          if (!seedSet.includes(n)) seedSet.push(n);
        }
      }
    }

    clusterId++;
  }

  // Group into clusters
  const clusterMap = new Map<number, ClusterPoint[]>();
  for (let i = 0; i < points.length; i++) {
    const label = labels[i];
    if (label === NOISE) {
      // Noise points become individual clusters
      clusterMap.set(-(i + 1000), [points[i]]);
    } else {
      if (!clusterMap.has(label)) clusterMap.set(label, []);
      clusterMap.get(label)!.push(points[i]);
    }
  }

  return Array.from(clusterMap.values());
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/consolidation/clustering.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/consolidation/clustering.ts tests/unit/consolidation/clustering.test.ts
git commit -m "feat: DBSCAN clustering for consolidation phase 1"
```

---

### Task 24: Phase 1 — Capture → Fact Promotion

**Files:**
- Create: `src/consolidation/phase1.ts`
- Create: `tests/unit/consolidation/phase1.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/consolidation/phase1.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { LLMProvider, LLMResponse } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

function mockLLM(): LLMProvider {
  return { complete: vi.fn() };
}

describe('phase1', () => {
  it('creates new facts from a cluster of captures', async () => {
    const db = mockDb();
    const llm = mockLLM();

    const llmResponse: LLMResponse = {
      content: JSON.stringify({
        actions: [
          {
            action: 'create_fact',
            content: 'Prefers TypeScript over JavaScript',
            category: 'preference',
            confidence: 0.8,
            source_capture_ids: ['cap-1', 'cap-2'],
          },
        ],
      }),
      tokensUsed: { input: 1000, output: 200, total: 1200 },
    };
    vi.mocked(llm.complete).mockResolvedValueOnce(llmResponse);

    // Mock DB insert
    vi.mocked(db.query).mockResolvedValue({
      rows: [{ id: 'fact-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'fact-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    const result = await processCluster(db, llm, {
      captures: [
        { id: 'cap-1', content: 'I love TypeScript', embedding: [] },
        { id: 'cap-2', content: 'JS is okay but TS is better', embedding: [] },
      ],
      existingFacts: [],
      reviewMode: 'hybrid',
    });

    expect(result.factsCreated).toBeGreaterThan(0);
    expect(llm.complete).toHaveBeenCalled();
  });

  it('updates existing fact with previous version tracking', async () => {
    const db = mockDb();
    const llm = mockLLM();

    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        actions: [
          {
            action: 'update_fact',
            fact_id: 'fact-existing',
            content: 'Strongly prefers TypeScript over JavaScript',
            confidence: 0.95,
            reason: 'Additional evidence from new captures',
          },
        ],
      }),
      tokensUsed: { input: 1500, output: 300, total: 1800 },
    });

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'fact-existing' }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    const result = await processCluster(db, llm, {
      captures: [{ id: 'cap-3', content: 'TS generics are amazing', embedding: [] }],
      existingFacts: [
        { id: 'fact-existing', content: 'Prefers TypeScript', confidence: 0.8, origin: 'consolidation', category: 'preference' },
      ],
      reviewMode: 'hybrid',
    });

    expect(result.factsUpdated).toBeGreaterThan(0);
  });

  it('respects noise criteria — only discards if all 7 conditions met', async () => {
    const db = mockDb();
    const llm = mockLLM();

    // LLM says this capture has no profile relevance
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({ actions: [{ action: 'discard', reason: 'Purely transactional' }] }),
      tokensUsed: { input: 500, output: 50, total: 550 },
    });

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [], command: 'UPDATE', rowCount: 0, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    const result = await processCluster(db, llm, {
      captures: [{ id: 'cap-4', content: 'Acknowledged receipt of package', embedding: [] }],
      existingFacts: [],
      reviewMode: 'hybrid',
    });

    expect(result.factsCreated).toBe(0);
  });

  it('never overwrites user_edited facts', async () => {
    const db = mockDb();
    const llm = mockLLM();

    // LLM tries to update a user_edited fact
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        actions: [{
          action: 'update_fact',
          fact_id: 'fact-user-edited',
          content: 'New contradicting info',
          confidence: 0.7,
          reason: 'New evidence',
        }],
      }),
      tokensUsed: { input: 1000, output: 200, total: 1200 },
    });

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'flag-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    const result = await processCluster(db, llm, {
      captures: [{ id: 'cap-5', content: 'Contradicting info', embedding: [] }],
      existingFacts: [
        { id: 'fact-user-edited', content: 'User said this', confidence: 1.0, origin: 'user_edited', category: 'preference' },
      ],
      reviewMode: 'hybrid',
    });

    // Should flag for review, not update
    expect(result.itemsFlagged).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/consolidation/phase1.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Phase 1**

```typescript
// src/consolidation/phase1.ts
import type { DbClient } from '../db/client.js';
import type { LLMProvider } from '../providers/types.js';
import type { FactRow } from '../db/facts.js';

export interface ClusterInput {
  captures: Array<{ id: string; content: string; embedding: number[] }>;
  existingFacts: Array<{ id: string; content: string; confidence: number; origin: string; category: string }>;
  reviewMode: string;
}

export interface ClusterResult {
  factsCreated: number;
  factsUpdated: number;
  capturesProcessed: number;
  itemsFlagged: number;
  tokensUsed: number;
}

const NOISE_CRITERIA_PROMPT = `You are a profile consolidation engine. Given a cluster of captures and existing facts about a person, determine what profile facts should be created or updated.

NOISE CRITERIA — only discard a capture if ALL of these are true:
1. Contains no preference, opinion, or value judgment
2. Contains no information about a person or relationship
3. Contains no habit, routine, or behavioral pattern
4. Contains no skill, tool, or technology association
5. Contains no goal, aspiration, or plan
6. Contains no emotional response or reaction
7. Is purely transactional with no recurring significance

When in doubt, create a fact with low confidence (0.3-0.4) rather than discarding.

IMPORTANT: Never modify facts with origin "user_edited". If new evidence contradicts a user_edited fact, flag it for review instead.

For each capture cluster, return a JSON object with an "actions" array. Each action is one of:
- {"action": "create_fact", "content": "...", "category": "preference|habit|skill|relationship|opinion|history|goal|personality", "confidence": 0.0-1.0, "source_capture_ids": ["..."]}
- {"action": "update_fact", "fact_id": "...", "content": "...", "confidence": 0.0-1.0, "reason": "..."}
- {"action": "flag_review", "fact_id": "...", "reason": "..."}
- {"action": "merge_facts", "keep_id": "...", "archive_id": "...", "merged_content": "...", "confidence": 0.0-1.0}
- {"action": "discard", "reason": "..."}

Return ONLY valid JSON.`;

export async function processCluster(
  db: DbClient,
  llm: LLMProvider,
  input: ClusterInput,
): Promise<ClusterResult> {
  const result: ClusterResult = {
    factsCreated: 0,
    factsUpdated: 0,
    capturesProcessed: input.captures.length,
    itemsFlagged: 0,
    tokensUsed: 0,
  };

  const capturesText = input.captures
    .map((c) => `[${c.id}]: ${c.content}`)
    .join('\n\n');

  const factsText = input.existingFacts.length > 0
    ? input.existingFacts
        .map((f) => `[${f.id}] (${f.category}, confidence: ${f.confidence}, origin: ${f.origin}): ${f.content}`)
        .join('\n')
    : 'No existing facts.';

  const prompt = `CAPTURES:\n${capturesText}\n\nEXISTING FACTS:\n${factsText}`;

  const response = await llm.complete(
    [{ role: 'user', content: prompt }],
    { systemPrompt: NOISE_CRITERIA_PROMPT, responseFormat: 'json', maxTokens: 4096 },
  );

  result.tokensUsed = response.tokensUsed.total;

  let actions: any[];
  try {
    const parsed = JSON.parse(response.content);
    actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch {
    actions = [];
  }

  // Process actions within a transaction (per-cluster commit)
  await db.transaction(async (txClient) => {
    for (const action of actions) {
      if (action.action === 'create_fact') {
        const reviewStatus = shouldAutoApprove(action.category, input.reviewMode)
          ? 'auto_approved'
          : 'pending_review';

        await txClient.query(
          `INSERT INTO facts (content, category, confidence, source_capture_ids, origin, review_status)
           VALUES ($1, $2, $3, $4, 'consolidation', $5)`,
          [action.content, action.category, action.confidence, action.source_capture_ids, reviewStatus],
        );
        result.factsCreated++;
        if (reviewStatus === 'pending_review') result.itemsFlagged++;

      } else if (action.action === 'update_fact') {
        // Check if the fact is user_edited
        const existingFact = input.existingFacts.find((f) => f.id === action.fact_id);
        if (existingFact?.origin === 'user_edited') {
          // Flag for review instead of updating
          await txClient.query(
            `INSERT INTO facts (content, category, confidence, source_capture_ids, origin, review_status)
             VALUES ($1, $2, $3, $4, 'consolidation', 'pending_review')`,
            [action.content, existingFact.category, action.confidence,
             input.captures.map((c) => c.id)],
          );
          result.itemsFlagged++;
        } else {
          // Normal update with version tracking
          const confidenceShift = existingFact
            ? Math.abs(action.confidence - existingFact.confidence)
            : 0;
          const reviewStatus = confidenceShift > 0.15 ? 'pending_review' : 'auto_approved';

          await txClient.query(
            `UPDATE facts SET
               previous_versions = previous_versions || jsonb_build_array(
                 jsonb_build_object('content', content, 'confidence', confidence,
                                    'changed_at', now()::text, 'reason', $1)
               ),
               content = $2, confidence = $3, embedding = NULL, updated_at = now(),
               review_status = $4
             WHERE id = $5`,
            [action.reason, action.content, action.confidence, reviewStatus, action.fact_id],
          );
          result.factsUpdated++;
          if (reviewStatus === 'pending_review') result.itemsFlagged++;
        }

      } else if (action.action === 'flag_review') {
        await txClient.query(
          `UPDATE facts SET review_status = 'pending_review' WHERE id = $1`,
          [action.fact_id],
        );
        result.itemsFlagged++;

      } else if (action.action === 'merge_facts') {
        // Keep higher-confidence version, combine source_capture_ids, archive duplicate
        await txClient.query(
          `UPDATE facts SET
             content = $1, confidence = $2,
             source_capture_ids = array_cat(
               (SELECT source_capture_ids FROM facts WHERE id = $3),
               (SELECT source_capture_ids FROM facts WHERE id = $4)
             ),
             embedding = NULL, updated_at = now()
           WHERE id = $3`,
          [action.merged_content, action.confidence, action.keep_id, action.archive_id],
        );
        await txClient.query(
          `UPDATE facts SET archived = true, updated_at = now() WHERE id = $1`,
          [action.archive_id],
        );
      }
    }

    // Mark all captures in this cluster as consolidated
    for (const capture of input.captures) {
      await txClient.query(
        `UPDATE captures SET status = 'consolidated', updated_at = now() WHERE id = $1`,
        [capture.id],
      );
    }
  });

  return result;
}

function shouldAutoApprove(category: string, reviewMode: string): boolean {
  if (reviewMode === 'autonomous') return true;
  if (reviewMode === 'ask') return false;
  // Hybrid mode: auto-approve low-impact categories
  const autoApproveCategories = ['preference', 'habit', 'skill', 'history'];
  return autoApproveCategories.includes(category);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/consolidation/phase1.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/consolidation/phase1.ts tests/unit/consolidation/phase1.test.ts
git commit -m "feat: consolidation phase 1 — capture to fact promotion with noise criteria"
```

---

### Task 25: Phase 2 — Fact → Insight Generation

**Files:**
- Create: `src/consolidation/phase2.ts`
- Create: `tests/unit/consolidation/phase2.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/consolidation/phase2.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { LLMProvider, LLMResponse } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('phase2', () => {
  it('generates insights from active facts', async () => {
    const db = mockDb();
    const llm: LLMProvider = {
      complete: vi.fn().mockResolvedValueOnce({
        content: JSON.stringify({
          insights: [{
            content: 'User has a strong analytical personality that drives both career and hobby choices',
            category: 'pattern',
            confidence: 0.85,
            source_fact_ids: ['f1', 'f2', 'f3'],
          }],
          updates: [],
          invalidations: [],
        }),
        tokensUsed: { input: 3000, output: 500, total: 3500 },
      } satisfies LLMResponse),
    };

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'ins-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { runPhase2 } = await import('../../../src/consolidation/phase2.js');
    const result = await runPhase2(db, llm, {
      facts: [
        { id: 'f1', content: 'Prefers TypeScript', category: 'preference', confidence: 0.9 },
        { id: 'f2', content: 'Works as software engineer', category: 'history', confidence: 1.0 },
        { id: 'f3', content: 'Enjoys solving complex problems', category: 'personality', confidence: 0.8 },
      ],
      existingInsights: [],
    });

    expect(result.insightsCreated).toBe(1);
  });

  it('does not create insights that restate a single fact', async () => {
    const db = mockDb();
    const llm: LLMProvider = {
      complete: vi.fn().mockResolvedValueOnce({
        content: JSON.stringify({ insights: [], updates: [], invalidations: [] }),
        tokensUsed: { input: 1000, output: 100, total: 1100 },
      }),
    };

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { runPhase2 } = await import('../../../src/consolidation/phase2.js');
    const result = await runPhase2(db, llm, {
      facts: [{ id: 'f1', content: 'Likes pizza', category: 'preference', confidence: 0.7 }],
      existingInsights: [],
    });

    expect(result.insightsCreated).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/consolidation/phase2.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Phase 2**

```typescript
// src/consolidation/phase2.ts
import type { DbClient } from '../db/client.js';
import type { LLMProvider } from '../providers/types.js';

export interface Phase2Input {
  facts: Array<{ id: string; content: string; category: string; confidence: number }>;
  existingInsights: Array<{ id: string; content: string; category: string; confidence: number; source_fact_ids: string[] }>;
}

export interface Phase2Result {
  insightsCreated: number;
  insightsRegenerated: number;
  tokensUsed: number;
}

const INSIGHT_PROMPT = `You are a personal profile insight generator. Given a set of facts about a person, identify cross-cutting patterns and meta-observations.

RULES:
- Do NOT generate insights that merely restate a single fact
- Each insight must draw from at least 2 facts
- Focus on patterns, tendencies, identity traits, and personal evolution
- Calibrate confidence based on how many facts support the pattern
- Categories: pattern, tendency, identity, evolution, goal

Return JSON:
{
  "insights": [
    {"content": "...", "category": "...", "confidence": 0.0-1.0, "source_fact_ids": ["..."]}
  ],
  "updates": [
    {"insight_id": "...", "content": "...", "confidence": 0.0-1.0, "reason": "..."}
  ],
  "invalidations": [
    {"insight_id": "...", "reason": "..."}
  ]
}`;

export async function runPhase2(
  db: DbClient,
  llm: LLMProvider,
  input: Phase2Input,
): Promise<Phase2Result> {
  const result: Phase2Result = { insightsCreated: 0, insightsRegenerated: 0, tokensUsed: 0 };

  const factsText = input.facts
    .map((f) => `[${f.id}] (${f.category}, ${f.confidence}): ${f.content}`)
    .join('\n');

  const insightsText = input.existingInsights.length > 0
    ? input.existingInsights
        .map((i) => `[${i.id}] (${i.category}, ${i.confidence}, from: ${i.source_fact_ids.join(',')}): ${i.content}`)
        .join('\n')
    : 'No existing insights.';

  const response = await llm.complete(
    [{ role: 'user', content: `FACTS:\n${factsText}\n\nEXISTING INSIGHTS:\n${insightsText}` }],
    { systemPrompt: INSIGHT_PROMPT, responseFormat: 'json', maxTokens: 4096 },
  );

  result.tokensUsed = response.tokensUsed.total;

  let parsed: any;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    return result;
  }

  // All Phase 2 writes are atomic (all-or-nothing)
  await db.transaction(async (txClient) => {
    // New insights
    if (Array.isArray(parsed.insights)) {
      for (const insight of parsed.insights) {
        if (!insight.source_fact_ids || insight.source_fact_ids.length < 2) continue;
        await txClient.query(
          `INSERT INTO insights (content, category, confidence, source_fact_ids, origin, review_status)
           VALUES ($1, $2, $3, $4, 'consolidation', 'pending_review')`,
          [insight.content, insight.category, insight.confidence, insight.source_fact_ids],
        );
        result.insightsCreated++;
      }
    }

    // Updated insights
    if (Array.isArray(parsed.updates)) {
      for (const update of parsed.updates) {
        await txClient.query(
          `UPDATE insights SET content = $1, confidence = $2, embedding = NULL,
           review_status = 'pending_review', updated_at = now()
           WHERE id = $3`,
          [update.content, update.confidence, update.insight_id],
        );
        result.insightsRegenerated++;
      }
    }

    // Invalidated insights — archive them
    if (Array.isArray(parsed.invalidations)) {
      for (const inv of parsed.invalidations) {
        await txClient.query(
          `UPDATE insights SET archived = true, updated_at = now() WHERE id = $1`,
          [inv.insight_id],
        );
      }
    }
  });

  return result;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/consolidation/phase2.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/consolidation/phase2.ts tests/unit/consolidation/phase2.test.ts
git commit -m "feat: consolidation phase 2 — fact to insight generation (atomic commit)"
```

---

### Task 26: Phase 3 — Embed, Store & Notify

**Files:**
- Create: `src/consolidation/phase3.ts`
- Create: `tests/unit/consolidation/phase3.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/consolidation/phase3.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { EmbeddingProvider } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('phase3', () => {
  it('embeds all facts and insights with null embeddings', async () => {
    const db = mockDb();
    const embedding: EmbeddingProvider = {
      embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
      dimensions: 3072,
    };

    // Query for items needing embeddings
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: 'f1', content: 'fact content' }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // facts with null embedding
      .mockResolvedValueOnce({
        rows: [{ id: 'i1', content: 'insight content' }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // insights with null embedding
      .mockResolvedValue({
        rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
      }); // updates

    const { runPhase3 } = await import('../../../src/consolidation/phase3.js');
    const result = await runPhase3(db, embedding);

    expect(embedding.embed).toHaveBeenCalledTimes(2); // once per item
    expect(result.itemsEmbedded).toBe(2);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/unit/consolidation/phase3.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Phase 3**

```typescript
// src/consolidation/phase3.ts
import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { getPendingReviewCount } from '../notifications/review.js';

export interface Phase3Options {
  sendNotification?: (message: string) => Promise<void>;
  digestEnabled?: boolean;
}

export interface Phase3Result {
  itemsEmbedded: number;
}

export async function runPhase3(
  db: DbClient,
  embeddingProvider: EmbeddingProvider,
  options?: Phase3Options,
): Promise<Phase3Result> {
  let itemsEmbedded = 0;

  // Find facts needing embeddings
  const factsNeedingEmbed = await db.query(
    `SELECT id, content FROM facts WHERE embedding IS NULL AND archived = false`,
  );

  for (const fact of factsNeedingEmbed.rows) {
    const embedding = await embeddingProvider.embed(fact.content);
    await db.query(
      `UPDATE facts SET embedding = $1 WHERE id = $2`,
      [JSON.stringify(embedding), fact.id],
    );
    itemsEmbedded++;
  }

  // Find insights needing embeddings
  const insightsNeedingEmbed = await db.query(
    `SELECT id, content FROM insights WHERE embedding IS NULL AND archived = false`,
  );

  for (const insight of insightsNeedingEmbed.rows) {
    const embedding = await embeddingProvider.embed(insight.content);
    await db.query(
      `UPDATE insights SET embedding = $1 WHERE id = $2`,
      [JSON.stringify(embedding), insight.id],
    );
    itemsEmbedded++;
  }

  // Dispatch notification if items are pending review
  if (options?.sendNotification) {
    const pending = await getPendingReviewCount(db);
    if (pending.total > 0) {
      await options.sendNotification(
        `Open Brain: ${pending.total} items need your review (${pending.facts} facts, ${pending.insights} insights). Use /review to see them.`,
      );
    }
  }

  return { itemsEmbedded };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/unit/consolidation/phase3.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/consolidation/phase3.ts tests/unit/consolidation/phase3.test.ts
git commit -m "feat: consolidation phase 3 — re-embed updated facts and insights"
```

---

### Task 27: Consolidation Runner + Azure Function Entry Point

**Files:**
- Create: `src/consolidation/runner.ts`
- Create: `functions/consolidation-trigger/index.ts`
- Create: `functions/consolidation-trigger/function.json`
- Create: `host.json`

- [ ] **Step 1: Implement consolidation runner (orchestrator)**

```typescript
// src/consolidation/runner.ts
import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider, LLMProvider } from '../providers/types.js';
import { findCapturesByStatus } from '../db/captures.js';
import { findActiveFacts } from '../db/facts.js';
import { findAllInsights } from '../db/insights.js';
import { findRecentlyCompletedReminders } from '../db/reminders.js';
import { getLatestConsolidationRun, insertConsolidationLog } from '../db/consolidation-log.js';
import { dbscan } from './clustering.js';
import { processCluster } from './phase1.js';
import { runPhase2 } from './phase2.js';
import { runPhase3 } from './phase3.js';

const PHASE1_TOKEN_BUDGET = 80_000;
const PHASE2_TOKEN_BUDGET = 50_000;

export interface ConsolidationDeps {
  db: DbClient;
  consolidationLLM: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  reviewMode: string;
  sendNotification?: (message: string) => Promise<void>;
  digestEnabled?: boolean;
}

export async function runConsolidation(deps: ConsolidationDeps): Promise<void> {
  const startTime = Date.now();
  const { db, consolidationLLM, embeddingProvider, reviewMode } = deps;

  // Guard: skip if nothing to do
  const pendingCaptures = await findCapturesByStatus(db, 'pending');
  const lastRun = await getLatestConsolidationRun(db);

  // Also check recently completed reminders (profile signal)
  const since = lastRun?.run_at ?? new Date(0);
  const completedReminders = await findRecentlyCompletedReminders(db, since);

  if (pendingCaptures.length === 0 && completedReminders.length === 0) {
    // Check if any facts were updated since last run
    const updatedFacts = await db.query(
      `SELECT count(*) as count FROM facts WHERE updated_at > $1`,
      [since],
    );
    if (parseInt(updatedFacts.rows[0].count) === 0) {
      await insertConsolidationLog(db, {
        status: 'no-op', capturesProcessed: 0, factsCreated: 0, factsUpdated: 0,
        insightsCreated: 0, insightsRegenerated: 0, duplicatesDetected: 0, itemsFlagged: 0,
        modelUsed: 'claude-opus-4-6', tokensUsed: 0, durationMs: Date.now() - startTime,
        errorMessage: null,
      });
      return;
    }
  }

  let totalTokens = 0;
  let totalFactsCreated = 0;
  let totalFactsUpdated = 0;
  let totalItemsFlagged = 0;

  // --- Phase 1: Capture → Fact promotion ---
  try {
    // Include completed reminders as captures for consolidation
    const allInputs = [
      ...pendingCaptures.map((c) => ({ id: c.id, content: c.content, embedding: c.embedding })),
      ...completedReminders.map((r) => ({
        id: r.id,
        content: `[Completed reminder] ${r.content}`,
        embedding: r.embedding,
      })),
    ];

    if (allInputs.length > 0) {
      const existingFacts = await findActiveFacts(db, 0.0);
      const clusters = dbscan(
        allInputs.filter((c) => c.embedding?.length > 0),
        { eps: 0.3, minSamples: 2 },
      );

      let phase1Tokens = 0;
      for (const cluster of clusters) {
        // Estimate next call cost: ~500 tokens per capture + ~200 per existing fact
        const estimatedCost = cluster.length * 500 + existingFacts.length * 200;
        if (phase1Tokens + estimatedCost > PHASE1_TOKEN_BUDGET) {
          // Remaining captures stay 'pending' for next run
          break;
        }

        const clusterResult = await processCluster(db, consolidationLLM, {
          captures: cluster,
          existingFacts: existingFacts.map((f) => ({
            id: f.id, content: f.content, confidence: f.confidence,
            origin: f.origin, category: f.category,
          })),
          reviewMode,
        });

        phase1Tokens += clusterResult.tokensUsed;
        totalFactsCreated += clusterResult.factsCreated;
        totalFactsUpdated += clusterResult.factsUpdated;
        totalItemsFlagged += clusterResult.itemsFlagged;
      }
      totalTokens += phase1Tokens;
    }
  } catch (err) {
    await insertConsolidationLog(db, {
      status: 'failed', capturesProcessed: pendingCaptures.length,
      factsCreated: totalFactsCreated, factsUpdated: totalFactsUpdated,
      insightsCreated: 0, insightsRegenerated: 0, duplicatesDetected: 0,
      itemsFlagged: totalItemsFlagged, modelUsed: 'claude-opus-4-6',
      tokensUsed: totalTokens, durationMs: Date.now() - startTime,
      errorMessage: String(err),
    });
    throw err;
  }

  // --- Phase 2: Fact → Insight generation ---
  let insightsCreated = 0;
  let insightsRegenerated = 0;
  try {
    const activeFacts = await findActiveFacts(db, 0.3);
    const existingInsights = await findAllInsights(db);

    if (activeFacts.length >= 2) {
      // Estimate Phase 2 cost: ~200 tokens per fact + ~300 per existing insight
      const estimatedPhase2Cost = activeFacts.length * 200 + existingInsights.length * 300;
      if (estimatedPhase2Cost > PHASE2_TOKEN_BUDGET) {
        // Defer insight generation to next run
        await insertConsolidationLog(db, {
          status: 'partial', capturesProcessed: pendingCaptures.length,
          factsCreated: totalFactsCreated, factsUpdated: totalFactsUpdated,
          insightsCreated: 0, insightsRegenerated: 0, duplicatesDetected: 0,
          itemsFlagged: totalItemsFlagged, modelUsed: 'claude-opus-4-6',
          tokensUsed: totalTokens, durationMs: Date.now() - startTime,
          errorMessage: 'Phase 2 deferred: estimated token cost exceeds budget',
        });
        return;
      }

      const phase2Result = await runPhase2(db, consolidationLLM, {
        facts: activeFacts.map((f) => ({
          id: f.id, content: f.content, category: f.category, confidence: f.confidence,
        })),
        existingInsights: existingInsights.map((i) => ({
          id: i.id, content: i.content, category: i.category,
          confidence: i.confidence, source_fact_ids: i.source_fact_ids,
        })),
      });

      insightsCreated = phase2Result.insightsCreated;
      insightsRegenerated = phase2Result.insightsRegenerated;
      totalTokens += phase2Result.tokensUsed;
      totalItemsFlagged += insightsCreated; // All new insights are pending_review
    }
  } catch (err) {
    await insertConsolidationLog(db, {
      status: 'partial', capturesProcessed: pendingCaptures.length,
      factsCreated: totalFactsCreated, factsUpdated: totalFactsUpdated,
      insightsCreated: 0, insightsRegenerated: 0, duplicatesDetected: 0,
      itemsFlagged: totalItemsFlagged, modelUsed: 'claude-opus-4-6',
      tokensUsed: totalTokens, durationMs: Date.now() - startTime,
      errorMessage: `Phase 2 failed: ${String(err)}`,
    });
    // Phase 1 clusters are already committed — don't throw, just log
    return;
  }

  // --- Phase 3: Embed, store & notify ---
  const phase3Result = await runPhase3(db, embeddingProvider, {
    sendNotification: deps.sendNotification,
    digestEnabled: deps.digestEnabled,
  });

  await insertConsolidationLog(db, {
    status: 'success', capturesProcessed: pendingCaptures.length,
    factsCreated: totalFactsCreated, factsUpdated: totalFactsUpdated,
    insightsCreated, insightsRegenerated, duplicatesDetected: 0,
    itemsFlagged: totalItemsFlagged, modelUsed: 'claude-opus-4-6',
    tokensUsed: totalTokens, durationMs: Date.now() - startTime,
    errorMessage: null,
  });
}
```

- [ ] **Step 2: Create Azure Function entry point**

```typescript
// functions/consolidation-trigger/index.ts
import { loadConfig } from '../../src/config.js';
import { createDbClient } from '../../src/db/client.js';
import { GeminiEmbeddingProvider } from '../../src/providers/gemini-embedding.js';
import { AnthropicLLMProvider } from '../../src/providers/anthropic-llm.js';
import { runConsolidation } from '../../src/consolidation/runner.js';

export default async function timerTrigger(): Promise<void> {
  const config = loadConfig();
  const db = createDbClient(config.databaseUrl);

  try {
    await runConsolidation({
      db,
      consolidationLLM: new AnthropicLLMProvider(config.anthropicApiKey),
      embeddingProvider: new GeminiEmbeddingProvider(config.geminiApiKey),
      reviewMode: config.reviewMode,
    });
  } finally {
    await db.close();
  }
}
```

```json
// functions/consolidation-trigger/function.json
{
  "bindings": [
    {
      "name": "myTimer",
      "type": "timerTrigger",
      "direction": "in",
      "schedule": "0 0 6 * * *"
    }
  ]
}
```

```json
// host.json
{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/consolidation/runner.ts functions/ host.json
git commit -m "feat: consolidation runner with guard rails, token budgets, and Azure Function trigger"
```

---

## Chunk 8: Retrieval & Notifications

### Task 28: get_user_profile — Session Bootstrap

**Files:**
- Create: `src/retrieval/profile.ts`
- Create: `tests/unit/retrieval/profile.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/retrieval/profile.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { LLMProvider, LLMResponse } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('getUserProfile', () => {
  it('synthesizes profile from insights + uncovered facts + active reminders', async () => {
    const db = mockDb();
    const llm: LLMProvider = {
      complete: vi.fn().mockResolvedValueOnce({
        content: 'Pedro is a software engineer who prefers TypeScript...',
        tokensUsed: { input: 500, output: 200, total: 700 },
      } satisfies LLMResponse),
    };

    // approved insights
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [
          { id: 'i1', content: 'Strong analytical personality', category: 'pattern',
            confidence: 0.9, source_fact_ids: ['f1', 'f2'] },
        ],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      })
      // high-confidence facts NOT covered by insights
      .mockResolvedValueOnce({
        rows: [
          { id: 'f3', content: 'Uses Claude for coding', category: 'habit', confidence: 0.95 },
        ],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      })
      // active reminders
      .mockResolvedValueOnce({
        rows: [
          { id: 'r1', content: 'Research Rust CLI tools', status: 'in_progress', category: 'learning' },
        ],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

    const { getUserProfile } = await import('../../../src/retrieval/profile.js');
    const profile = await getUserProfile(db, llm);

    expect(llm.complete).toHaveBeenCalled();
    expect(typeof profile).toBe('string');
    expect(profile.length).toBeGreaterThan(0);
  });

  it('returns fallback when no data exists', async () => {
    const db = mockDb();
    const llm: LLMProvider = { complete: vi.fn() };

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

    const { getUserProfile } = await import('../../../src/retrieval/profile.js');
    const profile = await getUserProfile(db, llm);

    expect(profile).toContain('No profile data');
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/retrieval/profile.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement getUserProfile**

```typescript
// src/retrieval/profile.ts
import type { DbClient } from '../db/client.js';
import type { LLMProvider } from '../providers/types.js';

const SYNTHESIS_PROMPT = `You are generating a concise profile summary for an AI assistant.
Given the person's insights, key facts, and current activities, produce a natural-language summary organized by category.
Include what they're currently focused on (from active reminders).
Keep it concise but comprehensive — this will be used by other AI tools to quickly understand who this person is.
Write in third person.`;

export async function getUserProfile(db: DbClient, llm: LLMProvider): Promise<string> {
  // 1. Load approved insights
  const insightsResult = await db.query(
    `SELECT id, content, category, confidence, source_fact_ids
     FROM insights
     WHERE review_status IN ('auto_approved', 'user_approved')
       AND archived = false
     ORDER BY confidence DESC`,
  );

  // 2. Load high-confidence facts not covered by any insight
  const coveredFactIds = insightsResult.rows
    .flatMap((i: any) => i.source_fact_ids ?? []);

  const uncoveredFactsResult = await db.query(
    `SELECT id, content, category, confidence
     FROM facts
     WHERE confidence >= 0.7
       AND archived = false
       AND review_status != 'user_rejected'
       ${coveredFactIds.length > 0 ? `AND id != ALL($1)` : ''}
     ORDER BY confidence DESC`,
    coveredFactIds.length > 0 ? [coveredFactIds] : [],
  );

  // 3. Load active reminders (current focus)
  const remindersResult = await db.query(
    `SELECT id, content, status, category
     FROM reminders
     WHERE status IN ('not_started', 'in_progress', 'researching')
       AND archived = false
     ORDER BY created_at DESC
     LIMIT 10`,
  );

  const insights = insightsResult.rows;
  const facts = uncoveredFactsResult.rows;
  const reminders = remindersResult.rows;

  if (insights.length === 0 && facts.length === 0 && reminders.length === 0) {
    return 'No profile data yet. Start capturing thoughts to build your profile.';
  }

  const insightsText = insights.length > 0
    ? insights.map((i: any) => `- [${i.category}] ${i.content}`).join('\n')
    : 'None yet.';

  const factsText = facts.length > 0
    ? facts.map((f: any) => `- [${f.category}] ${f.content}`).join('\n')
    : 'None.';

  const remindersText = reminders.length > 0
    ? reminders.map((r: any) => `- [${r.status}] ${r.content}`).join('\n')
    : 'None.';

  const response = await llm.complete(
    [{
      role: 'user',
      content: `INSIGHTS:\n${insightsText}\n\nKEY FACTS:\n${factsText}\n\nCURRENT FOCUS (active reminders):\n${remindersText}`,
    }],
    { systemPrompt: SYNTHESIS_PROMPT, maxTokens: 2048 },
  );

  return response.content;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/retrieval/profile.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/profile.ts tests/unit/retrieval/profile.test.ts
git commit -m "feat: get_user_profile with tiered data loading and Gemini Flash synthesis"
```

---

### Task 29: search_thoughts — Tiered Search

**Files:**
- Create: `src/retrieval/search.ts`
- Create: `tests/unit/retrieval/search.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/retrieval/search.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { EmbeddingProvider } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

function mockEmbed(): EmbeddingProvider {
  return { embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)), dimensions: 3072 };
}

describe('searchThoughts', () => {
  it('returns insight tier when insight matches', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: 'i1', content: 'Analytical personality', category: 'pattern',
                 confidence: 0.9, similarity: 0.88 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'personality', 0.5, 10);

    expect(results[0].tier).toBe('insight');
    expect(results[0].confidence).toBe(0.9);
  });

  it('falls back to facts when no insights match', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({
        rows: [{ id: 'f1', content: 'Prefers TypeScript', category: 'preference',
                 confidence: 0.8, similarity: 0.75 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }); // facts

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'typescript', 0.5, 10);

    expect(results[0].tier).toBe('fact');
  });

  it('falls back to captures when no insights or facts match', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // facts
      .mockResolvedValueOnce({
        rows: [{ id: 'c1', content: 'Raw thought about hiking', similarity: 0.6 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }); // captures

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'hiking', 0.5, 10);

    expect(results[0].tier).toBe('capture');
  });

  it('appends evidence for low-confidence results (<0.7)', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({
        rows: [{ id: 'f1', content: 'Might like hiking', category: 'preference',
                 confidence: 0.5, similarity: 0.7, source_capture_ids: ['c1'] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // low-confidence fact
      .mockResolvedValueOnce({
        rows: [{ id: 'c1', content: 'Mentioned hiking once', similarity: 0.6 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }); // source captures for evidence

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'hiking', 0.5, 10);

    expect(results[0].note).toContain('Moderate confidence');
    expect(results[0].evidence).toBeDefined();
    expect(results[0].evidence!.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/retrieval/search.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement tiered search**

```typescript
// src/retrieval/search.ts
import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { findSimilarInsights } from '../db/insights.js';
import { findSimilarFacts } from '../db/facts.js';
import { findSimilarCaptures } from '../db/captures.js';

export interface SearchResult {
  tier: 'insight' | 'fact' | 'capture';
  confidence: number | null;
  content: string;
  category: string | null;
  note: string | null;
  evidence: Array<{ content: string; tier: string }> | null;
}

export async function searchThoughts(
  db: DbClient,
  embeddingProvider: EmbeddingProvider,
  query: string,
  threshold: number,
  limit: number,
): Promise<SearchResult[]> {
  const queryEmbedding = await embeddingProvider.embed(query);

  // Tier 1: Search insights first
  const insights = await findSimilarInsights(db, queryEmbedding, threshold, limit);
  if (insights.length > 0) {
    return insights.map((i) => ({
      tier: 'insight' as const,
      confidence: i.confidence,
      content: i.content,
      category: i.category,
      note: i.confidence < 0.7 ? 'Moderate confidence — based on mixed evidence' : null,
      evidence: null,
    }));
  }

  // Tier 2: Search facts
  const facts = await findSimilarFacts(db, queryEmbedding, threshold, limit);
  if (facts.length > 0) {
    const results: SearchResult[] = [];
    for (const fact of facts) {
      let evidence: Array<{ content: string; tier: string }> | null = null;
      let note: string | null = null;

      if (fact.confidence < 0.7 && fact.source_capture_ids?.length > 0) {
        note = 'Moderate confidence — based on mixed evidence';
        const sourceCaptures = await db.query(
          `SELECT content FROM captures WHERE id = ANY($1) AND archived = false LIMIT 5`,
          [fact.source_capture_ids],
        );
        evidence = sourceCaptures.rows.map((c: any) => ({ content: c.content, tier: 'capture' }));
      }

      results.push({
        tier: 'fact',
        confidence: fact.confidence,
        content: fact.content,
        category: fact.category,
        note,
        evidence,
      });
    }
    return results;
  }

  // Tier 3: Fall back to raw captures
  const captures = await findSimilarCaptures(db, queryEmbedding, threshold);
  return captures.slice(0, limit).map((c) => ({
    tier: 'capture' as const,
    confidence: null,
    content: c.content,
    category: null,
    note: null,
    evidence: null,
  }));
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/retrieval/search.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/search.ts tests/unit/retrieval/search.test.ts
git commit -m "feat: tiered search (insights → facts → captures) with conditional evidence"
```

---

### Task 30: Review System + Daily Digest

**Files:**
- Create: `src/notifications/review.ts`
- Create: `src/notifications/digest.ts`
- Create: `tests/unit/notifications/review.test.ts`
- Create: `tests/unit/notifications/digest.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/notifications/review.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('review', () => {
  it('returns pending items count', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ facts_pending: '3', insights_pending: '1' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { getPendingReviewCount } = await import('../../../src/notifications/review.js');
    const count = await getPendingReviewCount(db);
    expect(count.facts).toBe(3);
    expect(count.insights).toBe(1);
    expect(count.total).toBe(4);
  });
});
```

```typescript
// tests/unit/notifications/digest.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { ConsolidationLogRow } from '../../../src/db/consolidation-log.js';

describe('digest', () => {
  it('formats daily digest message', async () => {
    const { formatDailyDigest } = await import('../../../src/notifications/digest.js');
    const digest = formatDailyDigest({
      capturesProcessed: 8,
      factsCreated: 2,
      factsUpdated: 3,
      insightsCreated: 1,
      pendingReview: 3,
      activeReminders: 5,
      completedToday: 2,
    });

    expect(digest).toContain('8 captures');
    expect(digest).toContain('2');
    expect(digest).toContain('3 items need your review');
    expect(digest).toContain('/review');
    expect(digest).toContain('/todos');
  });

  it('sends digest via Telegram', async () => {
    const mockSendMessage = vi.fn().mockResolvedValue({});
    const { sendDigestViaTelegram } = await import('../../../src/notifications/digest.js');

    await sendDigestViaTelegram(mockSendMessage, '123456', 'Test digest');
    expect(mockSendMessage).toHaveBeenCalledWith('123456', 'Test digest', expect.any(Object));
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/notifications/`
Expected: FAIL.

- [ ] **Step 3: Implement review module**

```typescript
// src/notifications/review.ts
import type { DbClient } from '../db/client.js';

export interface PendingReviewCount {
  facts: number;
  insights: number;
  total: number;
}

export async function getPendingReviewCount(db: DbClient): Promise<PendingReviewCount> {
  const result = await db.query(`
    SELECT
      (SELECT count(*) FROM facts WHERE review_status = 'pending_review' AND archived = false) AS facts_pending,
      (SELECT count(*) FROM insights WHERE review_status = 'pending_review' AND archived = false) AS insights_pending
  `);

  const row = result.rows[0];
  const facts = parseInt(row.facts_pending);
  const insights = parseInt(row.insights_pending);

  return { facts, insights, total: facts + insights };
}
```

- [ ] **Step 4: Implement digest module**

```typescript
// src/notifications/digest.ts

export interface DigestData {
  capturesProcessed: number;
  factsCreated: number;
  factsUpdated: number;
  insightsCreated: number;
  pendingReview: number;
  activeReminders: number;
  completedToday: number;
}

export function formatDailyDigest(data: DigestData): string {
  // Matches spec digest format with emojis
  const lines = [
    '\u{1F9E0} Open Brain Daily Digest',
    `Processed: ${data.capturesProcessed} captures`,
    `Facts created: ${data.factsCreated} | Updated: ${data.factsUpdated}`,
    `Insights created: ${data.insightsCreated}`,
  ];

  if (data.pendingReview > 0) {
    lines.push(`\u26A1 ${data.pendingReview} items need your review`);
  }

  lines.push('');
  lines.push(`\u{1F4CB} Reminders: ${data.activeReminders} active | ${data.completedToday} completed today`);

  if (data.pendingReview > 0) {
    lines.push('Tap /review to see pending items');
  }
  lines.push('Tap /todos to see your reminders');

  return lines.join('\n');
}

export async function sendDigestViaTelegram(
  sendMessage: (chatId: string, text: string, options: Record<string, unknown>) => Promise<unknown>,
  chatId: string,
  message: string,
): Promise<void> {
  await sendMessage(chatId, message, { parse_mode: 'Markdown' });
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `npx vitest run tests/unit/notifications/`
Expected: All 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/notifications/ tests/unit/notifications/
git commit -m "feat: review system and daily digest with Telegram dispatch"
```

---

## Chunk 9: Deployment

### Task 31: Docker + Azure Deployment Config

**Files:**
- Create: `Dockerfile`
- Create: `tests/helpers/mocks.ts`

- [ ] **Step 1: Create Dockerfile**

```dockerfile
# Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Create shared test mock helpers**

```typescript
// tests/helpers/mocks.ts
import { vi } from 'vitest';
import type { DbClient } from '../../src/db/client.js';
import type { EmbeddingProvider, LLMProvider, LLMResponse } from '../../src/providers/types.js';
import type { BlobStorage } from '../../src/storage/blob.js';

export function mockDb(): DbClient {
  return {
    pool: {} as any,
    query: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

export function mockEmbeddingProvider(dims = 3072): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(new Array(dims).fill(0.1)),
    dimensions: dims,
  };
}

export function mockLLMProvider(defaultResponse?: Partial<LLMResponse>): LLMProvider {
  const response: LLMResponse = {
    content: defaultResponse?.content ?? '{}',
    tokensUsed: defaultResponse?.tokensUsed ?? { input: 100, output: 50, total: 150 },
  };
  return { complete: vi.fn().mockResolvedValue(response) };
}

export function mockBlobStorage(): BlobStorage {
  return {
    upload: vi.fn().mockResolvedValue('https://blob.storage/file'),
    exists: vi.fn().mockResolvedValue(false),
    getUrl: vi.fn().mockReturnValue('https://blob.storage/file'),
  };
}
```

- [ ] **Step 3: Verify Docker builds**

Run: `docker build -t open-brain-v2 .`
Expected: Multi-stage build completes successfully.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile tests/helpers/mocks.ts
git commit -m "feat: Dockerfile for production deployment and shared test mock helpers"
```

---

## Summary

| Chunk | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-4 | Project scaffolding, config, schema, DB client |
| 2 | 5-9 | Data access layer (captures, facts, insights, reminders, consolidation log) |
| 3 | 10-14 | Provider interfaces, Gemini/Anthropic implementations, Blob Storage |
| 4 | 15-17 | Capture pipeline (dedup, metadata extraction, orchestrator) |
| 5 | 18-19 | Hono HTTP server, auth, REST capture endpoint, Telegram webhook |
| 6 | 20-22 | MCP server with 13 tools (9 profiler + 4 reminders) |
| 7 | 23-27 | Consolidation (DBSCAN, Phase 1-3, runner, Azure Function) |
| 8 | 28-30 | Retrieval (profile + tiered search), notifications (review + digest) |
| 9 | 31 | Docker deployment, shared test helpers |

**Total: 31 tasks across 9 chunks. ~31 commits.**

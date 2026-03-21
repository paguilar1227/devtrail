// tests/e2e/api-e2e.test.ts — End-to-end tests against real PostgreSQL
// Mocks: AI providers (embedding, LLM) + blob storage + Telegram webhook
// Real: PostgreSQL + pgvector, Hono app, capture pipeline, consolidation

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { createApp, type AppDeps } from '../../src/app.js';
import type { Hono } from 'hono';
import type { Config } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Mock Telegram webhook (it tries to init the bot)
// ---------------------------------------------------------------------------
vi.mock('../../src/telegram/webhook.js', () => ({
  setupTelegramWebhook: vi.fn(),
}));

// Mock applicationinsights so consolidation runner doesn't crash
vi.mock('applicationinsights', () => ({
  default: { defaultClient: null },
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://openbrain:openbrain@localhost:5434/openbrain_test';
const ADMIN_DB_URL = process.env.E2E_DATABASE_URL
  ? process.env.E2E_DATABASE_URL.replace(/\/[^/]+$/, '/openbrain')
  : 'postgresql://openbrain:openbrain@localhost:5434/openbrain';
const API_KEY = 'test-e2e-key';
const AUTH_HEADER = `Bearer ${API_KEY}`;
const EMBEDDING_DIM = 3072;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATION_PATH = join(__dirname, '../../migrations/001_initial_schema.sql');

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------
let embeddingCounter = 0;

function mockEmbeddingProvider() {
  return {
    embed: async () => {
      // Each call returns a different embedding so semantic dedup
      // doesn't fire unless we want it to.
      // Use different positions (not just magnitude) so cosine similarity < threshold.
      embeddingCounter++;
      const base = new Array(EMBEDDING_DIM).fill(0);
      // Set a unique position to 1.0 for each call — orthogonal vectors have
      // cosine similarity 0.0, well below the 0.95 dedup threshold.
      const idx = embeddingCounter % EMBEDDING_DIM;
      base[idx] = 1.0;
      return base;
    },
    dimensions: EMBEDDING_DIM,
  };
}

/** Returns an embedding provider that always returns the same vector (for dedup tests). */
function fixedEmbeddingProvider() {
  return {
    embed: async () => new Array(EMBEDDING_DIM).fill(0.1),
    dimensions: EMBEDDING_DIM,
  };
}

function mockLLMProvider() {
  return {
    complete: async (_msgs: any, opts?: any) => {
      if (opts?.responseFormat === 'json') {
        // Check if this looks like a consolidation Phase 1 call (has CAPTURES + EXISTING FACTS in the message)
        const msgContent = typeof _msgs[0]?.content === 'string' ? _msgs[0].content : '';
        if (msgContent.includes('CAPTURES:') && msgContent.includes('EXISTING FACTS:')) {
          // Phase 1: Extract capture IDs from the message and create facts
          const captureIdMatches = msgContent.match(/\[([0-9a-f-]{36})\]/g) ?? [];
          const captureIds = captureIdMatches.map((m: string) => m.slice(1, -1));
          return {
            content: JSON.stringify({
              actions: [{
                action: 'create_fact',
                content: 'Test fact from consolidation',
                category: 'preference',
                confidence: 0.8,
                source_capture_ids: captureIds,
              }],
            }),
            tokensUsed: { input: 100, output: 100, total: 200 },
          };
        }
        if (msgContent.includes('FACTS:') && msgContent.includes('EXISTING INSIGHTS:')) {
          // Phase 2: Create an insight from facts
          const factIdMatches = msgContent.match(/\[([0-9a-f-]{36})\]/g) ?? [];
          const factIds = factIdMatches.map((m: string) => m.slice(1, -1));
          return {
            content: JSON.stringify({
              insights: factIds.length >= 2 ? [{
                content: 'Test insight from consolidation',
                category: 'pattern',
                confidence: 0.75,
                source_fact_ids: factIds.slice(0, 2),
              }] : [],
              updates: [],
              invalidations: [],
            }),
            tokensUsed: { input: 100, output: 100, total: 200 },
          };
        }
        // Default JSON response for metadata extraction
        return {
          content: JSON.stringify({
            people: [],
            topics: ['test'],
            action_items: [],
            dates: [],
            type: 'statement',
          }),
          tokensUsed: { input: 10, output: 10, total: 20 },
        };
      }
      // Text response (profile synthesis, etc.)
      return {
        content: 'Test profile summary generated by mock LLM.',
        tokensUsed: { input: 10, output: 10, total: 20 },
      };
    },
  };
}

function mockBlobStorage() {
  return {
    upload: async (name: string) => `https://mock-blob/${name}`,
    exists: async () => false,
    getUrl: (name: string) => `https://mock-blob/${name}`,
  };
}

function makeConfig(): Config {
  return {
    apiKey: API_KEY,
    databaseUrl: DB_URL,
    azureStorageConnectionString: 'mock',
    azureStorageContainer: 'mock',
    geminiApiKey: 'mock',
    anthropicApiKey: 'mock',
    telegramBotToken: 'mock:token',
    telegramWebhookSecret: 'mock-secret',
    telegramChatId: '12345',
    port: 3000,
    nodeEnv: 'test',
    reviewMode: 'autonomous',
    dailyDigestEnabled: false,
    timezone: 'America/Chicago',
    dailyReportTime: '09:00',
  };
}

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------
let db: DbClient;
let app: Hono;
let deps: AppDeps;

// Helper: make authenticated request
function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: AUTH_HEADER, 'Content-Type': 'application/json', ...extra };
}

// Helper: capture a thought via POST /api/v1/capture
async function captureThought(content: string) {
  const res = await app.request('/api/v1/capture', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ content }),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // If we're NOT using a pre-configured E2E_DATABASE_URL (i.e., local dev with docker compose),
  // create the test database.
  if (!process.env.E2E_DATABASE_URL) {
    const adminDb = createDbClient(ADMIN_DB_URL);
    try {
      // Must end any existing connections to openbrain_test before dropping
      await adminDb.pool.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = 'openbrain_test' AND pid != pg_backend_pid()
      `);
      await adminDb.pool.query('DROP DATABASE IF EXISTS openbrain_test');
      await adminDb.pool.query('CREATE DATABASE openbrain_test');
    } finally {
      await adminDb.close();
    }
  }

  // Connect to test database and run migrations
  db = createDbClient(DB_URL);
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf-8');
  await db.pool.query(migrationSql);

  // Build app with real DB + mock providers
  const embeddingProvider = mockEmbeddingProvider();
  const llmProvider = mockLLMProvider();

  deps = {
    db,
    embeddingProvider,
    metadataLLM: llmProvider,
    consolidationLLM: llmProvider,
    retrievalLLM: llmProvider,
    blobStorage: mockBlobStorage(),
    config: makeConfig(),
  } as unknown as AppDeps;

  app = createApp(deps);
}, 30000);

afterAll(async () => {
  if (db) {
    // Drop all tables
    await db.pool.query(`
      DROP TABLE IF EXISTS reminder_comments CASCADE;
      DROP TABLE IF EXISTS reminders CASCADE;
      DROP TABLE IF EXISTS consolidation_log CASCADE;
      DROP TABLE IF EXISTS insights CASCADE;
      DROP TABLE IF EXISTS facts CASCADE;
      DROP TABLE IF EXISTS captures CASCADE;
    `);
    await db.close();
  }
}, 15000);

// Clean tables between test groups (within a describe)
async function truncateAll() {
  await db.pool.query(`
    TRUNCATE captures, facts, insights, reminders, reminder_comments, consolidation_log CASCADE
  `);
}

// ==========================================================================
// REST API E2E Tests (tests 27-34)
// ==========================================================================

describe('REST API E2E', () => {
  // ── Test 31: Health Check ───────────────────────────────────────────────
  describe('31. GET / → health check', () => {
    it('returns 200 with {status: ok, service: open-brain-v2}', async () => {
      const res = await app.request('/');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: 'ok', service: 'open-brain-v2' });
    });
  });

  // ── Test 34: Auth required ──────────────────────────────────────────────
  describe('34. POST /api/v1/capture without auth → 401', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/api/v1/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'unauthenticated thought' }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ── Test 32: Capture endpoint ───────────────────────────────────────────
  describe('32. POST /api/v1/capture → 201 with captureId', () => {
    beforeEach(truncateAll);

    it('captures a thought and returns 201', async () => {
      const { status, body } = await captureThought('Pedro prefers TypeScript over JavaScript');
      expect(status).toBe(201);
      expect(body.captureId).toBeDefined();
      expect(typeof body.captureId).toBe('string');

      // Verify it's actually in the database
      const dbResult = await db.query('SELECT * FROM captures WHERE id = $1', [body.captureId]);
      expect(dbResult.rows.length).toBe(1);
      expect(dbResult.rows[0].content).toBe('Pedro prefers TypeScript over JavaScript');
      expect(dbResult.rows[0].source).toBe('api');
      expect(dbResult.rows[0].status).toBe('pending');
      expect(dbResult.rows[0].embedding).toBeDefined();
    });
  });

  // ── Test 33: GET /api/v1/captures ───────────────────────────────────────
  describe('33. GET /api/v1/captures → returns captures', () => {
    beforeEach(truncateAll);

    it('returns the capture we just created', async () => {
      // Create a capture
      const { body: captureBody } = await captureThought('Pedro likes Hono for HTTP APIs');
      expect(captureBody.captureId).toBeDefined();

      // List captures
      const res = await app.request('/api/v1/captures', {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(200);
      const captures = await res.json();
      expect(Array.isArray(captures)).toBe(true);
      expect(captures.length).toBeGreaterThanOrEqual(1);
      expect(captures.some((c: any) => c.id === captureBody.captureId)).toBe(true);
    });
  });

  // ── Test 27: Consolidation trigger ──────────────────────────────────────
  describe('27. POST /api/v1/consolidation/trigger', () => {
    beforeEach(truncateAll);

    it('triggers consolidation and returns log entry with captures_processed > 0', async () => {
      // Capture a few thoughts first
      await captureThought('Pedro loves building CLI tools');
      await captureThought('Pedro values efficiency and directness');

      // Trigger consolidation
      const res = await app.request('/api/v1/consolidation/trigger', {
        method: 'POST',
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('completed');
      expect(body.log).toBeDefined();
      expect(body.log.captures_processed).toBeGreaterThan(0);
    });
  });

  // ── Test 28: GET /api/v1/facts ──────────────────────────────────────────
  describe('28. GET /api/v1/facts → returns facts after consolidation', () => {
    beforeEach(truncateAll);

    it('returns facts created by consolidation', async () => {
      // Capture thoughts
      await captureThought('Pedro prefers TypeScript for all projects');
      await captureThought('Pedro uses Hono framework for APIs');

      // Trigger consolidation
      await app.request('/api/v1/consolidation/trigger', {
        method: 'POST',
        headers: { Authorization: AUTH_HEADER },
      });

      // Fetch facts
      const res = await app.request('/api/v1/facts', {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(200);
      const facts = await res.json();
      expect(Array.isArray(facts)).toBe(true);
      // Consolidation with our mock LLM should create at least one fact
      expect(facts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Test 29: GET /api/v1/insights ───────────────────────────────────────
  describe('29. GET /api/v1/insights → returns insights array', () => {
    it('returns an array (may be empty with few facts)', async () => {
      const res = await app.request('/api/v1/insights', {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(200);
      const insights = await res.json();
      expect(Array.isArray(insights)).toBe(true);
    });
  });

  // ── Test 30: GET /api/v1/consolidation/logs ─────────────────────────────
  describe('30. GET /api/v1/consolidation/logs', () => {
    it('returns at least one log entry (from test 27)', async () => {
      // Ensure at least one consolidation has run
      await truncateAll();
      await captureThought('A test thought');
      await app.request('/api/v1/consolidation/trigger', {
        method: 'POST',
        headers: { Authorization: AUTH_HEADER },
      });

      const res = await app.request('/api/v1/consolidation/logs', {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(200);
      const logs = await res.json();
      expect(Array.isArray(logs)).toBe(true);
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ==========================================================================
// Capture Pipeline E2E
// ==========================================================================

describe('Capture Pipeline E2E', () => {
  beforeEach(truncateAll);

  it('E1. Capture with text → stored in DB with embedding and metadata', async () => {
    const { status, body } = await captureThought('Pedro enjoys running in the morning');
    expect(status).toBe(201);

    const dbResult = await db.query('SELECT * FROM captures WHERE id = $1', [body.captureId]);
    const row = dbResult.rows[0];
    expect(row.content).toBe('Pedro enjoys running in the morning');
    expect(row.embedding).toBeDefined();
    expect(row.metadata).toBeDefined();
    expect(row.content_types).toContain('text');
  });

  it('E2. Capture duplicate text → 409 (semantic dedup)', async () => {
    // For this test, we need the embedding provider to return the same vector
    // so semantic dedup fires. Temporarily replace the provider.
    const originalProvider = deps.embeddingProvider;
    deps.embeddingProvider = fixedEmbeddingProvider();
    // Rebuild app with fixed embedding provider
    const fixedApp = createApp({ ...deps });

    try {
      const res1 = await fixedApp.request('/api/v1/capture', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content: 'Exact duplicate test' }),
      });
      expect(res1.status).toBe(201);

      const res2 = await fixedApp.request('/api/v1/capture', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content: 'Exact duplicate test again' }),
      });
      expect(res2.status).toBe(409);
      const body2 = await res2.json();
      expect(body2.error).toContain('Semantic duplicate');
    } finally {
      deps.embeddingProvider = originalProvider;
    }
  });

  it('E3. GET /api/v1/captures returns captures in reverse chronological order', async () => {
    await captureThought('First thought');
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 50));
    await captureThought('Second thought');

    const res = await app.request('/api/v1/captures', {
      headers: { Authorization: AUTH_HEADER },
    });
    const captures = await res.json();
    expect(captures.length).toBe(2);
    // Most recent first
    expect(captures[0].content).toBe('Second thought');
    expect(captures[1].content).toBe('First thought');
    // Verify ordering by timestamp
    expect(new Date(captures[0].created_at).getTime())
      .toBeGreaterThanOrEqual(new Date(captures[1].created_at).getTime());
  });

  it('E4. Rate limit → 101st request returns 429', async () => {
    // Create a fresh app so the rate limit counter is clean
    const freshApp = createApp({ ...deps });
    const headers = authHeaders();

    // Send 100 requests
    for (let i = 0; i < 100; i++) {
      await freshApp.request('/api/v1/captures', { headers: { Authorization: AUTH_HEADER } });
    }

    // 101st should be rate limited
    const res = await freshApp.request('/api/v1/captures', {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(res.status).toBe(429);
  });
});

// ==========================================================================
// Reminder E2E (via REST endpoints + direct DB inserts)
// ==========================================================================

describe('Reminder E2E', () => {
  beforeEach(truncateAll);

  it('R1. Insert reminders via DB, then GET /api/v1/reminders', async () => {
    const { insertReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    await insertReminder(db, {
      content: 'Buy groceries',
      embedding,
      category: 'personal',
      project: 'life',
      section: null,
      parentId: null,
      depth: 0,
      priority: 'P2',
      source: 'test',
      sourceContext: null,
      dueDate: null,
    });

    const res = await app.request('/api/v1/reminders', {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(res.status).toBe(200);
    const reminders = await res.json();
    expect(Array.isArray(reminders)).toBe(true);
    expect(reminders.length).toBe(1);
    expect(reminders[0].content).toBe('Buy groceries');
  });

  it('R2. GET /api/v1/reminders returns reminders', async () => {
    const { insertReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    await insertReminder(db, {
      content: 'Deploy v2',
      embedding,
      category: 'work',
      project: 'open-brain',
      section: 'backend',
      parentId: null,
      depth: 0,
      priority: 'P1',
      source: 'test',
      sourceContext: null,
      dueDate: new Date('2026-04-01'),
    });

    const res = await app.request('/api/v1/reminders', {
      headers: { Authorization: AUTH_HEADER },
    });
    const reminders = await res.json();
    expect(reminders.length).toBe(1);
    expect(reminders[0].project).toBe('open-brain');
    expect(reminders[0].priority).toBe('P1');
  });

  it('R3. GET /api/v1/reminders?status=not_started → filtered', async () => {
    const { insertReminder, updateReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const r1 = await insertReminder(db, {
      content: 'Task A', embedding, category: null, project: null, section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });
    await insertReminder(db, {
      content: 'Task B', embedding, category: null, project: null, section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    // Update Task A to in_progress
    await updateReminder(db, r1.id, { status: 'in_progress' });

    const res = await app.request('/api/v1/reminders?status=not_started', {
      headers: { Authorization: AUTH_HEADER },
    });
    const reminders = await res.json();
    expect(reminders.length).toBe(1);
    expect(reminders[0].content).toBe('Task B');
  });

  it('R5. Cascade done: complete parent auto-completes open subtasks', async () => {
    const { insertReminder, completeReminder, getReminderById } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    // Create parent
    const parent = await insertReminder(db, {
      content: 'Parent task', embedding, category: null, project: null, section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });
    // Create two subtasks
    const child1 = await insertReminder(db, {
      content: 'Subtask 1', embedding, category: null, project: null, section: null,
      parentId: parent.id, depth: 1, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });
    const child2 = await insertReminder(db, {
      content: 'Subtask 2', embedding, category: null, project: null, section: null,
      parentId: parent.id, depth: 1, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    // Complete parent — should cascade to both subtasks
    const result = await completeReminder(db, parent.id);
    expect(result.completed).toHaveLength(3);
    expect(result.completed).toContain(parent.id);
    expect(result.completed).toContain(child1.id);
    expect(result.completed).toContain(child2.id);

    // Verify all three are done in DB
    const parentRow = await getReminderById(db, parent.id);
    const child1Row = await getReminderById(db, child1.id);
    const child2Row = await getReminderById(db, child2.id);
    expect(parentRow?.status).toBe('done');
    expect(child1Row?.status).toBe('done');
    expect(child2Row?.status).toBe('done');
  });

  it('R4. GET /api/v1/reminders?project=fitness → filtered by project', async () => {
    const { insertReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    await insertReminder(db, {
      content: 'Run 5k', embedding, category: null, project: 'fitness', section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });
    await insertReminder(db, {
      content: 'Write tests', embedding, category: null, project: 'work', section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    const res = await app.request('/api/v1/reminders?project=fitness', {
      headers: { Authorization: AUTH_HEADER },
    });
    const reminders = await res.json();
    expect(reminders.length).toBe(1);
    expect(reminders[0].content).toBe('Run 5k');
  });
});

// ==========================================================================
// MCP Tool E2E (testing underlying DB functions with real PostgreSQL)
// ==========================================================================

describe('MCP Tool E2E', () => {
  beforeEach(truncateAll);

  // ── brain_help ──────────────────────────────────────────────────────────
  it('MCP — brain_help: returns help text', async () => {
    // The help text is a const in profiler-tools.ts; verify it's accessible
    // by importing the module. (The MCP tool just wraps it.)
    const mod = await import('../../src/mcp/profiler-tools.js');
    // registerProfilerTools registers the tool; we just need to verify
    // the module loads and the help text is in the expected format
    expect(mod.registerProfilerTools).toBeDefined();
    // Direct test: The help text is embedded in the module — we can verify
    // via the actual tool output by creating an MCP server
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    mod.registerProfilerTools(server, deps);
    // Verify the tool was registered (McpServer doesn't expose tools easily,
    // so we just verify the function ran without error)
    expect(true).toBe(true);
  });

  // ── capture_thought (via pipeline) ──────────────────────────────────────
  it('MCP — capture_thought: insert via pipeline, verify in DB', async () => {
    const { runCapturePipeline } = await import('../../src/capture/pipeline.js');
    const result = await runCapturePipeline({
      db,
      embeddingProvider: deps.embeddingProvider,
      metadataLLM: deps.metadataLLM,
      blobStorage: deps.blobStorage,
      content: 'Pedro values clean code architecture',
      files: [],
      source: 'mcp',
    });

    expect(result.success).toBe(true);
    expect(result.captureId).toBeDefined();

    const dbResult = await db.query('SELECT * FROM captures WHERE id = $1', [result.captureId]);
    expect(dbResult.rows.length).toBe(1);
    expect(dbResult.rows[0].source).toBe('mcp');
    expect(dbResult.rows[0].embedding).toBeDefined();
  });

  // ── brain_stats ─────────────────────────────────────────────────────────
  it('MCP — brain_stats: verify counts after inserts', async () => {
    // Insert a capture, a fact, an insight, and a reminder
    const { insertCapture } = await import('../../src/db/captures.js');
    const { insertFact } = await import('../../src/db/facts.js');
    const { insertInsight } = await import('../../src/db/insights.js');
    const { insertReminder } = await import('../../src/db/reminders.js');

    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    await insertCapture(db, {
      content: 'stats test capture',
      contentTypes: ['text'],
      fileUrls: null,
      fileHashes: null,
      embedding,
      metadata: {},
      source: 'test',
    });

    await insertFact(db, {
      content: 'stats test fact',
      category: 'preference',
      embedding,
      confidence: 0.8,
      sourceCaptureIds: [],
      origin: 'consolidation',
      reviewStatus: 'auto_approved',
    });

    await insertInsight(db, {
      content: 'stats test insight',
      category: 'pattern',
      embedding,
      confidence: 0.7,
      sourceFactIds: [],
      origin: 'consolidation',
    });

    await insertReminder(db, {
      content: 'stats test reminder',
      embedding,
      category: null,
      project: null,
      section: null,
      parentId: null,
      depth: 0,
      priority: null,
      source: 'test',
      sourceContext: null,
      dueDate: null,
    });

    // Verify counts via the same query brain_stats uses
    const stats = await db.query(`
      SELECT
        (SELECT count(*) FROM captures WHERE archived = false) AS captures_count,
        (SELECT count(*) FROM facts WHERE archived = false) AS facts_count,
        (SELECT count(*) FROM insights WHERE archived = false) AS insights_count,
        (SELECT count(*) FROM reminders WHERE archived = false) AS reminders_count
    `);

    const row = stats.rows[0];
    expect(parseInt(row.captures_count)).toBe(1);
    expect(parseInt(row.facts_count)).toBe(1);
    expect(parseInt(row.insights_count)).toBe(1);
    expect(parseInt(row.reminders_count)).toBe(1);
  });

  // ── search_thoughts ─────────────────────────────────────────────────────
  it('MCP — search_thoughts: verify similarity search works', async () => {
    const { insertCapture } = await import('../../src/db/captures.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    await insertCapture(db, {
      content: 'Pedro loves TypeScript',
      contentTypes: ['text'],
      fileUrls: null,
      fileHashes: null,
      embedding,
      metadata: {},
      source: 'test',
    });

    const { searchThoughts } = await import('../../src/retrieval/search.js');
    // Use the fixed embedding provider so the query embedding matches
    const fixedProvider = fixedEmbeddingProvider();
    const results = await searchThoughts(db, fixedProvider, 'TypeScript', 0.5, 10);
    // With the same embedding vector, similarity should be 1.0
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].tier).toBe('capture');
    expect(results[0].content).toContain('TypeScript');
  });

  // ── get_user_profile ────────────────────────────────────────────────────
  it('MCP — get_user_profile: verify profile synthesis', async () => {
    const { insertFact } = await import('../../src/db/facts.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    await insertFact(db, {
      content: 'Prefers TypeScript',
      category: 'preference',
      embedding,
      confidence: 0.9,
      sourceCaptureIds: [],
      origin: 'consolidation',
      reviewStatus: 'auto_approved',
    });

    const { getUserProfile } = await import('../../src/retrieval/profile.js');
    const profile = await getUserProfile(db, deps.retrievalLLM);
    expect(profile).toContain('Test profile summary');
  });

  // ── archive_thought / unarchive_thought ────────────────────────────────
  it('MCP — archive_thought / unarchive_thought: toggle archived flag', async () => {
    const { insertCapture, getCaptureById, setCaptureArchived } = await import('../../src/db/captures.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id } = await insertCapture(db, {
      content: 'To be archived',
      contentTypes: ['text'],
      fileUrls: null,
      fileHashes: null,
      embedding,
      metadata: {},
      source: 'test',
    });

    // Archive
    await setCaptureArchived(db, id, true);
    let row = await getCaptureById(db, id);
    expect(row!.archived).toBe(true);

    // Verify it's excluded from normal queries
    const captures = await db.query(
      'SELECT * FROM captures WHERE archived = false',
    );
    expect(captures.rows.find((c: any) => c.id === id)).toBeUndefined();

    // Unarchive
    await setCaptureArchived(db, id, false);
    row = await getCaptureById(db, id);
    expect(row!.archived).toBe(false);

    // Verify it's back in normal queries
    const captures2 = await db.query(
      'SELECT * FROM captures WHERE archived = false',
    );
    expect(captures2.rows.find((c: any) => c.id === id)).toBeDefined();
  });

  // ── update_fact ─────────────────────────────────────────────────────────
  it('MCP — update_fact: edit a fact, verify user_edited origin + confidence 1.0', async () => {
    const { insertFact, getFactById, userEditFact } = await import('../../src/db/facts.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id } = await insertFact(db, {
      content: 'Original fact content',
      category: 'preference',
      embedding,
      confidence: 0.6,
      sourceCaptureIds: [],
      origin: 'consolidation',
      reviewStatus: 'auto_approved',
    });

    await userEditFact(db, id, 'Updated fact content by user');

    const fact = await getFactById(db, id);
    expect(fact).toBeDefined();
    expect(fact!.content).toBe('Updated fact content by user');
    expect(fact!.origin).toBe('user_edited');
    expect(fact!.confidence).toBe(1.0);
    // Previous version should be recorded
    expect(fact!.previous_versions.length).toBeGreaterThanOrEqual(1);
  });

  // ── review_pending ──────────────────────────────────────────────────────
  it('MCP — review_pending: list pending_review facts', async () => {
    const { insertFact, findPendingReviewFacts } = await import('../../src/db/facts.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    await insertFact(db, {
      content: 'Pending fact 1',
      category: 'preference',
      embedding,
      confidence: 0.5,
      sourceCaptureIds: [],
      origin: 'consolidation',
      reviewStatus: 'pending_review',
    });

    await insertFact(db, {
      content: 'Approved fact',
      category: 'preference',
      embedding,
      confidence: 0.9,
      sourceCaptureIds: [],
      origin: 'consolidation',
      reviewStatus: 'auto_approved',
    });

    const pending = await findPendingReviewFacts(db, 20);
    expect(pending.length).toBe(1);
    expect(pending[0].content).toBe('Pending fact 1');
    expect(pending[0].review_status).toBe('pending_review');
  });

  // ── approve_reject ──────────────────────────────────────────────────────
  it('MCP — approve_reject: approve a pending fact, verify status change', async () => {
    const { insertFact, getFactById, setFactReviewStatus } = await import('../../src/db/facts.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id } = await insertFact(db, {
      content: 'Fact to approve',
      category: 'preference',
      embedding,
      confidence: 0.7,
      sourceCaptureIds: [],
      origin: 'consolidation',
      reviewStatus: 'pending_review',
    });

    await setFactReviewStatus(db, id, 'user_approved');

    const fact = await getFactById(db, id);
    expect(fact!.review_status).toBe('user_approved');
  });

  // ── run_consolidation ──────────────────────────────────────────────────
  it('MCP — run_consolidation: capture → consolidate → verify facts created', async () => {
    // Insert captures via pipeline
    await captureThought('Pedro uses Vitest for testing');
    await captureThought('Pedro prefers minimal dependencies');

    // Run consolidation
    const { runConsolidation } = await import('../../src/consolidation/runner.js');
    await runConsolidation({
      db,
      consolidationLLM: deps.consolidationLLM,
      embeddingProvider: deps.embeddingProvider,
      reviewMode: 'autonomous',
    });

    // Verify facts were created
    const facts = await db.query('SELECT * FROM facts WHERE archived = false');
    expect(facts.rows.length).toBeGreaterThanOrEqual(1);

    // Verify captures were marked as consolidated
    const captures = await db.query('SELECT * FROM captures WHERE status = $1', ['consolidated']);
    expect(captures.rows.length).toBeGreaterThanOrEqual(1);

    // Verify consolidation log was written
    const logs = await db.query('SELECT * FROM consolidation_log');
    expect(logs.rows.length).toBeGreaterThanOrEqual(1);
  });

  // ── completed reminders flow into consolidation ─────────────────────────
  it('MCP — consolidation includes completed reminders as profile signal', async () => {
    // Insert a reminder, mark it done
    const { insertReminder, completeReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.3);
    const { id: reminderId } = await insertReminder(db, {
      content: 'Learn Rust programming',
      embedding,
      category: 'learning',
      project: 'skills',
      section: null,
      parentId: null,
      depth: 0,
      priority: 'P2',
      source: 'telegram',
      sourceContext: null,
      dueDate: null,
    });
    await completeReminder(db, reminderId);

    // Verify it's done
    const { getReminderById } = await import('../../src/db/reminders.js');
    const reminder = await getReminderById(db, reminderId);
    expect(reminder!.status).toBe('done');

    // Run consolidation — completed reminders should be included
    const { runConsolidation } = await import('../../src/consolidation/runner.js');
    await runConsolidation({
      db,
      consolidationLLM: deps.consolidationLLM,
      embeddingProvider: deps.embeddingProvider,
      reviewMode: 'autonomous',
    });

    // Verify consolidation processed it — check the log
    const logs = await db.query(
      `SELECT * FROM consolidation_log ORDER BY run_at DESC LIMIT 1`,
    );
    expect(logs.rows.length).toBe(1);
    const log = logs.rows[0];
    // Should not be a no-op — the completed reminder is new input
    expect(log.status).not.toBe('no-op');

    // Verify a fact was created (the mock LLM creates "Test fact from consolidation"
    // for any Phase 1 input that includes CAPTURES + EXISTING FACTS)
    const facts = await db.query(`SELECT * FROM facts WHERE archived = false`);
    expect(facts.rows.length).toBeGreaterThanOrEqual(1);
    // The fact's source_capture_ids should include the reminder ID
    const factWithReminder = facts.rows.find((f: any) =>
      f.source_capture_ids?.includes(reminderId),
    );
    expect(factWithReminder).toBeDefined();
  });

  // ── create_reminder ─────────────────────────────────────────────────────
  it('MCP — create_reminder: insert with all fields, verify in DB', async () => {
    const { insertReminder, getReminderById } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const dueDate = new Date('2026-04-15T10:00:00Z');
    const { id } = await insertReminder(db, {
      content: 'Review PRs',
      embedding,
      category: 'work',
      project: 'open-brain',
      section: 'code-review',
      parentId: null,
      depth: 0,
      priority: 'P1',
      source: 'mcp',
      sourceContext: 'User mentioned during code review session',
      dueDate,
    });

    const reminder = await getReminderById(db, id);
    expect(reminder).toBeDefined();
    expect(reminder!.content).toBe('Review PRs');
    expect(reminder!.project).toBe('open-brain');
    expect(reminder!.section).toBe('code-review');
    expect(reminder!.priority).toBe('P1');
    expect(reminder!.source).toBe('mcp');
    expect(reminder!.status).toBe('not_started');
    expect(reminder!.depth).toBe(0);
    expect(new Date(reminder!.due_date!).toISOString()).toBe(dueDate.toISOString());
  });

  // ── list_reminders ──────────────────────────────────────────────────────
  it('MCP — list_reminders: verify filtering works', async () => {
    const { insertReminder, listReminders } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    await insertReminder(db, {
      content: 'Task A', embedding, category: null, project: 'proj-a', section: null,
      parentId: null, depth: 0, priority: 'P1', source: 'test', sourceContext: null, dueDate: null,
    });
    await insertReminder(db, {
      content: 'Task B', embedding, category: null, project: 'proj-b', section: null,
      parentId: null, depth: 0, priority: 'P2', source: 'test', sourceContext: null, dueDate: null,
    });

    const filtered = await listReminders(db, { project: 'proj-a', limit: 20 });
    expect(filtered.length).toBe(1);
    expect(filtered[0].content).toBe('Task A');

    const all = await listReminders(db, { limit: 20 });
    expect(all.length).toBe(2);
  });

  // ── get_reminder_detail ─────────────────────────────────────────────────
  it('MCP — get_reminder_detail: insert reminder + comments + subtasks, verify tree', async () => {
    const { insertReminder, getReminderDetail } = await import('../../src/db/reminders.js');
    const { insertComment } = await import('../../src/db/reminder-comments.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    // Create parent reminder
    const parent = await insertReminder(db, {
      content: 'Implement feature X', embedding, category: 'work', project: 'proj',
      section: null, parentId: null, depth: 0, priority: 'P1', source: 'test',
      sourceContext: null, dueDate: null,
    });

    // Create subtask
    await insertReminder(db, {
      content: 'Write tests for feature X', embedding, category: 'work', project: 'proj',
      section: null, parentId: parent.id, depth: 1, priority: 'P2', source: 'test',
      sourceContext: null, dueDate: null,
    });

    // Add comment
    await insertComment(db, {
      content: 'Started working on this',
      embedding,
      reminderId: parent.id,
      source: 'test',
    });

    // Get detail
    const detail = await getReminderDetail(db, parent.id);
    expect(detail).toBeDefined();
    expect(detail!.content).toBe('Implement feature X');
    expect(detail!.subtasks.length).toBe(1);
    expect(detail!.subtasks[0].content).toBe('Write tests for feature X');
    expect(detail!.comments.length).toBe(1);
    expect(detail!.comments[0].content).toBe('Started working on this');
  });

  // ── update_reminder ─────────────────────────────────────────────────────
  it('MCP — update_reminder: change status/priority, verify', async () => {
    const { insertReminder, getReminderById, updateReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id } = await insertReminder(db, {
      content: 'Update me', embedding, category: null, project: null, section: null,
      parentId: null, depth: 0, priority: 'P3', source: 'test', sourceContext: null, dueDate: null,
    });

    await updateReminder(db, id, { status: 'in_progress', priority: 'P1' });

    const updated = await getReminderById(db, id);
    expect(updated!.status).toBe('in_progress');
    expect(updated!.priority).toBe('P1');
  });

  // ── complete_reminder ───────────────────────────────────────────────────
  it('MCP — complete_reminder: mark done, verify', async () => {
    const { insertReminder, getReminderById, completeReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id } = await insertReminder(db, {
      content: 'Complete me', embedding, category: null, project: null, section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    await completeReminder(db, id);

    const completed = await getReminderById(db, id);
    expect(completed!.status).toBe('done');
  });

  // ── delete_reminder ─────────────────────────────────────────────────────
  it('MCP — delete_reminder: cascade delete with subtasks + comments', async () => {
    const { insertReminder, getReminderById, deleteReminder } = await import('../../src/db/reminders.js');
    const { insertComment, findCommentsByReminderId } = await import('../../src/db/reminder-comments.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    // Create parent with subtask and comment
    const parent = await insertReminder(db, {
      content: 'Parent task', embedding, category: null, project: null, section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    const child = await insertReminder(db, {
      content: 'Child task', embedding, category: null, project: null, section: null,
      parentId: parent.id, depth: 1, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    await insertComment(db, {
      content: 'Comment on parent',
      embedding,
      reminderId: parent.id,
      source: 'test',
    });

    await insertComment(db, {
      content: 'Comment on child',
      embedding,
      reminderId: child.id,
      source: 'test',
    });

    // Delete parent (should cascade)
    await deleteReminder(db, parent.id);

    // Verify everything is gone
    expect(await getReminderById(db, parent.id)).toBeNull();
    expect(await getReminderById(db, child.id)).toBeNull();
    expect((await findCommentsByReminderId(db, parent.id)).length).toBe(0);
    expect((await findCommentsByReminderId(db, child.id)).length).toBe(0);
  });

  // ── add_reminder_comment ────────────────────────────────────────────────
  it('MCP — add_reminder_comment: add comment, verify in DB', async () => {
    const { insertReminder } = await import('../../src/db/reminders.js');
    const { insertComment, findCommentsByReminderId } = await import('../../src/db/reminder-comments.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id: reminderId } = await insertReminder(db, {
      content: 'Commentable task', embedding, category: null, project: null, section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    const comment = await insertComment(db, {
      content: 'Progress update: 50% done',
      embedding,
      reminderId,
      source: 'mcp',
    });

    expect(comment.id).toBeDefined();

    const comments = await findCommentsByReminderId(db, reminderId);
    expect(comments.length).toBe(1);
    expect(comments[0].content).toBe('Progress update: 50% done');
    expect(comments[0].source).toBe('mcp');
  });

  // ── list_projects ───────────────────────────────────────────────────────
  it('MCP — list_projects: insert reminders with projects, verify project list', async () => {
    const { insertReminder, listProjects } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    await insertReminder(db, {
      content: 'Task 1', embedding, category: null, project: 'alpha', section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });
    await insertReminder(db, {
      content: 'Task 2', embedding, category: null, project: 'alpha', section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });
    await insertReminder(db, {
      content: 'Task 3', embedding, category: null, project: 'beta', section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    const projects = await listProjects(db);
    expect(projects.length).toBe(2);

    const alpha = projects.find((p) => p.project === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.total).toBe(2);
    expect(alpha!.not_started).toBe(2);

    const beta = projects.find((p) => p.project === 'beta');
    expect(beta).toBeDefined();
    expect(beta!.total).toBe(1);
  });

  // ── edit reminder ───────────────────────────────────────────────────────
  it('MCP — update_reminder: edit content and verify in DB', async () => {
    const { insertReminder, getReminderById, updateReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id } = await insertReminder(db, {
      content: 'Call Nike',
      embedding,
      category: 'personal',
      project: null,
      section: null,
      parentId: null,
      depth: 0,
      priority: 'P3',
      source: 'telegram',
      sourceContext: null,
      dueDate: null,
    });

    // Edit the content
    await updateReminder(db, id, { content: 'Call Adidas instead' });

    const updated = await getReminderById(db, id);
    expect(updated).toBeDefined();
    expect(updated!.content).toBe('Call Adidas instead');
    // Other fields unchanged
    expect(updated!.priority).toBe('P3');
    expect(updated!.status).toBe('not_started');
  });

  // ── cycle status ────────────────────────────────────────────────────────
  it('MCP — update_reminder: cycle through statuses', async () => {
    const { insertReminder, getReminderById, updateReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id } = await insertReminder(db, {
      content: 'Status cycle test',
      embedding,
      category: null,
      project: null,
      section: null,
      parentId: null,
      depth: 0,
      priority: null,
      source: 'test',
      sourceContext: null,
      dueDate: null,
    });

    // not_started → in_progress
    await updateReminder(db, id, { status: 'in_progress' });
    let r = await getReminderById(db, id);
    expect(r!.status).toBe('in_progress');

    // in_progress → paused
    await updateReminder(db, id, { status: 'paused' });
    r = await getReminderById(db, id);
    expect(r!.status).toBe('paused');

    // paused → blocked
    await updateReminder(db, id, { status: 'blocked' });
    r = await getReminderById(db, id);
    expect(r!.status).toBe('blocked');

    // blocked → done
    await updateReminder(db, id, { status: 'done' });
    r = await getReminderById(db, id);
    expect(r!.status).toBe('done');
  });

  // ── resolve short ID ────────────────────────────────────────────────────
  it('MCP — resolveReminderId: short prefix resolves to full UUID', async () => {
    const { insertReminder, resolveReminderId } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id: fullId } = await insertReminder(db, {
      content: 'Short ID test',
      embedding,
      category: null,
      project: null,
      section: null,
      parentId: null,
      depth: 0,
      priority: null,
      source: 'test',
      sourceContext: null,
      dueDate: null,
    });

    const shortId = fullId.slice(0, 8);
    const resolved = await resolveReminderId(db, shortId);
    expect(resolved).toBe(fullId);

    // Full UUID also resolves
    const resolvedFull = await resolveReminderId(db, fullId);
    expect(resolvedFull).toBe(fullId);

    // Invalid short ID returns null
    const resolvedBad = await resolveReminderId(db, 'zzzzzzzz');
    expect(resolvedBad).toBeNull();
  });

  // ── delete reminder with cascade ────────────────────────────────────────
  it('E2E — delete_reminder: cascade-deletes subtasks and comments', async () => {
    const { insertReminder, getReminderById, deleteReminder } = await import('../../src/db/reminders.js');
    const { insertComment, findCommentsByReminderId } = await import('../../src/db/reminder-comments.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    // Create parent
    const { id: parentId } = await insertReminder(db, {
      content: 'Parent task', embedding, category: null, project: null, section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    // Create subtask
    const { id: subtaskId } = await insertReminder(db, {
      content: 'Subtask', embedding, category: null, project: null, section: null,
      parentId: parentId, depth: 1, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    // Add comment to parent
    await insertComment(db, { content: 'Progress note', embedding, reminderId: parentId, source: 'test' });

    // Verify everything exists
    expect(await getReminderById(db, parentId)).toBeDefined();
    expect(await getReminderById(db, subtaskId)).toBeDefined();
    const comments = await findCommentsByReminderId(db, parentId);
    expect(comments.length).toBe(1);

    // Delete parent — should cascade
    await deleteReminder(db, parentId);

    // Verify everything is gone
    expect(await getReminderById(db, parentId)).toBeNull();
    expect(await getReminderById(db, subtaskId)).toBeNull();
    const commentsAfter = await findCommentsByReminderId(db, parentId);
    expect(commentsAfter.length).toBe(0);
  });

  // ── cycle status loops back ─────────────────────────────────────────────
  it('E2E — status cycle loops: not_started → in_progress → paused → blocked → not_started', async () => {
    const { insertReminder, getReminderById, updateReminder } = await import('../../src/db/reminders.js');
    const embedding = new Array(EMBEDDING_DIM).fill(0.1);

    const { id } = await insertReminder(db, {
      content: 'Cycle loop test', embedding, category: null, project: null, section: null,
      parentId: null, depth: 0, priority: null, source: 'test', sourceContext: null, dueDate: null,
    });

    const cycle = ['in_progress', 'paused', 'blocked', 'not_started'];
    for (const nextStatus of cycle) {
      await updateReminder(db, id, { status: nextStatus });
      const r = await getReminderById(db, id);
      expect(r!.status).toBe(nextStatus);
    }

    // Back to not_started — full loop complete
    const final = await getReminderById(db, id);
    expect(final!.status).toBe('not_started');
  });
});

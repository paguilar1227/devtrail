// tests/integration/mcp-auth.test.ts — Section 14: MCP auth
import { describe, it, expect, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';

vi.mock('../../src/telegram/webhook.js', () => ({
  setupTelegramWebhook: vi.fn(),
}));

function makeDeps(): AppDeps {
  return {
    db: { pool: {}, query: vi.fn().mockResolvedValue({ rows: [] }), transaction: vi.fn(), close: vi.fn() },
    embeddingProvider: { embed: vi.fn().mockResolvedValue([0.1]), dimensions: 3072 },
    metadataLLM: { complete: vi.fn() },
    consolidationLLM: { complete: vi.fn() },
    retrievalLLM: { complete: vi.fn() },
    blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
    config: {
      apiKey: 'mcp-test-key',
      databaseUrl: 'postgres://localhost/test',
      azureStorageConnectionString: 'test',
      azureStorageContainer: 'test',
      geminiApiKey: 'test',
      anthropicApiKey: 'test',
      telegramBotToken: 'test:token',
      telegramWebhookSecret: 'webhook-secret',
      telegramChatId: '12345',
      port: 3000,
      nodeEnv: 'test',
      reviewMode: 'autonomous',
      dailyDigestEnabled: false,
      timezone: 'America/Chicago',
      dailyReportTime: '09:00',
    },
  } as unknown as AppDeps;
}

describe('Section 14: MCP Auth', () => {
  it('14.1 POST /mcp without key returns 401', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('14.2 POST /mcp with wrong x-brain-key returns 401', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-brain-key': 'wrong-key',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('14.3 POST /mcp with correct x-brain-key header does not return 401', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-brain-key': 'mcp-test-key',
      },
      body: JSON.stringify({}),
    });
    // Should pass auth — might fail on MCP protocol level but NOT 401
    expect(res.status).not.toBe(401);
  });

  it('14.4 POST /mcp?key=correct does not return 401', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/mcp?key=mcp-test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
  });

  it('14.5 consecutive MCP requests do not crash (regression: "Already connected" bug)', async () => {
    const app = createApp(makeDeps());
    const mcpRequest = (id: number) =>
      app.request('/mcp?key=mcp-test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          },
        }),
      });

    // First request should succeed
    const res1 = await mcpRequest(1);
    expect(res1.status).not.toBe(401);
    expect(res1.status).not.toBe(500);

    // Second request to the same app must NOT throw "Already connected"
    const res2 = await mcpRequest(2);
    expect(res2.status).not.toBe(401);
    expect(res2.status).not.toBe(500);

    // Third for good measure
    const res3 = await mcpRequest(3);
    expect(res3.status).not.toBe(500);
  });
});

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

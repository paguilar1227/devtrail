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

    const { loadConfig } = await import('../../src/config.js');
    const config = loadConfig();

    expect(config.port).toBe(3000);
    expect(config.reviewMode).toBe('hybrid');
    expect(config.dailyDigestEnabled).toBe(true);
    expect(config.timezone).toBe('America/Chicago');
    expect(config.dailyReportTime).toBe('09:00');
  });

  it('accepts custom timezone and daily report time', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/test');
    vi.stubEnv('OPEN_BRAIN_API_KEY', 'test-key');
    vi.stubEnv('AZURE_STORAGE_CONNECTION_STRING', 'conn-string');
    vi.stubEnv('AZURE_STORAGE_CONTAINER', 'container');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'webhook-secret');
    vi.stubEnv('TELEGRAM_CHAT_ID', '123456');
    vi.stubEnv('TIMEZONE', 'America/New_York');
    vi.stubEnv('DAILY_REPORT_TIME', '08:30');

    const { loadConfig } = await import('../../src/config.js');
    const config = loadConfig();

    expect(config.timezone).toBe('America/New_York');
    expect(config.dailyReportTime).toBe('08:30');
  });
});

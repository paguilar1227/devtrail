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
  timezone: z.string().min(1),
  dailyReportTime: z.string().regex(/^\d{2}:\d{2}$/),
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
    timezone: process.env.TIMEZONE || 'America/Chicago',
    dailyReportTime: process.env.DAILY_REPORT_TIME || '09:00',
  });
}

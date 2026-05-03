import { z } from 'zod';
import 'dotenv/config';

const configSchema = z.object({
  databaseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  azureStorageConnectionString: z.string().min(1),
  azureStorageContainer: z.string().min(1),
  geminiApiKey: z.string().min(1),
  anthropicApiKey: z.string().min(1),
  xaiApiKey: z.string().min(1),
  firecrawlApiKey: z.string().min(1),
  supadataApiKey: z.string().min(1),
  azureOpenAIEndpoint: z.string().min(1),
  azureOpenAIKey: z.string().min(1),
  azureRagDeployment: z.string().min(1),          // fast-path: chat completions (gpt-5-4)
  azureDeepRagDeployment: z.string().min(1),      // thorough-path: Responses API (gpt-5-4-pro)
  port: z.number().int().positive(),
  nodeEnv: z.enum(['development', 'production', 'test']),
  timezone: z.string().min(1),
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
    xaiApiKey: process.env.XAI_API_KEY,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
    supadataApiKey: process.env.SUPADATA_API_KEY,
    azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureOpenAIKey: process.env.AZURE_OPENAI_KEY,
    azureRagDeployment: process.env.AZURE_RAG_DEPLOYMENT || 'gpt-5-4',
    azureDeepRagDeployment: process.env.AZURE_DEEP_RAG_DEPLOYMENT || 'gpt-5-4-pro',
    port: Number(process.env.PORT || '3000'),
    nodeEnv: process.env.NODE_ENV || 'development',
    timezone: process.env.TIMEZONE || 'America/Chicago',
  });
}

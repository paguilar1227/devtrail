import { z } from 'zod';
import 'dotenv/config';

const configSchema = z.object({
  databaseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  azureStorageConnectionString: z.string().min(1),
  azureStorageContainer: z.string().min(1),
  geminiApiKey: z.string(),
  anthropicApiKey: z.string(),
  xaiApiKey: z.string(),
  firecrawlApiKey: z.string(),
  supadataApiKey: z.string(),
  azureOpenAIEndpoint: z.string(),
  azureOpenAIKey: z.string(),
  azureRagDeployment: z.string().min(1),          // fast-path: chat completions (gpt-5-4)
  azureDeepRagDeployment: z.string().min(1),      // thorough-path: Responses API (gpt-5-4-pro)
  port: z.number().int().positive(),
  nodeEnv: z.enum(['development', 'production', 'test']),
  timezone: z.string().min(1),
  // When 'stub', all LLM + embedding calls are routed to deterministic in-memory
  // fakes (see providers/stub.ts). Real upstream API keys are not required.
  llmProvider: z.enum(['real', 'stub']),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const llmProvider = (process.env.LLM_PROVIDER === 'stub' ? 'stub' : 'real') as 'real' | 'stub';
  // In stub mode, upstream API keys aren't called — fall back to placeholders
  // so the schema's .min(1) doesn't reject local dev .env files that omit them.
  const stubKey = '__stub__';
  const orStub = (v: string | undefined) => (llmProvider === 'stub' ? v ?? stubKey : v);

  return configSchema.parse({
    databaseUrl: process.env.DATABASE_URL,
    apiKey: process.env.DEVTRAIL_API_KEY,
    azureStorageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    azureStorageContainer: process.env.AZURE_STORAGE_CONTAINER,
    geminiApiKey: orStub(process.env.GEMINI_API_KEY),
    anthropicApiKey: orStub(process.env.ANTHROPIC_API_KEY),
    xaiApiKey: orStub(process.env.XAI_API_KEY),
    firecrawlApiKey: orStub(process.env.FIRECRAWL_API_KEY),
    supadataApiKey: orStub(process.env.SUPADATA_API_KEY),
    azureOpenAIEndpoint: orStub(process.env.AZURE_OPENAI_ENDPOINT),
    azureOpenAIKey: orStub(process.env.AZURE_OPENAI_KEY),
    azureRagDeployment: process.env.AZURE_RAG_DEPLOYMENT || 'gpt-5-4',
    azureDeepRagDeployment: process.env.AZURE_DEEP_RAG_DEPLOYMENT || 'gpt-5-4-pro',
    port: Number(process.env.PORT || '3000'),
    nodeEnv: process.env.NODE_ENV || 'development',
    timezone: process.env.TIMEZONE || 'America/Chicago',
    llmProvider,
  });
}

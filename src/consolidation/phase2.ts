import type { DbClient } from '../db/client.js';
import type { LLMProvider } from '../providers/types.js';

export interface Phase2Input {
  facts: Array<{ id: string; content: string; tags: string[]; confidence: number }>;
  existingInsights: Array<{ id: string; content: string; tags: string[]; confidence: number; source_fact_ids: string[] }>;
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
    .map((f) => `[${f.id}] (${f.tags.join(',')}, ${f.confidence}): ${f.content}`)
    .join('\n');

  const insightsText = input.existingInsights.length > 0
    ? input.existingInsights
        .map((i) => `[${i.id}] (${i.tags.join(',')}, ${i.confidence}, from: ${i.source_fact_ids.join(',')}): ${i.content}`)
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
          `INSERT INTO insights (content, tags, confidence, source_fact_ids, origin, review_status)
           VALUES ($1, $2, $3, $4, 'consolidation', 'pending_review')`,
          [insight.content, insight.tags ?? [], insight.confidence, insight.source_fact_ids],
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

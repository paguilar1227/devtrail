// src/retrieval/profile.ts
import type { DbClient } from '../db/client.js';
import type { LLMProvider } from '../providers/types.js';

const SYNTHESIS_PROMPT = `You are generating a concise profile summary for an AI assistant.
Given the person's insights, key facts, and current activities, produce a natural-language summary organized by tags.
Include what they're currently focused on (from active reminders).
Keep it concise but comprehensive — this will be used by other AI tools to quickly understand who this person is.
Write in third person.`;

export async function getUserProfile(db: DbClient, llm: LLMProvider): Promise<string> {
  // 1. Load approved insights
  const insightsResult = await db.query(
    `SELECT id, content, tags, confidence, source_fact_ids
     FROM insights
     WHERE review_status IN ('auto_approved', 'user_approved')
       AND archived = false
     ORDER BY confidence DESC`,
  );

  // 2. Load high-confidence facts not covered by any insight
  const coveredFactIds = insightsResult.rows
    .flatMap((i: any) => i.source_fact_ids ?? []);

  const uncoveredFactsResult = await db.query(
    `SELECT id, content, tags, confidence
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
    ? insights.map((i: any) => `- [${(i.tags ?? []).join(', ')}] ${i.content}`).join('\n')
    : 'None yet.';

  const factsText = facts.length > 0
    ? facts.map((f: any) => `- [${(f.tags ?? []).join(', ')}] ${f.content}`).join('\n')
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

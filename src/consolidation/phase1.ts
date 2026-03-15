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

const NOISE_CRITERIA_PROMPT = `You are a profile consolidation engine for a personal knowledge system. Your job is to extract profile facts about the user from their captured thoughts. You should be AGGRESSIVE about creating facts — this system exists to build a living profile, and every signal matters.

Given a cluster of captures and any existing facts, determine what new profile facts should be created or existing ones updated.

EXAMPLES of what SHOULD become facts:
- "I love TypeScript" → create_fact: "Prefers TypeScript" (category: preference, confidence: 0.7)
- "I am interested in healthy high-protein foods" → create_fact: "Interested in healthy high-protein foods" (category: preference, confidence: 0.7)
- "I love this style of pizza" → create_fact: "Enjoys pizza" (category: preference, confidence: 0.5)
- "Working on a new AI project" → create_fact: "Working on an AI project" (category: goal, confidence: 0.5)

NOISE CRITERIA — ONLY discard a capture if ALL of these are true:
1. Contains no preference, opinion, or value judgment
2. Contains no information about a person or relationship
3. Contains no habit, routine, or behavioral pattern
4. Contains no skill, tool, or technology association
5. Contains no goal, aspiration, or plan
6. Contains no emotional response or reaction
7. Is purely transactional with no recurring significance

Examples of ACTUAL noise: "test", "Hello", "ok", "query: show me all captures with file_urls" — these are operational messages with zero profile signal.

YOUR DEFAULT SHOULD BE TO CREATE A FACT. Only discard if a capture is truly meaningless noise. When in doubt, create a fact with low confidence (0.3-0.4). It is far worse to miss a real signal than to create a low-confidence fact that gets refined later.

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

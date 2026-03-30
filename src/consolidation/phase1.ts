import type { DbClient } from '../db/client.js';
import type { LLMProvider } from '../providers/types.js';
import type { FactRow } from '../db/facts.js';
import { validateTags, ALLOWED_TAGS, TAG_DESCRIPTIONS } from '../capture/tags.js';
import { extractJson } from '../providers/json-utils.js';

export interface ClusterInput {
  captures: Array<{ id: string; content: string; embedding: number[]; source?: string[]; tags?: string[] }>;
  existingFacts: Array<{ id: string; content: string; confidence: number; origin: string; tags: string[] }>;
  reviewMode: string;
}

export interface ClusterResult {
  factsCreated: number;
  factsUpdated: number;
  capturesProcessed: number;
  itemsFlagged: number;
  tokensUsed: number;
}

const TAG_ALLOWLIST_SECTION = `
ALLOWED TAGS (use ONLY these):
${ALLOWED_TAGS.map((t) => `- "${t}": ${TAG_DESCRIPTIONS[t]}`).join('\n')}
`;

const NOISE_CRITERIA_PROMPT = `You are a profile consolidation engine for a personal knowledge system. Your job is to extract profile facts about the user from their captured thoughts. You should be AGGRESSIVE about creating facts — this system exists to build a living profile, and every signal matters.

Given a cluster of captures and any existing facts, determine what new profile facts should be created or existing ones updated.

EXAMPLES of what SHOULD become facts:
- "I love TypeScript" → create_fact: "Prefers TypeScript" (tags: ["preference"], confidence: 0.7)
- "I am interested in healthy high-protein foods" → create_fact: "Interested in healthy high-protein foods" (tags: ["preference", "interest"], confidence: 0.7)
- "I love this style of pizza" → create_fact: "Enjoys pizza" (tags: ["interest"], confidence: 0.5)
- "Working on a new AI project" → create_fact: "Working on an AI project" (tags: ["goal"], confidence: 0.5)

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
${TAG_ALLOWLIST_SECTION}
For each capture cluster, return a JSON object with an "actions" array. Each action is one of:
- {"action": "create_fact", "content": "...", "tags": ["preference", "skill"], "confidence": 0.0-1.0, "source_capture_ids": ["..."]}
- {"action": "update_fact", "fact_id": "...", "content": "...", "confidence": 0.0-1.0, "reason": "..."}
- {"action": "flag_review", "fact_id": "...", "reason": "..."}
- {"action": "merge_facts", "keep_id": "...", "archive_id": "...", "merged_content": "...", "confidence": 0.0-1.0}
- {"action": "discard", "reason": "..."}

Note: "update_fact" does NOT include tags — tags are inherited from the existing fact.

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
        .map((f) => `[${f.id}] (tags: [${f.tags.join(', ')}], confidence: ${f.confidence}, origin: ${f.origin}): ${f.content}`)
        .join('\n')
    : 'No existing facts.';

  const prompt = `CAPTURES:\n${capturesText}\n\nEXISTING FACTS:\n${factsText}`;

  const response = await llm.complete(
    [{ role: 'user', content: prompt }],
    { systemPrompt: NOISE_CRITERIA_PROMPT, responseFormat: 'json', maxTokens: 4096 },
  );

  result.tokensUsed = response.tokensUsed.total;

  const captureIds = input.captures.map((c) => c.id.slice(0, 8)).join(', ');
  console.log(`[phase1] Cluster of ${input.captures.length} captures [${captureIds}], tokens used: ${response.tokensUsed.total}`);

  let actions: any[];
  try {
    const cleaned = extractJson(response.content);
    const parsed = JSON.parse(cleaned);
    actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    if (actions.length === 0) {
      console.warn(`[phase1] LLM returned 0 actions for cluster. Parsed keys: [${Object.keys(parsed).join(', ')}]. Raw response (first 500): ${response.content.slice(0, 500)}`);
    } else {
      const actionTypes = actions.map((a: any) => a.action);
      console.log(`[phase1] Actions: ${JSON.stringify(actionTypes)}`);
    }
  } catch (err) {
    console.error(`[phase1] JSON parse failed for cluster [${captureIds}]. Error: ${err}. Raw response (first 500): ${response.content.slice(0, 500)}`);
    actions = [];
  }

  // Compute source union across all captures in this cluster
  const factSource = [...new Set(input.captures.flatMap((c) => c.source ?? []))];

  // Process actions within a transaction (per-cluster commit)
  await db.transaction(async (txClient) => {
    for (const action of actions) {
      if (action.action === 'create_fact') {
        const actionTags = validateTags(action.tags ?? []);
        const reviewStatus = shouldAutoApprove(actionTags, input.reviewMode)
          ? 'auto_approved'
          : 'pending_review';

        await txClient.query(
          `INSERT INTO facts (content, tags, source, confidence, source_capture_ids, origin, review_status)
           VALUES ($1, $2, $3, $4, $5, 'consolidation', $6)`,
          [action.content, actionTags, factSource, action.confidence, action.source_capture_ids, reviewStatus],
        );
        result.factsCreated++;
        if (reviewStatus === 'pending_review') result.itemsFlagged++;

      } else if (action.action === 'update_fact') {
        // Check if the fact is user_edited
        const existingFact = input.existingFacts.find((f) => f.id === action.fact_id);
        if (existingFact?.origin === 'user_edited') {
          // Flag for review instead of updating — preserve existing tags
          await txClient.query(
            `INSERT INTO facts (content, tags, source, confidence, source_capture_ids, origin, review_status)
             VALUES ($1, $2, $3, $4, $5, 'consolidation', 'pending_review')`,
            [action.content, existingFact.tags, factSource, action.confidence,
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

    // Only mark captures as consolidated if we actually produced actions
    if (actions.length > 0) {
      for (const capture of input.captures) {
        await txClient.query(
          `UPDATE captures SET status = 'consolidated', updated_at = now() WHERE id = $1`,
          [capture.id],
        );
      }
    } else {
      console.warn(`[phase1] Leaving ${input.captures.length} captures as pending — no actions produced`);
    }
  });

  return result;
}

function shouldAutoApprove(tags: string[], reviewMode: string): boolean {
  if (reviewMode === 'autonomous') return true;
  if (reviewMode === 'ask') return false;
  // Hybrid mode: auto-approve low-impact tags
  const autoApproveTags = new Set(['preference', 'skill', 'interest', 'dislike', 'resource']);
  return tags.some((t) => autoApproveTags.has(t));
}

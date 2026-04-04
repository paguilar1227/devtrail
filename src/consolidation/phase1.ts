import type { DbClient } from '../db/client.js';
import type { LLMProvider } from '../providers/types.js';
import type { FactRow } from '../db/facts.js';
import { validateTags, ALLOWED_TAGS, TAG_DESCRIPTIONS } from '../capture/tags.js';
import { extractJson } from '../providers/json-utils.js';

export interface ClusterInput {
  captures: Array<{ id: string; content: string; embedding: number[]; source?: string[]; tags?: string[]; extracted_text?: string | null }>;
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

const NOISE_CRITERIA_PROMPT = `You are a profile consolidation engine for a personal knowledge system. Your job is to extract profile facts about the user from clusters of corroborating captured thoughts.

IMPORTANT: You are only given clusters of 2+ captures that are semantically related. Your job is to find the common signal across captures and distill it into facts. A fact should represent something corroborated by multiple captures, not a rephrasing of a single capture.

Given a cluster of captures and any existing facts, determine what new profile facts should be created or existing ones updated.

EXAMPLES of what SHOULD become facts (when corroborated by multiple captures):
- Two captures about TypeScript → create_fact: "Prefers TypeScript" (tags: ["preference"], confidence: 0.8)
- Captures about protein foods + fitness → create_fact: "Focused on high-protein nutrition for fitness goals" (tags: ["health", "goal"], confidence: 0.8)
- Multiple captures about Azure deployments → create_fact: "Experienced with Azure cloud infrastructure" (tags: ["skill"], confidence: 0.85)

CONFIDENCE GUIDELINES:
- 2 corroborating captures: 0.6-0.7
- 3-5 corroborating captures: 0.7-0.85
- 6+ corroborating captures: 0.85-0.95
- Corroborates an existing fact (update_fact): boost confidence by 0.05-0.1

Discard captures that are operational noise ("test", "Hello", "ok") or that don't contribute meaningful profile signal even in context of the cluster.

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
    .map((c) => {
      const parts = [`[${c.id}]: ${c.content}`];
      if (c.extracted_text) parts.push(`[Extracted from media]: ${c.extracted_text}`);
      return parts.join('\n');
    })
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
      try {
        if (action.action === 'create_fact') {
          const actionTags = validateTags(action.tags ?? []);
          const reviewStatus = shouldAutoApprove(actionTags, input.reviewMode)
            ? 'auto_approved'
            : 'pending_review';
          const captureIds = action.source_capture_ids ?? input.captures.map((c) => c.id);

          await txClient.query(
            `INSERT INTO facts (content, tags, source, confidence, source_capture_ids, origin, review_status)
             VALUES ($1, $2, $3::text[], $4, $5::uuid[], 'consolidation', $6)`,
            [String(action.content ?? ''), actionTags, factSource, Number(action.confidence ?? 0.5), captureIds, reviewStatus],
          );
          result.factsCreated++;
          if (reviewStatus === 'pending_review') result.itemsFlagged++;

        } else if (action.action === 'update_fact') {
          const existingFact = input.existingFacts.find((f) => f.id === action.fact_id);
          if (!existingFact) {
            console.warn(`[phase1] update_fact: fact_id ${action.fact_id} not found, skipping`);
            continue;
          }
          if (existingFact.origin === 'user_edited') {
            await txClient.query(
              `INSERT INTO facts (content, tags, source, confidence, source_capture_ids, origin, review_status)
               VALUES ($1, $2, $3::text[], $4, $5::uuid[], 'consolidation', 'pending_review')`,
              [String(action.content ?? ''), existingFact.tags, factSource, Number(action.confidence ?? 0.5),
               input.captures.map((c) => c.id)],
            );
            result.itemsFlagged++;
          } else {
            const confidenceShift = Math.abs(Number(action.confidence ?? 0.5) - existingFact.confidence);
            const reviewStatus = confidenceShift > 0.15 ? 'pending_review' : 'auto_approved';

            await txClient.query(
              `UPDATE facts SET
                 previous_versions = previous_versions || jsonb_build_array(
                   jsonb_build_object('content', content, 'confidence', confidence,
                                      'changed_at', now()::text, 'reason', $1::text)
                 ),
                 content = $2, confidence = $3, embedding = NULL, updated_at = now(),
                 review_status = $4
               WHERE id = $5`,
              [String(action.reason ?? ''), String(action.content ?? ''), Number(action.confidence ?? 0.5), reviewStatus, String(action.fact_id)],
            );
            result.factsUpdated++;
            if (reviewStatus === 'pending_review') result.itemsFlagged++;
          }

        } else if (action.action === 'flag_review') {
          await txClient.query(
            `UPDATE facts SET review_status = 'pending_review' WHERE id = $1`,
            [String(action.fact_id)],
          );
          result.itemsFlagged++;

        } else if (action.action === 'merge_facts') {
          await txClient.query(
            `UPDATE facts SET
               content = $1, confidence = $2,
               source_capture_ids = array_cat(
                 (SELECT source_capture_ids FROM facts WHERE id = $3),
                 (SELECT source_capture_ids FROM facts WHERE id = $4)
               ),
               embedding = NULL, updated_at = now()
             WHERE id = $3`,
            [String(action.merged_content ?? ''), Number(action.confidence ?? 0.5), String(action.keep_id), String(action.archive_id)],
          );
          await txClient.query(
            `UPDATE facts SET archived = true, updated_at = now() WHERE id = $1`,
            [String(action.archive_id)],
          );
        }
      } catch (err) {
        console.error(`[phase1] Action failed: ${JSON.stringify(action)}. Error: ${err}`);
        throw err;
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

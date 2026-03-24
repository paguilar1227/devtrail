// src/services/tags.ts
import type { ServiceDeps } from './index.js';
import { ALLOWED_TAGS, validateTags, isValidTag } from '../capture/tags.js';
import { getCaptureById, updateCaptureTags } from '../db/captures.js';
import { getFactById, updateFactTags } from '../db/facts.js';
import { getInsightById, updateInsightTags } from '../db/insights.js';

export type Tier = 'capture' | 'fact' | 'insight';

export interface UpdateTagsResult {
  old: string[];
  new: string[];
}

/**
 * Validate tags against allowlist, route to the correct DB update function.
 * Returns the old and new tag arrays.
 * Throws if any tag is invalid or the item is not found.
 */
export async function updateTags(
  deps: ServiceDeps,
  id: string,
  tier: Tier,
  tags: string[],
): Promise<UpdateTagsResult> {
  const invalidTags = tags.filter((t) => !isValidTag(t));
  if (invalidTags.length > 0) {
    throw new Error(`Invalid tags: ${invalidTags.join(', ')}. Allowed: ${ALLOWED_TAGS.join(', ')}`);
  }

  const validTags = validateTags(tags);

  if (tier === 'capture') {
    const existing = await getCaptureById(deps.db, id);
    if (!existing) {
      throw new Error(`Capture ${id} not found`);
    }
    await updateCaptureTags(deps.db, id, validTags);
    return { old: existing.tags, new: validTags };
  }

  if (tier === 'fact') {
    const existing = await getFactById(deps.db, id);
    if (!existing) {
      throw new Error(`Fact ${id} not found`);
    }
    await updateFactTags(deps.db, id, validTags);
    return { old: existing.tags, new: validTags };
  }

  // insight
  const existing = await getInsightById(deps.db, id);
  if (!existing) {
    throw new Error(`Insight ${id} not found`);
  }
  await updateInsightTags(deps.db, id, validTags);
  return { old: existing.tags, new: validTags };
}

/**
 * Return the full tag allowlist.
 */
export function getAllowedTags(): readonly string[] {
  return ALLOWED_TAGS;
}

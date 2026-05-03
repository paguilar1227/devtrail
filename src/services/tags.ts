import type { ServiceDeps } from './index.js';
import { listTags as dbListTags, type TagRow, type ListTagsFilters } from '../db/tags.js';

export type { TagRow, ListTagsFilters };

export async function listTags(deps: ServiceDeps, filters: ListTagsFilters = {}): Promise<TagRow[]> {
  return dbListTags(deps.db, filters);
}

// Tag inventory shaped for SearchInput's `#` typeahead. Shared by every
// search surface (home, drawers, project tabs) so the suggestion source
// is identical everywhere.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listTags } from './api';
import type { TagSuggestion } from '../components/SearchInput';

export function useTagSuggestions(opts: { project_id?: string; scope?: 'personal' | 'all' } = {}): TagSuggestion[] {
  const { data } = useQuery({
    queryKey: ['tags', opts.project_id ?? null, opts.scope ?? null],
    queryFn: () => listTags(opts),
  });
  return useMemo(() => (data ?? []).map((t) => ({ name: t.name, total: t.total })), [data]);
}
